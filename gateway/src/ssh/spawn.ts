import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Transform } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ClientChannel } from "ssh2";
import { psQuote, shQuote, type SshHost } from "./host.js";
import { nativePath } from "./location.js";
import { sftpWrite } from "./remote-ops.js";

/**
 * SDK 的 spawnClaudeCodeProcess：claude 在远端跑，标准输入输出走 SSH 通道。进程内的 MCP 服务器（终端、浏览器）、
 * 权限确认都在 stream-json 的控制协议里，照常由网关处理。
 * 环境变量只带 Claude Code 相关的（本机的 PATH、HOME 这些不能带过去），模型接口换成反向转发的地址和临时令牌
 */
const PASS_ENV = /^(ANTHROPIC_|CLAUDE_|DISABLE_|MCP_|MAX_THINKING_TOKENS$|MAX_MCP_OUTPUT_TOKENS$|API_TIMEOUT_MS$|BASH_DEFAULT_TIMEOUT_MS$|BASH_MAX_TIMEOUT_MS$|BASH_MAX_OUTPUT_LENGTH$)/;
const DROP_ENV = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CONFIG_DIR",
  // 本机 Windows 网关给自己的 claude 设的（config.ts 的 windowsBashEnv），是本机的路径；Windows 远端由网关另外设成远端的 bash-env.sh
  "CLAUDE_APP_USER_ENV_FILE",
  "CLAUDE_ENV_FILE",
  "CLAUDE_CODE_GIT_BASH_PATH",
  "CLAUDECODE",
  "CLAUDE_CODE_SSE_PORT",
]);

export function remoteSpawner(host: SshHost, onStderr: (data: string) => void): (o: SpawnOptions) => SpawnedProcess {
  return (o) => new RemoteProcess(host, o, onStderr);
}

class RemoteProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private channel: ClientChannel | null = null;
  private exited = false;

  constructor(private readonly host: SshHost, o: SpawnOptions, onStderr: (data: string) => void) {
    super();
    o.signal?.addEventListener("abort", () => this.kill("SIGTERM"), { once: true });
    void this.start(o, onStderr).catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.finish(1, null);
    });
  }

  private async start(o: SpawnOptions, onStderr: (data: string) => void): Promise<void> {
    await this.host.ensureReady();
    const env = this.host.env;
    if (!env || !this.host.proxyPort) throw new Error("SSH 连接还没准备好");
    const marker = `__CLAUDE_APP_READY_${randomBytes(8).toString("hex")}__`;
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env)) if (v !== undefined && PASS_ENV.test(k) && !DROP_ENV.has(k)) vars[k] = v;
    Object.assign(vars, {
      CLAUDE_CONFIG_DIR: nativePath(env.windows, env.configDir),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.host.proxyPort}`,
      ANTHROPIC_AUTH_TOKEN: this.host.proxyToken,
      // Windows 上会话的环境本来就是用户的（注册表里的 PATH），不用换；Git Bash 的位置和 CLAUDE_ENV_FILE（Git Bash 认 C:/… 的写法）见 deploy.ts
      ...(env.windows
        ? {
            ...(env.gitBash ? { CLAUDE_CODE_GIT_BASH_PATH: env.gitBash } : {}),
            ...(env.bashEnv ? { CLAUDE_ENV_FILE: nativePath(true, env.bashEnv).replaceAll("\\", "/") } : {}),
          }
        : { PATH: env.path }),
    });
    // Windows：配置经 SFTP 写成文件交给启动脚本，见 deploy.ts 的 LAUNCHER_PS；标准输入整个交给 claude
    const config = env.windows ? `${env.runDir}/${marker}.json` : null;
    if (config) {
      const json = JSON.stringify({ bin: nativePath(true, env.bin), marker, env: vars, cwd: nativePath(true, o.cwd ?? env.home), args: o.args.map(winArg).join(" ") });
      await sftpWrite(await this.host.sftp(), config, Buffer.from(json, "utf8"));
    }
    const header = config
      ? ""
      : [
          `CLAUDE_APP_BIN=${q(env.bin)}`,
          `CLAUDE_APP_MARKER=${q(marker)}`,
          ...Object.entries(vars).map(([k, v]) => `export ${k}=${q(v)}`),
          // 模型请求发到远端的 127.0.0.1，远端自己配了代理时不能走代理
          'export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"',
          `cd -- ${q(o.cwd ?? env.home)} || { echo ${q(`工作目录不存在：${o.cwd ?? ""}`)} >&2; exit 97; }`,
          ...o.args.map((a) => `set -- "$@" ${q(a)}`),
          "",
          "",
        ].join("\n");
    if (this.killed) return this.finish(null, "SIGTERM");
    const channel = await this.host.openExec(
      config ? `& ${psQuote(nativePath(true, env.launcher))} ${psQuote(nativePath(true, config))}` : `exec sh ${shQuote(env.launcher)}`,
    );
    this.channel = channel;
    channel.stderr.on("data", (d: Buffer) => onStderr(d.toString("utf8")));
    channel.on("exit", (code: number | null, signal?: string) => {
      this.exitCode = code;
      if (signal) this.signalCode = `SIG${signal}` as NodeJS.Signals;
    });
    channel.on("close", () => this.finish(this.exitCode, this.signalCode));
    channel.pipe(dropUntil(marker)).pipe(this.stdout);
    if (header) channel.write(header);
    this.stdin.pipe(channel);
    // SSH 断开时通道不一定发 close
    const off = this.host.onClose(() => this.finish(this.exitCode, this.signalCode ?? "SIGHUP"));
    this.once("exit", off);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.emit("exit", code, signal);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    const ch = this.channel;
    if (ch) {
      try {
        // OpenSSH 7.9 起支持给远端进程发信号；不支持的关通道，远端读到 EOF 也会退出
        ch.signal(signal.replace(/^SIG/, ""));
      } catch {
        // 通道已经关了
      }
      ch.end();
      ch.close();
    }
    return true;
  }
}

/** 单引号转义；值里的换行写成 "$N"（启动脚本里 N 是换行），每条语句占一行 */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`).replace(/\n/g, `'"$N"'`)}'`;

/** 一个参数按 Windows 命令行的规则引起来（CommandLineToArgvW：反斜杠只在引号前面才转义） */
function winArg(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const ch of a) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    out += "\\".repeat(ch === '"' ? slashes * 2 + 1 : slashes) + ch;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** 丢掉标记行（含）之前的输出 */
function dropUntil(marker: string): Transform {
  let pending: Buffer | null = Buffer.alloc(0);
  const mark = Buffer.from(`${marker}\n`);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!pending) return cb(null, chunk);
      pending = Buffer.concat([pending, chunk]);
      const i = pending.indexOf(mark);
      if (i === -1) {
        // 只留可能是标记开头的那一段
        if (pending.length > mark.length) pending = pending.subarray(pending.length - mark.length);
        return cb();
      }
      const rest = pending.subarray(i + mark.length);
      pending = null;
      cb(null, rest);
    },
  });
}
