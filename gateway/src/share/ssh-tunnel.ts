import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import ssh2, { type AnyAuthMethod, type AuthHandlerMiddleware, type ConnectConfig } from "ssh2";
import { getConnection } from "../ssh/connections.js";
import { connectOptions } from "../ssh/host.js";
import { hostKeyOf, knownHostsHas } from "../ssh/host-key.js";
import { existingHost } from "../ssh/hosts.js";
import { resolveTarget } from "../ssh/ssh-config.js";
import type { ShareTunnelState } from "../shared/types.js";
import { rememberFingerprint, type ShareServer } from "./share-settings.js";

/** 入口自检用的路径：分享入口直接回 ENTRY_ID，网关从外面访问公网地址，拿到的一样才算真的通了 */
export const ENTRY_CHECK_PATH = "/.well-known/claude-app-share";
/** 这个网关进程的标识 */
export const ENTRY_ID = randomBytes(12).toString("hex");

/** 等连上、开端口、自检最多等多久 */
const READY_TIMEOUT_MS = 25_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CHECK_TIMEOUT_MS = 8_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;
/** 连上过又断了：隔多久重连，逐次加长，一直重试到没有公网分享 */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

/** 链接里的主机：IPv6 加方括号 */
export function publicUrlOf(server: ShareServer): string {
  const host = server.publicHost || server.host;
  const bare = host.includes(":") && !host.startsWith("[") && !/^[^:]+:\d+$/.test(host) ? `[${host}]` : host;
  // 对外地址里自己写了端口（经 nginx 等转过的）就不再拼
  return /:\d+$/.test(bare) ? `http://${bare}` : `http://${bare}:${server.remotePort}`;
}

/**
 * 公网分享经自己的服务器（见 docs/lan-share.md「公网分享」）：SSH 登录服务器，在 0.0.0.0:<公网端口> 上开反向转发（同 ssh -R），
 * 进来的连接接到本机的分享入口（127.0.0.1:<localPort>）。连上后从外面访问一次公网地址，确认真的打得开。
 * 断线后自动重连，直到没有公网分享。
 */
export class SshShareTunnel {
  private client: ssh2.Client | null = null;
  private state: ShareTunnelState = { status: "off", url: null, error: null };
  private waiters = new Set<() => void>();
  private wanted = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  /** 这次连接记下的主机密钥指纹（测试连接时回给设置页） */
  fingerprint: string | null = null;

  constructor(
    private readonly localPort: () => number,
    private readonly server: () => ShareServer,
    private readonly log: FastifyBaseLogger,
  ) {}

  get view(): ShareTunnelState {
    return { ...this.state };
  }

  /** 按有没有公网分享连上、断开。上次没连上（error）时不自动重试，等 ensure() */
  sync(wanted: boolean): void {
    this.wanted = wanted;
    if (!wanted) return this.stop();
    if (!this.client && !this.retryTimer && this.state.status !== "error") this.start();
  }

  /** 开公网分享时：没连着就连（包括上次出错的），等到通了、出错或超时 */
  async ensure(): Promise<ShareTunnelState> {
    this.wanted = true;
    if (!this.client) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.start();
    }
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
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retries = 0;
    const client = this.client;
    this.client = null;
    if (client) {
      client.end();
      this.log.info("到服务器的 SSH 转发已断开（公网分享）");
    }
    this.set({ status: "off", url: null, error: null });
  }

  private set(next: ShareTunnelState): void {
    this.state = next;
    if (next.status !== "starting") for (const done of [...this.waiters]) done();
  }

  /** 这条连接出错、断了：记下原因；连上过的按退避重连 */
  private fail(client: ssh2.Client, message: string, wasReady: boolean): void {
    if (this.client !== client) return;
    this.client = null;
    client.end();
    this.log.error(message);
    this.set({ status: "error", url: null, error: message });
    if (!wasReady || !this.wanted) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.retries++, RETRY_DELAYS_MS.length - 1)]!;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.wanted && !this.client) this.start(true);
    }, delay);
  }

  private start(retrying = false): void {
    const server = this.server();
    if (!server.connectionId && (!server.host || !server.username)) {
      this.set({ status: "error", url: null, error: "设置里「公网分享」还没配置服务器" });
      return;
    }
    this.set({ status: "starting", url: null, error: null });
    const client = new ssh2.Client();
    this.client = client;
    // 用 SSH 连接时要先按 ~/.ssh/config 解析出地址、账号、密钥、跳板
    void dialOf(server).then(
      (dial) => {
        if (this.client === client) this.connect(client, server, dial, retrying);
      },
      (err: unknown) => this.fail(client, err instanceof Error ? err.message : String(err), false),
    );
  }

  private connect(client: ssh2.Client, server: ShareServer, dial: Dial, retrying: boolean): void {
    const url = publicUrlOf({ ...server, host: dial.host });
    const where = dial.where;
    this.log.info({ server: where, remotePort: server.remotePort }, "正在连服务器（公网分享）");
    let ready = false;
    let hostKeyError: string | null = null;

    client.on("error", (err) => {
      const level = (err as { level?: string }).level;
      const message =
        hostKeyError ??
        (level === "client-authentication"
          ? `登录不了 ${where}：${dial.authHint}`
          : level === "client-timeout"
            ? `连接 ${where} 超时`
            : `连不上 ${where}：${err.message}`);
      this.fail(client, message, ready);
    });
    client.on("close", () => this.fail(client, `到 ${where} 的 SSH 连接断开了`, ready));
    client.on("tcp connection", (details, accept, reject) => {
      if (details.destPort !== server.remotePort) return reject();
      const channel = accept();
      const local = net.connect(this.localPort(), "127.0.0.1");
      channel.pipe(local).pipe(channel);
      const destroy = () => {
        channel.destroy();
        local.destroy();
      };
      local.on("error", destroy);
      channel.on("error", destroy);
      local.on("close", destroy);
      channel.on("close", destroy);
    });
    client.on("ready", () => {
      if (this.client !== client) return;
      client.forwardIn("0.0.0.0", server.remotePort, (err) => {
        if (this.client !== client) return;
        if (err) return this.fail(client, `服务器上开不了端口 ${server.remotePort}（被占用，或者 sshd 不允许反向转发）：${err.message}`, false);
        void selfCheck(url).then((problem) => {
          if (this.client !== client) return;
          if (problem) return this.fail(client, problem, retrying);
          ready = true;
          this.retries = 0;
          this.log.info({ url }, "公网分享已挂到服务器上");
          this.set({ status: "ready", url, error: null });
        });
      });
    });

    const hostVerifier = (blob: Buffer, verify: (ok: boolean) => void) => {
      this.fingerprint = hostKeyOf(blob).fingerprint;
      void dial.verify(blob).then((problem) => {
        hostKeyError = problem;
        verify(!problem);
      });
    };
    try {
      client.connect(dial.config(hostVerifier));
    } catch (err) {
      this.fail(client, `连不上 ${where}：${(err as Error).message}`, false);
    }
  }
}

/** 怎么连服务器：手动填的，或者设置「SSH 连接」里的连接 */
interface Dial {
  /** 报错、日志里的「哪台」 */
  where: string;
  /** 拼链接用的主机（设置里没填「链接里的地址」时） */
  host: string;
  /** 登录失败时的说明 */
  authHint: string;
  /** 主机密钥对不对：对返回 null，不对返回原因 */
  verify(blob: Buffer): Promise<string | null>;
  config(hostVerifier: (blob: Buffer, verify: (ok: boolean) => void) => void): ConnectConfig;
}

async function dialOf(server: ShareServer): Promise<Dial> {
  if (server.connectionId) return connectionDial(server, server.connectionId);
  return {
    where: `${server.username}@${server.host}:${server.sshPort}`,
    host: server.host,
    authHint: "用户名、密码（或私钥）不对，或者服务器不接受这种登录方式",
    // 第一次连上时记下指纹，之后不一样就不连
    verify: async (blob) => {
      const { fingerprint } = hostKeyOf(blob);
      if (server.fingerprint && server.fingerprint !== fingerprint) {
        return `${server.host} 的主机密钥和第一次连接时记下的不一样（原来 ${server.fingerprint}，现在 ${fingerprint}），没有连接；确认是同一台服务器后在设置里点「重新记录」`;
      }
      if (!server.fingerprint) rememberFingerprint(server.host, server.sshPort, fingerprint);
      return null;
    },
    config: (hostVerifier) => ({
      host: server.host,
      port: server.sshPort,
      username: server.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      hostVerifier,
      authHandler: authMethods(server),
    }),
  };
}

/**
 * 用「SSH 连接」里的连接：地址、账号、密钥、ProxyJump 都按 ~/.ssh/config 和那边的配置（同 SshHost 的连接参数）；
 * 主机密钥要是那边信任过的，或者本机 known_hosts 里记着的。密码先用「公网分享」里填的，没填用这次在「SSH 连接」里输入的
 */
async function connectionDial(server: ShareServer, id: string): Promise<Dial> {
  const conn = getConnection(id);
  if (!conn) throw new Error("「公网分享」选的 SSH 连接不存在了（可能已经在设置里删掉了），重新选一个");
  const target = await resolveTarget(conn);
  const password = server.password || existingHost(id)?.sessionPassword;
  return {
    where: `「${conn.name}」（${target.user}@${target.hostname}:${target.port}）`,
    host: target.hostname,
    authHint: "密钥、ssh-agent 都登录不了，在设置「公网分享」里填密码，或者先在「SSH 连接」里输入密码连上",
    verify: async (blob) => {
      const key = hostKeyOf(blob);
      const trusted = getConnection(id)?.hostKey;
      if (trusted) {
        return trusted.fingerprint === key.fingerprint ? null : `「${conn.name}」的主机密钥和「SSH 连接」里信任的不一样（现在是 ${key.fingerprint}），没有连接；先在「SSH 连接」里重新连一次、确认指纹`;
      }
      if (await knownHostsHas(target.knownHostsFiles, target.hostKeyAlias ?? target.hostname, target.port, blob)) return null;
      return `还没信任「${conn.name}」的主机密钥：先在设置「SSH 连接」里连一次、确认指纹`;
    },
    config: (hostVerifier) => connectOptions(target, password, hostVerifier),
  };
}

/** 从外面访问一次公网地址的自检路径：回的是这个网关的入口才算通了；不通时返回原因 */
async function selfCheck(url: string): Promise<string | null> {
  const hint = "检查服务器的 sshd_config 里有没有 GatewayPorts clientspecified（或 yes，改完重启 sshd），以及防火墙、云服务器的安全组有没有放行这个端口";
  try {
    const res = await fetch(`${url}${ENTRY_CHECK_PATH}`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    if (body?.id === ENTRY_ID) return null;
    return `${url} 打开的不是这里的分享入口（HTTP ${res.status}），端口可能被服务器上别的程序占着`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = (err as Error).name === "TimeoutError" ? "超时" : (cause?.code ?? cause?.message ?? (err as Error).message);
    return `已经登录服务器、开了端口，但从外面打不开 ${url}（${reason}）。${hint}`;
  }
}

/** 认证顺序：设置里的私钥 → ssh-agent → 密码（密码登录和键盘交互都用它） */
function authMethods(server: ShareServer): AuthHandlerMiddleware {
  const username = server.username;
  const methods: AnyAuthMethod[] = [];
  if (server.identityFile) {
    try {
      // 设置页里可以写 ~/.ssh/…
      const file = server.identityFile.replace(/^~(?=$|[\\/])/, os.homedir());
      const key = readFileSync(path.resolve(file));
      if (!(ssh2.utils.parseKey(key) instanceof Error)) methods.push({ type: "publickey", username, key });
    } catch {
      // 读不了的跳过，靠后面的方式
    }
  }
  const agent = process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined);
  if (agent) methods.push({ type: "agent", username, agent });
  const password = server.password;
  if (password) {
    methods.push({ type: "password", username, password });
    methods.push({ type: "keyboard-interactive", username, prompt: (_n, _i, _l, prompts, finish) => finish(prompts.map(() => password)) });
  }
  let i = 0;
  return (left, _partial, next) => {
    while (i < methods.length) {
      const m = methods[i++]!;
      const kind = m.type === "agent" ? "publickey" : m.type;
      if (!left || left.includes(kind)) return next(m);
    }
    next(false as unknown as AnyAuthMethod);
  };
}

/**
 * 设置页「测试连接」：用填的配置连一次、开端口、自检，然后断开。本机的分享入口可能没在监听，
 * 进来的连接接到一个临时的本机服务上，它只回自检
 */
export async function probeServer(server: ShareServer, log: FastifyBaseLogger): Promise<{ state: ShareTunnelState; fingerprint: string | null }> {
  const stub = http.createServer((req, res) => {
    res.writeHead(req.url === ENTRY_CHECK_PATH ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === ENTRY_CHECK_PATH ? { id: ENTRY_ID } : { error: "not found" }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as net.AddressInfo).port;
  const tunnel = new SshShareTunnel(() => port, () => server, log);
  try {
    const state = await tunnel.ensure();
    return { state, fingerprint: tunnel.fingerprint };
  } finally {
    tunnel.stop();
    stub.closeAllConnections();
    stub.close();
  }
}
