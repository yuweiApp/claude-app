import { spawn, type ChildProcess } from "node:child_process";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { ShareTunnelState } from "../shared/types.js";

/** 等 ngrok 报出公网地址最多等多久 */
const READY_TIMEOUT_MS = 20_000;
/** 连上过的 ngrok 意外退出后，隔多久重新拉起（只重试一次，起不来就停在 error） */
const RESTART_DELAY_MS = 3_000;
/** 留多少 ngrok 的输出拼报错 */
const MAX_OUTPUT = 4096;

/**
 * 公网分享的 ngrok 隧道（见 docs/lan-share.md「公网分享」）：有公网分享时拉起
 * `ngrok http 127.0.0.1:<SHARE_TUNNEL_PORT>`，从它的 JSON 日志里读出公网地址；最后一个公网分享停掉、网关退出时结束它。
 * 用 ngrok 自己配好的 authtoken，网关不存。
 */
export class NgrokTunnel {
  private child: ChildProcess | null = null;
  private state: ShareTunnelState = { status: "off", url: null, error: null };
  /** 等着 ready / error 的 ensure() */
  private waiters = new Set<() => void>();
  private wanted = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly port: number,
    private readonly log: FastifyBaseLogger,
  ) {}

  get view(): ShareTunnelState {
    return { ...this.state };
  }

  /** 按有没有公网分享拉起、停掉。上次没起来（error）时不自动重试，等 ensure() */
  sync(wanted: boolean): void {
    this.wanted = wanted;
    if (!wanted) return this.stop();
    if (!this.child && this.state.status !== "error") this.start();
  }

  /** 开公网分享时：没在跑就拉起（包括上次出错的），等到拿到地址、出错或超时 */
  async ensure(): Promise<ShareTunnelState> {
    this.wanted = true;
    if (!this.child) this.start();
    if (this.state.status === "starting") {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, READY_TIMEOUT_MS);
        this.waiters.add(done);
      });
    }
    return this.view;
  }

  stop(): void {
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill();
      this.log.info("没有公网分享了，ngrok 已结束");
    }
    this.set({ status: "off", url: null, error: null });
  }

  private set(next: ShareTunnelState): void {
    this.state = next;
    if (next.status !== "starting") for (const done of [...this.waiters]) done();
  }

  private start(): void {
    clearTimeout(this.restartTimer);
    const args = ["http", `127.0.0.1:${this.port}`, "--log", "stdout", "--log-format", "json"];
    if (config.ngrokUrl) args.push("--url", config.ngrokUrl);
    this.set({ status: "starting", url: null, error: null });
    this.log.info({ ngrok: config.ngrokPath, args }, "正在拉起 ngrok（公网分享）");
    let child: ChildProcess;
    try {
      child = spawn(config.ngrokPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      this.set({ status: "error", url: null, error: `拉起 ngrok（${config.ngrokPath}）失败：${(err as Error).message}` });
      return;
    }
    this.child = child;
    // 网关异常退出时也带走 ngrok，免得留下一个连着公网的隧道
    const killOnExit = () => child.kill();
    process.once("exit", killOnExit);

    let output = "";
    /** ngrok 日志里最近一条 error / crit */
    let logError: string | null = null;
    let wasReady = false;
    const keep = (text: string) => {
      output = (output + text).slice(-MAX_OUTPUT);
    };

    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          keep(`${line}\n`);
          continue;
        }
        // 连上时的那条：{"lvl":"info","msg":"started tunnel","obj":"tunnels","addr":"http://127.0.0.1:8790","url":"https://….ngrok-free.app"}
        const url = typeof entry.url === "string" ? entry.url : null;
        const aboutTunnel = entry.msg === "started tunnel" || (typeof entry.obj === "string" && entry.obj.startsWith("tunnels"));
        if (url && aboutTunnel && /^https?:\/\//.test(url) && this.child === child) {
          wasReady = true;
          this.log.info({ url }, "ngrok 隧道已连上（公网分享）");
          this.set({ status: "ready", url: url.replace(/\/+$/, ""), error: null });
        }
        if (entry.lvl === "eror" || entry.lvl === "crit") {
          const err = typeof entry.err === "string" ? entry.err : typeof entry.msg === "string" ? entry.msg : null;
          if (err) logError = err;
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => keep(chunk));

    child.on("error", (err) => {
      process.removeListener("exit", killOnExit);
      if (this.child !== child) return;
      this.child = null;
      const message = (err as NodeJS.ErrnoException).code === "ENOENT" ? `找不到 ngrok（${config.ngrokPath}），装好后放进 PATH 或在 .env.local 里设 NGROK_PATH` : `拉起 ngrok 失败：${err.message}`;
      this.log.error({ err }, message);
      this.set({ status: "error", url: null, error: message });
    });

    child.on("exit", (code, signal) => {
      process.removeListener("exit", killOnExit);
      if (this.child !== child) return;
      this.child = null;
      const detail = errorText(output) ?? logError ?? `退出码 ${code ?? signal}`;
      const message = `ngrok 退出了：${detail}`;
      this.log.error({ code, signal, output }, message);
      this.set({ status: "error", url: null, error: message });
      // 连上过又退出（被结束、崩了）：还有公网分享就再拉起一次；一次都没连上（没登录、域名不对）不重试
      if (wasReady && this.wanted) this.restartTimer = setTimeout(() => this.wanted && !this.child && this.start(), RESTART_DELAY_MS);
    });
  }
}

/** ngrok 打在 stderr 上的报错（ERROR: 开头的几行，带 ERR_NGROK_xxx） */
function errorText(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errors = lines.filter((l) => l.startsWith("ERROR:")).map((l) => l.replace(/^ERROR:\s*/, ""));
  const text = (errors.length ? errors : lines).filter(Boolean).slice(0, 4).join(" ");
  return text || null;
}
