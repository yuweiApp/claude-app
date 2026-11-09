import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { config } from "../config.js";
import { clip, desktopLog } from "./log.js";

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
 * agent-desktop 的可执行文件。npm 包的 bin/ 里带全部平台的原生程序（agent-desktop-<平台>-<架构>，Windows 加 .exe），
 * 辅助程序（macOS 的 helper、Linux 的剪贴板）在旁边。bin/agent-desktop 本来是 Node 启动器（#! 开头）：
 * macOS、Linux 上 postinstall 把它换成本机原生程序的硬链接；Windows 上不换，只改 node_modules/.bin 里的 .cmd。
 * 所以先用本机平台的原生程序，没有时（不支持的平台）才用 Node 启动器。实测 Windows 上经启动器每次多一个 node 进程，
 * 网关带着调试参数时子进程还要等调试器连上，list-windows 一次要 1 秒多
 */
function resolveCommand(): { file: string; prefix: string[] } {
  const pkg = createRequire(import.meta.url).resolve("agent-desktop/package.json");
  const bin = path.join(path.dirname(pkg), "bin");
  const native = path.join(bin, `agent-desktop-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
  if (existsSync(native)) return { file: native, prefix: [] };
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

/** 这个会话的快照目录（删会话时删掉） */
export const sessionStateDir = (sessionId: string) => path.join(stateHome(), "sessions", sessionId);

/** 截图、snapshot 的结果可能很大（高分屏整屏 PNG 的 base64 有十几 MB） */
const MAX_BUFFER = 64 * 1024 * 1024;

/** 成功结果的 data 在日志里留多少字符（list-windows 二十来个窗口约 6000；快照可能几十 KB） */
const MAX_LOGGED_DATA = 8000;

/** 记一次调用：参数、耗时、退出码、原始结果（错误全留，含网关不交给模型的 suggestion、recovery） */
function logRun(args: string[], session: string | undefined, ms: number, err: Error | null, result: CliResult): void {
  const { envelope, stdout, stderr, killed } = result;
  desktopLog({
    kind: "cli",
    ...(session ? { session } : {}),
    args,
    ms,
    ...(err && "code" in err && err.code !== undefined ? { exitCode: err.code } : {}),
    ...(killed ? { killed } : {}),
    ...(envelope
      ? envelope.ok
        ? // 不叫 data：对话日志把名为 data 的长字符串当成 base64 省略掉
          { ok: true, output: clip(JSON.stringify(envelope.data ?? null), MAX_LOGGED_DATA) }
        : { ok: false, error: envelope.error }
      : { stdout: clip(stdout, 2000) }),
    ...(stderr.trim() ? { stderr: clip(stderr.trim(), 2000) } : {}),
  });
}

/**
 * 执行一条 agent-desktop 命令，每次一个进程（一次约 0.1 秒）。
 * session：快照命名空间（--session），网关的会话 id；headed：真实的鼠标键盘（--headed）
 */
export function runCli(
  args: string[],
  opts: { session?: string; headed?: boolean; timeoutMs: number; signal?: AbortSignal },
): Promise<CliResult> {
  command ??= resolveCommand();
  const cliArgs = [...args, ...(opts.session ? ["--session", opts.session] : []), ...(opts.headed ? ["--headed"] : [])];
  const full = [...command.prefix, ...cliArgs];
  const started = Date.now();
  return new Promise((resolve) => {
    let killed: CliResult["killed"];
    const child = execFile(
      command!.file,
      full,
      { env: { ...process.env, AGENT_DESKTOP_HOME: stateHome() }, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        let envelope: Envelope | undefined;
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && typeof parsed === "object" && "ok" in parsed) envelope = parsed as Envelope;
        } catch {
          // --help 等输出纯文字
        }
        logRun(cliArgs, opts.session, Date.now() - started, err, { envelope, stdout, stderr, killed });
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
