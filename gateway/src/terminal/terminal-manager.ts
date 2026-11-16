import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { IPty } from "@lydell/node-pty";
import type { TerminalEvent, TerminalInfo } from "../shared/types.js";
import { nativePath, parseRemote } from "../ssh/location.js";
import { applyProxyEnv } from "../net/proxy.js";
import { psEncoded, psQuote, shQuote } from "../ssh/host.js";
import { sshHost } from "../ssh/hosts.js";
import { newNonce, powershellPromptScript, PromptMarkParser } from "./prompt-marker.js";

/** 每个终端保留的输出（字符数），面板重新打开、刷新页面时用来还原屏幕 */
const SCROLLBACK_CHARS = 512 * 1024;
const MAX_TERMINALS = 16;
/** 新开的 PowerShell 终端等第一个提示符标记最多这么久（用户的 profile 慢）；等不到就当标记没生效 */
const FIRST_PROMPT_MS = 10_000;
/** 自动关闭的终端记给模型看，每个会话最多留这么多条 */
const MAX_CLOSED_NOTES = 20;

type PtyModule = typeof import("@lydell/node-pty");
let ptyModule: PtyModule | null = null;
/** 用到时才加载原生模块：平台的预编译包没装上时，网关照常启动，只有开终端报错 */
function pty(): PtyModule {
  ptyModule ??= createRequire(import.meta.url)("@lydell/node-pty") as PtyModule;
  return ptyModule;
}

/** 终端背后的进程：本机是 node-pty，远程会话是 SSH 上开的 pty 通道 */
interface Proc {
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /**
   * 问系统这个终端此刻的前台：shell 在不在前台（回到了提示符）、不在时前台程序的名字。
   * children：在提示符时再查 shell 下面有没有别的进程（放到后台的任务、停住的任务），查不出来是 undefined。
   * 查不了（Windows，靠提示符标记）、查失败时 undefined
   */
  probe(children: boolean): Promise<ProcProbe | undefined>;
}

interface ProcProbe {
  atPrompt: boolean;
  /** 不在提示符时前台程序的名字，拿不到是 null */
  running: string | null;
  children?: boolean;
}

/** 终端此刻的情况（TerminalManager.state） */
export interface TerminalState {
  /** true 回到了提示符，false 还有东西在跑，undefined 判断不出来 */
  idle: boolean | undefined;
  /** 在跑的程序的名字，拿不到时 null */
  running: string | null;
  /** 回到了提示符时，shell 下面有没有后台任务；查不出来是 undefined（只在 state(id, true) 时查） */
  children?: boolean;
}

interface Terminal extends TerminalInfo {
  proc: Proc;
  chunks: string[];
  chars: number;
  listeners: Set<(event: TerminalEvent) => void>;
  /** PowerShell 的终端：从输出里认提示符标记（prompt-marker.ts）；标记没生效时去掉 */
  marks?: PromptMarkParser;
  /** 按标记：true 回到了提示符，false 敲了命令还没回来；一个标记都没见过是 undefined */
  atPrompt?: boolean;
  /** 按标记：上一条命令的退出码 */
  lastExit?: number;
  /** 敲过几次回车（模型的、用户的）：一轮结束时问完系统再关之前，看这期间有没有又敲了命令 */
  enters: number;
  promptWaiters: Set<() => void>;
  /** 正在面板里显示着它的网页（终端的 WebSocket），有就是用户正在看 */
  viewers: Set<unknown>;
}

/** 模型开的终端被关掉了（不是它自己关的），记到这个会话下一次终端工具的结果里 */
export interface ClosedTerminal {
  id: string;
  title: string;
  /** turn-end：一轮结束时自动关的（里面的命令已经结束）；user：用户在面板里关的 */
  by: "turn-end" | "user";
  /** 知道时才有：shell 自己退出的退出码，或者上一条命令的（按标记） */
  exitCode?: number;
  /** 用户关的时候里面还有命令在跑（判断得出来时才有） */
  running?: true;
}

export class TerminalError extends Error {}

/** 右侧面板的终端：网关这台机器上的 pty，进程跟网页断开无关，关标签页或网关退出时才结束 */
export class TerminalManager {
  private terminals = new Map<string, Terminal>();
  /** 每个会话还在跑的终端工具调用数（包括转到后台的 read_terminal）：有的话一轮结束先不关终端 */
  private toolCalls = new Map<string, number>();
  /** 每个会话的模型开的终端里，自动关掉的、用户关掉的，还没告诉模型的 */
  private closedNotes = new Map<string, ClosedTerminal[]>();

  /** sessionId：只要这个会话的（加上不属于哪个会话的旧终端） */
  list(cwd?: string, sessionId?: string): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => (!cwd || t.cwd === cwd) && (!sessionId || !t.sessionId || t.sessionId === sessionId)).map(info);
  }

  /**
   * cwd 是 ssh://… 时在远端开（远端用户的登录 shell）；dir 是 shell 起始的目录，不传是 cwd（写法见 TerminalInfo.dir）；
   * sessionId：属于哪个会话（面板里开的是当前会话，模型开的是它所在的会话）
   */
  async create(
    cwd: string,
    cols: number,
    rows: number,
    opts: { title?: string; openedBy?: "user" | "agent"; dir?: string; sessionId?: string } = {},
  ): Promise<TerminalInfo> {
    if (this.terminals.size >= MAX_TERMINALS) throw new TerminalError(`终端最多开 ${MAX_TERMINALS} 个，先关掉一些`);
    const size = { cols: clamp(cols, 20, 500, 80), rows: clamp(rows, 5, 200, 24) };
    const nonce = newNonce();
    const { proc, shell, marked } = parseRemote(cwd) ? await remotePty(cwd, size, opts.dir, nonce) : localPty(opts.dir ?? cwd, size, nonce);
    const term: Terminal = {
      id: randomUUID(),
      cwd,
      ...(opts.dir ? { dir: opts.dir } : {}),
      shell: shell.split(/[\\/]/).pop() || shell,
      ...(opts.title ? { title: opts.title } : {}),
      openedBy: opts.openedBy ?? "user",
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      userTyped: false,
      status: "running",
      exitCode: null,
      createdAt: Date.now(),
      activeAt: Date.now(),
      proc,
      chunks: [],
      chars: 0,
      listeners: new Set(),
      ...(marked ? { marks: new PromptMarkParser(nonce) } : {}),
      promptWaiters: new Set(),
      viewers: new Set(),
      enters: 0,
    };
    proc.onData((data) => {
      term.activeAt = Date.now();
      for (const mark of term.marks?.feed(data) ?? []) {
        if (mark.kind === "D" && mark.exitCode !== undefined) term.lastExit = mark.exitCode;
        if (mark.kind !== "B") continue;
        term.atPrompt = true;
        term.promptWaiters.forEach((done) => done());
      }
      term.chunks.push(data);
      term.chars += data.length;
      while (term.chars > SCROLLBACK_CHARS && term.chunks.length > 1) term.chars -= term.chunks.shift()!.length;
      term.listeners.forEach((l) => l({ type: "data", data }));
    });
    proc.onExit((exitCode) => {
      term.status = "exited";
      term.exitCode = exitCode;
      term.promptWaiters.forEach((done) => done());
      term.listeners.forEach((l) => l({ type: "exit", code: exitCode }));
    });
    this.terminals.set(term.id, term);
    return info(term);
  }

  /** 先给已有的输出（还原屏幕），之后的输出、退出实时推给 listener */
  attach(id: string, listener: (event: TerminalEvent) => void): () => void {
    const term = this.get(id);
    listener({ type: "data", data: term.chunks.join("") });
    if (term.status === "exited") listener({ type: "exit", code: term.exitCode ?? 0 });
    term.listeners.add(listener);
    return () => term.listeners.delete(listener);
  }

  /**
   * from：用户在网页里敲的、模型写的命令，还是网页终端自动发的（焦点上报、对查询的回复）。
   * 只有 user 算用户敲过（用户敲过的终端模型不再往里写、不能停）
   */
  write(id: string, data: string, from: "user" | "agent" | "emulator"): void {
    const term = this.get(id);
    if (from === "user") term.userTyped = true;
    // 敲了回车：到下一个提示符标记之前算有命令在跑（标记生效了的终端才这么记）
    if (from !== "emulator" && /[\r\n]/.test(data)) {
      term.enters++;
      if (term.atPrompt !== undefined) {
        term.atPrompt = false;
        delete term.lastExit;
      }
    }
    if (term.status === "running") term.proc.write(data);
  }

  info(id: string): TerminalInfo {
    return info(this.get(id));
  }

  /**
   * 终端此刻的情况：里面的命令跑完了没有、在跑什么。
   * PowerShell 的终端看提示符标记；本机的 Unix 问系统前台进程组（node-pty），远端的 Unix 经 SSH 用 ps 问（remotePty）；
   * 标记没生效的、问不到的判断不出来。children：回到了提示符时再查 shell 下面有没有后台任务（Windows 查不了，按没有算）
   */
  async state(id: string, children = false): Promise<TerminalState> {
    const term = this.get(id);
    if (term.status !== "running") return { idle: true, running: null, children: false };
    if (term.atPrompt !== undefined) return { idle: term.atPrompt, running: null, children: false };
    if (term.marks) return { idle: undefined, running: null };
    const probe = await term.proc.probe(children).catch(() => undefined);
    if (!probe) return { idle: undefined, running: null };
    return probe.atPrompt ? { idle: true, running: null, ...(children ? { children: probe.children } : {}) } : { idle: false, running: probe.running };
  }

  /** 里面的命令跑完了没有：true 回到了提示符，false 还有东西在跑，undefined 判断不出来（见 state） */
  async idle(id: string): Promise<boolean | undefined> {
    return (await this.state(id)).idle;
  }

  /** 上一条命令的退出码：只有提示符标记生效了的终端（PowerShell）有，命令还在跑、还没跑过命令时没有 */
  lastExitCode(id: string): number | undefined {
    return this.get(id).lastExit;
  }

  /**
   * 新开的终端等到能敲命令：有提示符标记的等第一个标记（之后敲命令才分得清标记是命令之前还是之后的），
   * 等不到就当标记没生效、不再认（判断不出来，按 idle 的 undefined 处理）；没有标记的等 shell 的启动文件跑完、输出停下来
   */
  async waitReady(id: string): Promise<void> {
    const term = this.get(id);
    if (!term.marks) return this.waitForOutput(id, 3000, 300);
    if (term.atPrompt === undefined && term.status === "running") {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          term.promptWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, FIRST_PROMPT_MS);
        term.promptWaiters.add(done);
      });
    }
    if (term.atPrompt === undefined) delete term.marks;
  }

  /** 网页正在显示这个终端（面板开着、它是当前标签页）：viewer 是那条 WebSocket，断开时网页那边不用再说 */
  setViewing(id: string, viewer: unknown, on: boolean): void {
    const term = this.terminals.get(id);
    if (!term) return;
    if (on) term.viewers.add(viewer);
    else term.viewers.delete(viewer);
  }

  /** 这个会话有一次终端工具调用开始了；返回的函数在它结束时调用 */
  toolCallStarted(sessionId: string): () => void {
    this.toolCalls.set(sessionId, (this.toolCalls.get(sessionId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.toolCalls.get(sessionId) ?? 1) - 1;
      if (left > 0) this.toolCalls.set(sessionId, left);
      else this.toolCalls.delete(sessionId);
    };
  }

  /** 这个会话还有终端工具调用在跑（转到后台的 read_terminal）：一轮结束先不关它的终端 */
  busy(sessionId: string): boolean {
    return this.toolCalls.has(sessionId);
  }

  /**
   * 一轮结束：关掉这个会话里模型开的、命令已经结束的终端（回到了提示符、shell 下面没有后台任务，或者 shell 已经退出）。
   * 不关的：命令还在跑的、判断不出来的、用户在里面敲过东西的、用户这时正在面板里看着的。
   * 关掉的记下来，下一次终端工具的结果里告诉模型（takeClosed）
   */
  async turnEnded(sessionId: string): Promise<void> {
    for (const term of [...this.terminals.values()]) {
      if (term.sessionId !== sessionId || term.openedBy !== "agent" || term.userTyped || term.viewers.size) continue;
      const enters = term.enters;
      if (term.status === "running") {
        const st = await this.state(term.id, true);
        if (st.idle !== true || st.children !== false) continue;
      }
      // 问系统的这一会儿里（远端要一次网络往返）：被关掉了、用户敲了东西或切过来看了、又敲了命令
      if (this.terminals.get(term.id) !== term || term.userTyped || term.viewers.size || term.enters !== enters) continue;
      this.noteClosed(term, "turn-end");
      this.close(term.id);
    }
  }

  private noteClosed(term: Terminal, by: ClosedTerminal["by"], running = false): void {
    if (!term.sessionId) return;
    const exitCode = term.status === "exited" ? (term.exitCode ?? undefined) : term.lastExit;
    const notes = this.closedNotes.get(term.sessionId) ?? [];
    notes.push({ id: term.id, title: term.title ?? `终端（${term.shell}）`, by, ...(exitCode === undefined ? {} : { exitCode }), ...(running ? { running } : {}) });
    this.closedNotes.set(term.sessionId, notes.slice(-MAX_CLOSED_NOTES));
  }

  /** 取走（并清掉）这个会话的模型开的终端里，自动关掉的、用户关掉的，还没告诉模型的 */
  takeClosed(sessionId: string): ClosedTerminal[] {
    const notes = this.closedNotes.get(sessionId) ?? [];
    this.closedNotes.delete(sessionId);
    return notes;
  }

  /** 屏幕上的文字（去掉颜色等控制序列、按回车覆盖处理），最后 lines 行 */
  text(id: string, lines: number): { text: string; truncated: boolean } {
    const all = plainText(this.get(id).chunks.join("")).split("\n");
    while (all.length > 1 && all.at(-1) === "") all.pop();
    return { text: all.slice(-lines).join("\n"), truncated: all.length > lines };
  }

  /** 等到有新的输出、并且安静了 quietMs，或者到了 timeoutMs */
  waitForOutput(id: string, timeoutMs: number, quietMs = 400): Promise<void> {
    const term = this.get(id);
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(quiet);
        clearTimeout(deadline);
        term.listeners.delete(listener);
        resolve();
      };
      const listener = (event: TerminalEvent) => {
        if (event.type === "exit") return finish();
        clearTimeout(quiet);
        quiet = setTimeout(finish, quietMs);
      };
      const deadline = setTimeout(finish, timeoutMs);
      term.listeners.add(listener);
    });
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.get(id);
    if (term.status === "running") term.proc.resize(clamp(cols, 20, 500, 80), clamp(rows, 5, 200, 24));
  }

  /** 用户在面板里关的：模型开的终端记下来（关的时候里面还在不在跑），告诉开它的那个会话的模型 */
  async closeByUser(id: string): Promise<void> {
    const term = this.get(id);
    if (term.openedBy === "agent") {
      const running = (await this.state(id).catch(() => null))?.idle === false;
      // 问系统的这一会儿里已经被关掉了（一轮结束、模型关的）
      if (this.terminals.get(id) !== term) return;
      this.noteClosed(term, "user", running);
    }
    this.close(id);
  }

  /** 模型自己关的、一轮结束自动关的（后者在 turnEnded 里另外记） */
  close(id: string): void {
    const term = this.get(id);
    this.terminals.delete(id);
    term.listeners.clear();
    term.promptWaiters.forEach((done) => done());
    if (term.status === "running") term.proc.kill();
  }

  /** 会话删除了：关掉属于它的终端（模型开的、用户在它的面板里开的），不然会一直开着、哪个会话都看不到 */
  closeSession(sessionId: string): void {
    for (const term of [...this.terminals.values()]) if (term.sessionId === sessionId) this.close(term.id);
    this.closedNotes.delete(sessionId);
    this.toolCalls.delete(sessionId);
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  private get(id: string): Terminal {
    const term = this.terminals.get(id);
    if (!term) throw new TerminalError("终端不存在");
    return term;
  }
}

function info(t: Terminal): TerminalInfo {
  return {
    id: t.id,
    cwd: t.cwd,
    ...(t.dir ? { dir: t.dir } : {}),
    shell: t.shell,
    ...(t.title ? { title: t.title } : {}),
    openedBy: t.openedBy,
    ...(t.sessionId ? { sessionId: t.sessionId } : {}),
    userTyped: t.userTyped,
    status: t.status,
    exitCode: t.exitCode,
    createdAt: t.createdAt,
    activeAt: t.activeAt,
  };
}

/**
 * 终端输出转成纯文字（给模型读）：清屏之前的丢掉，去掉颜色、光标移动、窗口标题这些控制序列，
 * 行内的回车（进度条）和退格按覆盖处理。全屏程序（vim、top）画出来的不准
 */
export function plainText(raw: string): string {
  // 清屏（clear、Ctrl-L、ESC c）之后的才是屏幕上的
  const clears = [...raw.matchAll(/\x1b\[[23]J|\x1bc/g)];
  const last = clears.at(-1);
  let s = last ? raw.slice(last.index + last[0].length) : raw;
  s = s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC：窗口标题等
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI：颜色、光标
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "") // DCS 等
    .replace(/\x1b[()*+][0-9A-Za-z]/g, "")
    .replace(/\x1b[@-Z\\-_=>]/g, "");
  return s
    .split("\n")
    .map((line) => {
      const cells: string[] = [];
      let col = 0;
      for (const ch of line) {
        if (ch === "\r") col = 0;
        else if (ch === "\b") col = Math.max(0, col - 1);
        else if (ch === "\t") {
          const next = (Math.floor(col / 8) + 1) * 8;
          while (col < next) cells[col++] = " ";
        } else if (ch >= " " || ch > "\x7f") cells[col++] = ch;
      }
      return Array.from(cells, (c) => c ?? " ").join("").trimEnd();
    })
    .join("\n");
}

/** marked：这个终端的 shell 带了提示符标记（PowerShell，nonce 见 prompt-marker.ts） */
function localPty(cwd: string, size: { cols: number; rows: number }, nonce: string): { proc: Proc; shell: string; marked: boolean } {
  const windows = process.platform === "win32";
  const shell = windows ? "powershell.exe" : process.env.SHELL || "/bin/bash";
  // 设置页「网络代理」：HTTPS_PROXY、NO_PROXY 等同 claude 子进程（net/proxy.ts），只在终端打开时读，开着的终端不跟着变
  const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  applyProxyEnv(env);
  let p: IPty;
  try {
    // Windows：启动后先执行提示符标记的脚本（在用户的 profile 之后），-EncodedCommand 不用管引号
    p = pty().spawn(shell, windows ? ["-NoExit", "-EncodedCommand", psEncoded(powershellPromptScript(nonce))] : [], {
      name: "xterm-256color",
      ...size,
      cwd,
      env: env as Record<string, string>,
    });
  } catch (err) {
    throw new TerminalError(`终端启动失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    shell,
    marked: windows,
    proc: {
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit(({ exitCode }) => cb(exitCode)),
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      kill: () => {
        try {
          // Windows 上 node-pty 不支持传信号
          if (os.platform() === "win32") p.kill();
          else p.kill("SIGHUP");
        } catch {
          // 已经退出了
        }
      },
      // node-pty 在 Unix 上用 tcgetpgrp 取前台进程组的程序名（不准的是 Windows，那里靠提示符标记）；
      // 和 shell 同名就算 shell 自己在前台（可能是完整路径 /bin/bash，登录 shell 前面带 -）
      probe: async (children) => {
        if (windows) return undefined;
        let fg: string;
        try {
          fg = p.process ?? "";
        } catch {
          return undefined;
        }
        const name = programName(fg);
        if (name && name !== programName(shell)) return { atPrompt: false, running: name };
        if (!children) return { atPrompt: true, running: null };
        // pgrep -P：有子进程退出码 0，没有是 1；别的（没装 pgrep 等）是查不出来
        const code = await new Promise<unknown>((resolve) => execFile("pgrep", ["-P", String(p.pid)], { timeout: 3000 }, (err) => resolve(err ? (err as { code?: unknown }).code : 0)));
        return { atPrompt: true, running: null, ...(code === 0 ? { children: true } : code === 1 ? { children: false } : {}) };
      },
    },
  };
}

/**
 * 远端的终端：SSH 上开带 pty 的通道，在工作目录里起远端用户的登录 shell（Windows 是 PowerShell）。
 * 命令结束了没有：Windows 靠提示符标记；Unix 的 shell 启动前报出进程号，之后要判断时在同一条连接上另开一个通道用 ps 问（probeScript）
 */
async function remotePty(cwd: string, size: { cols: number; rows: number }, start: string | undefined, nonce: string): Promise<{ proc: Proc; shell: string; marked: boolean }> {
  const remote = parseRemote(cwd)!;
  const host = sshHost(remote.host);
  let channel;
  try {
    await host.ensureReady();
    const dir = start || remote.path || host.env!.home;
    const pty = { term: "xterm-256color", ...size };
    // Windows：交互的 PowerShell（-NoExit），先进工作目录，再加上提示符标记；-EncodedCommand 不经默认 shell（cmd）的转义
    channel = host.env!.windows
      ? await host.openRaw(
          `powershell.exe -NoLogo -NoExit -EncodedCommand ${psEncoded(`Set-Location -LiteralPath ${psQuote(nativePath(true, dir))}\n${powershellPromptScript(nonce)}`)}`,
          { pty },
        )
      : // Unix：exec 之前先报出进程号（exec 之后登录 shell 还是这个进程），见 SHELL_PID
        await host.openExec(
          `cd -- ${shQuote(dir)} 2>/dev/null; COLORTERM=truecolor; export COLORTERM; printf '\\033]633;P;ShellPid=%s;aid=${nonce}\\007' "$$"; exec "\${SHELL:-/bin/sh}" -l`,
          { pty },
        );
  } catch (err) {
    throw new TerminalError(`远端终端启动失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const decoder = new StringDecoder("utf8");
  const ch = channel;
  let exitCode = 0;
  // Unix：shell 的进程号，从输出开头认（SHELL_PID）；认到之前、或者开头的输出超过 PID_SCAN_CHARS 还没有（被别的东西吃掉了）就判断不出来
  let shellPid: number | undefined;
  let scanned = host.env!.windows ? null : "";
  const scan = (text: string) => {
    if (scanned === null) return;
    scanned += text;
    const m = SHELL_PID.exec(scanned);
    if (m && m[2] === nonce) shellPid = Number(m[1]);
    if (m || scanned.length > PID_SCAN_CHARS) scanned = null;
  };
  return {
    shell: host.env!.shell,
    marked: host.env!.windows,
    proc: {
      onData: (cb) => {
        ch.on("data", (d: Buffer) => {
          const text = decoder.write(d);
          scan(text);
          cb(text);
        });
        ch.stderr.on("data", (d: Buffer) => cb(d.toString("utf8")));
      },
      onExit: (cb) => {
        ch.on("exit", (code: number | null) => {
          exitCode = code ?? 0;
        });
        ch.on("close", () => cb(exitCode));
      },
      write: (d) => {
        ch.write(d);
      },
      resize: (c, r) => ch.setWindow(r, c, 0, 0),
      kill: () => {
        try {
          ch.signal("HUP");
        } catch {
          // 已经关了
        }
        ch.close();
      },
      probe: async (children) => {
        if (shellPid === undefined) return undefined;
        const r = await host.exec(probeScript(shellPid, children), { now: true, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
        return r?.code === 0 ? parseProbe(r.stdout.toString("utf8")) : undefined;
      },
    },
  };
}

/** 远端 Unix 的 shell 启动前报出的进程号：OSC 633（VS Code 的 shell 集成用的那组，P 是设属性），xterm.js 不认识就忽略，plainText 也去掉 */
const SHELL_PID = /\x1b\]633;P;ShellPid=(\d+);aid=([0-9a-f]+)\x07/;
/** 进程号应该在输出的最开头（登录 shell 的启动文件还没跑），开头这么多字符里没有就不再找 */
const PID_SCAN_CHARS = 4096;
/** 经 SSH 问一次前台最多等多久；连接断了、远端卡住时判断不出来 */
const PROBE_TIMEOUT_MS = 3000;

/** 程序名：去掉路径，登录 shell 前面的 - 也去掉 */
function programName(path: string): string {
  return path.split(/[\\/]/).pop()?.replace(/^-/, "") ?? "";
}

/**
 * 远端 Unix 上问 shell（pid）此刻是不是在前台：它的进程组和终端的前台进程组（tpgid）一样就是回到了提示符，
 * 不一样时前台进程组组长的程序名就是在跑的命令；children 时再用 pgrep -P 查 shell 下面有没有别的进程。
 * Linux（procps）和 macOS（BSD ps）都有 pgid、tpgid、comm；查不到（ps 不支持这些字段、进程没了）时退出码 3
 */
function probeScript(pid: number, children: boolean): string {
  return [
    `set -- $(ps -o pgid= -o tpgid= -p ${pid} 2>/dev/null)`,
    `[ $# -eq 2 ] || exit 3`,
    `if [ "$1" = "$2" ]; then`,
    children ? `  pgrep -P ${pid} >/dev/null 2>&1; echo "prompt $?"` : `  echo prompt`,
    `else`,
    `  echo "running $(ps -o comm= -p "$2" 2>/dev/null)"`,
    `fi`,
  ].join("\n");
}

/** probeScript 的输出：prompt [pgrep 的退出码：0 有子进程，1 没有，别的查不出来] 或 running <程序名> */
export function parseProbe(out: string): ProcProbe | undefined {
  const line = out.trim().split("\n").pop()?.trim() ?? "";
  if (line.startsWith("running")) return { atPrompt: false, running: programName(line.slice("running".length).trim()) || null };
  const m = /^prompt(?: (\d+))?$/.exec(line);
  if (!m) return undefined;
  return { atPrompt: true, running: null, ...(m[1] === "0" ? { children: true } : m[1] === "1" ? { children: false } : {}) };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}
