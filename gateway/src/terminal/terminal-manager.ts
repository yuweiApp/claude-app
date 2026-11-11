import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { IPty } from "@lydell/node-pty";
import type { TerminalEvent, TerminalInfo } from "../shared/types.js";
import { nativePath, parseRemote } from "../ssh/location.js";
import { psEncoded, psQuote, shQuote } from "../ssh/host.js";
import { sshHost } from "../ssh/hosts.js";

/** 每个终端保留的输出（字符数），面板重新打开、刷新页面时用来还原屏幕 */
const SCROLLBACK_CHARS = 512 * 1024;
const MAX_TERMINALS = 16;

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
  /** 前台进程组的程序名；拿不到时 undefined */
  foreground(): string | undefined;
}

interface Terminal extends TerminalInfo {
  proc: Proc;
  chunks: string[];
  chars: number;
  listeners: Set<(event: TerminalEvent) => void>;
}

export class TerminalError extends Error {}

/** 右侧面板的终端：网关这台机器上的 pty，进程跟网页断开无关，关标签页或网关退出时才结束 */
export class TerminalManager {
  private terminals = new Map<string, Terminal>();

  list(cwd?: string): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => !cwd || t.cwd === cwd).map(info);
  }

  /** cwd 是 ssh://… 时在远端开（远端用户的登录 shell） */
  async create(cwd: string, cols: number, rows: number, opts: { title?: string; openedBy?: "user" | "agent" } = {}): Promise<TerminalInfo> {
    if (this.terminals.size >= MAX_TERMINALS) throw new TerminalError(`终端最多开 ${MAX_TERMINALS} 个，先关掉一些`);
    const size = { cols: clamp(cols, 20, 500, 80), rows: clamp(rows, 5, 200, 24) };
    const { proc, shell } = parseRemote(cwd) ? await remotePty(cwd, size) : localPty(cwd, size);
    const term: Terminal = {
      id: randomUUID(),
      cwd,
      shell: shell.split(/[\\/]/).pop() || shell,
      ...(opts.title ? { title: opts.title } : {}),
      openedBy: opts.openedBy ?? "user",
      userTyped: false,
      status: "running",
      exitCode: null,
      createdAt: Date.now(),
      activeAt: Date.now(),
      proc,
      chunks: [],
      chars: 0,
      listeners: new Set(),
    };
    proc.onData((data) => {
      term.activeAt = Date.now();
      term.chunks.push(data);
      term.chars += data.length;
      while (term.chars > SCROLLBACK_CHARS && term.chunks.length > 1) term.chars -= term.chunks.shift()!.length;
      term.listeners.forEach((l) => l({ type: "data", data }));
    });
    proc.onExit((exitCode) => {
      term.status = "exited";
      term.exitCode = exitCode;
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
    if (term.status === "running") term.proc.write(data);
  }

  info(id: string): TerminalInfo {
    return info(this.get(id));
  }

  /**
   * 前台在跑的程序：shell 自己在前台说明回到了提示符（null）；拿不到时（Windows 上不准）是 undefined。
   * node-pty 在 Unix 上用 tcgetpgrp 取前台进程组的程序名
   */
  foreground(id: string): string | null | undefined {
    const term = this.get(id);
    if (term.status !== "running") return null;
    const fg = term.proc.foreground();
    if (fg === undefined) return undefined;
    // 可能是完整路径（/bin/bash），登录 shell 前面带 -
    const name = fg.split(/[\\/]/).pop()?.replace(/^-/, "") ?? "";
    return !name || name === term.shell ? null : name;
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

  close(id: string): void {
    const term = this.get(id);
    this.terminals.delete(id);
    term.listeners.clear();
    if (term.status === "running") term.proc.kill();
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
    shell: t.shell,
    ...(t.title ? { title: t.title } : {}),
    openedBy: t.openedBy,
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

function localPty(cwd: string, size: { cols: number; rows: number }): { proc: Proc; shell: string } {
  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash";
  let p: IPty;
  try {
    p = pty().spawn(shell, [], {
      name: "xterm-256color",
      ...size,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    });
  } catch (err) {
    throw new TerminalError(`终端启动失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    shell,
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
      // node-pty 在 Unix 上用 tcgetpgrp 取前台进程组的程序名，Windows 上不准
      foreground: () => {
        if (process.platform === "win32") return undefined;
        try {
          return p.process ?? "";
        } catch {
          return undefined;
        }
      },
    },
  };
}

/** 远端的终端：SSH 上开带 pty 的通道，在工作目录里起远端用户的登录 shell（Windows 是 PowerShell）。前台在跑什么拿不到 */
async function remotePty(cwd: string, size: { cols: number; rows: number }): Promise<{ proc: Proc; shell: string }> {
  const remote = parseRemote(cwd)!;
  const host = sshHost(remote.host);
  let channel;
  try {
    await host.ensureReady();
    const dir = remote.path || host.env!.home;
    const pty = { term: "xterm-256color", ...size };
    // Windows：交互的 PowerShell（-NoExit），先进工作目录；-EncodedCommand 不经默认 shell（cmd）的转义
    channel = host.env!.windows
      ? await host.openRaw(`powershell.exe -NoLogo -NoExit -EncodedCommand ${psEncoded(`Set-Location -LiteralPath ${psQuote(nativePath(true, dir))}`)}`, { pty })
      : await host.openExec(`cd -- ${shQuote(dir)} 2>/dev/null; COLORTERM=truecolor; export COLORTERM; exec "\${SHELL:-/bin/sh}" -l`, { pty });
  } catch (err) {
    throw new TerminalError(`远端终端启动失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const decoder = new StringDecoder("utf8");
  const ch = channel;
  let exitCode = 0;
  return {
    shell: host.env!.shell,
    proc: {
      onData: (cb) => {
        ch.on("data", (d: Buffer) => cb(decoder.write(d)));
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
      foreground: () => undefined,
    },
  };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}
