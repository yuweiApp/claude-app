import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { config } from "../config.js";

/** agent-desktop 每条命令输出的 JSON（schema 2.6） */
export interface Envelope {
  version: string;
  ok: boolean;
  command: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    disposition?: { delivery?: string; retry?: string };
    suggestion?: string;
    recovery?: unknown;
  };
}

export interface CliResult {
  /** 输出是 JSON 时解析好的结果；--help 等纯文字输出时没有 */
  envelope?: Envelope;
  stdout: string;
  stderr: string;
  /** 被网关终止：超过 timeout_ms，或 MCP 请求被中断 */
  killed?: "timeout" | "abort";
}

/**
 * agent-desktop 的可执行文件：npm 包的 postinstall 把本机的原生二进制放在 bin/agent-desktop（Windows 是 .exe），
 * 辅助程序（macOS 的 helper、Linux 的剪贴板）以原名放在旁边。没跑 postinstall 时 bin/agent-desktop 是 Node 启动器（#! 开头），
 * 用网关自己的 node 跑它
 */
function resolveCommand(): { file: string; prefix: string[] } {
  const pkg = createRequire(import.meta.url).resolve("agent-desktop/package.json");
  const bin = path.join(path.dirname(pkg), "bin");
  const exe = path.join(bin, "agent-desktop.exe");
  if (process.platform === "win32" && existsSync(exe)) return { file: exe, prefix: [] };
  const file = path.join(bin, "agent-desktop");
  const head = Buffer.alloc(2);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  return head.toString() === "#!" ? { file: process.execPath, prefix: [file] } : { file, prefix: [] };
}

let command: { file: string; prefix: string[] } | null = null;
let home: string | null = null;

/** 状态目录：权限必须是 700（否则 agent-desktop 报 INTERNAL），路径里不能有 ..，所以取真实路径 */
function stateHome(): string {
  if (!home) {
    mkdirSync(config.agentDesktopHome, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(config.agentDesktopHome, 0o700);
    home = realpathSync(config.agentDesktopHome);
  }
  return home;
}

/** 状态目录（AGENT_DESKTOP_HOME），网关自己的记录（cdp.ts 的 cdp-apps.json）也放这里 */
export const stateDir = () => stateHome();

/** 这个会话的快照目录（删会话时删掉） */
export const sessionStateDir = (sessionId: string) => path.join(stateHome(), "sessions", sessionId);

/** 截图、snapshot 的结果可能很大（高分屏整屏 PNG 的 base64 有十几 MB） */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 执行一条 agent-desktop 命令，每次一个进程（一次约 0.1 秒）。
 * session：快照命名空间（--session），网关的会话 id；headed：真实的鼠标键盘（--headed）
 */
export function runCli(
  args: string[],
  opts: { session?: string; headed?: boolean; timeoutMs: number; signal?: AbortSignal },
): Promise<CliResult> {
  command ??= resolveCommand();
  const full = [...command.prefix, ...args, ...(opts.session ? ["--session", opts.session] : []), ...(opts.headed ? ["--headed"] : [])];
  return new Promise((resolve) => {
    let killed: CliResult["killed"];
    const child = execFile(
      command!.file,
      full,
      { env: { ...process.env, AGENT_DESKTOP_HOME: stateHome() }, maxBuffer: MAX_BUFFER, windowsHide: true },
      (_err, stdout, stderr) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        let envelope: Envelope | undefined;
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && typeof parsed === "object" && "ok" in parsed) envelope = parsed as Envelope;
        } catch {
          // --help 等输出纯文字
        }
        resolve({ envelope, stdout, stderr, killed });
      },
    );
    const kill = (reason: "timeout" | "abort") => {
      killed ??= reason;
      child.kill();
    };
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
    const onAbort = () => kill("abort");
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
