import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import type { IPty } from "@lydell/node-pty";
import type { TerminalEvent, TerminalInfo } from "../shared/types.js";

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

interface Terminal extends TerminalInfo {
  proc: IPty;
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

  create(cwd: string, cols: number, rows: number, opts: { title?: string; openedBy?: "user" | "agent" } = {}): TerminalInfo {
    if (this.terminals.size >= MAX_TERMINALS) throw new TerminalError(`终端最多开 ${MAX_TERMINALS} 个，先关掉一些`);
    const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash";
    let proc: IPty;
    try {
      proc = pty().spawn(shell, [], {
        name: "xterm-256color",
        cols: clamp(cols, 20, 500, 80),
        rows: clamp(rows, 5, 200, 24),
        cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
      });
    } catch (err) {
      throw new TerminalError(`终端启动失败：${err instanceof Error ? err.message : String(err)}`);
    }
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
    proc.onExit(({ exitCode }) => {
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

  /** from：用户在网页里敲的，还是模型写的命令（用户敲过的终端模型不再往里写） */
  write(id: string, data: string, from: "user" | "agent" = "user"): void {
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
    if (process.platform === "win32") return undefined;
    try {
      // 可能是完整路径（/bin/bash），登录 shell 前面带 -
      const name = (term.proc.process ?? "").split(/[\\/]/).pop()?.replace(/^-/, "") ?? "";
      return !name || name === term.shell ? null : name;
    } catch {
      return undefined;
    }
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
    if (term.status === "running") kill(term.proc);
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

function kill(proc: IPty): void {
  try {
    // Windows 上 node-pty 不支持传信号
    if (os.platform() === "win32") proc.kill();
    else proc.kill("SIGHUP");
  } catch {
    // 已经退出了
  }
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}
