import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { FastifyBaseLogger } from "fastify";
import ssh2, { type ConnectConfig } from "ssh2";
import { getConnection } from "../ssh/connections.js";
import { collect, connectOptions, type ExecResult } from "../ssh/host.js";
import { hostKeyOf, knownHostsHas } from "../ssh/host-key.js";
import { existingHost } from "../ssh/hosts.js";
import { resolveTarget } from "../ssh/ssh-config.js";
import type { ShareFixResult, ShareTunnelState } from "../shared/types.js";
import type { ShareServer } from "./share-settings.js";

/** 入口自检用的路径：分享入口直接回 ENTRY_ID，网关从外面访问公网地址，拿到的一样才算真的通了 */
export const ENTRY_CHECK_PATH = "/.well-known/claude-app-share";
/** 这个网关进程的标识 */
export const ENTRY_ID = randomBytes(12).toString("hex");

/** 等连上、开端口、自检最多等多久 */
const READY_TIMEOUT_MS = 25_000;
const CHECK_TIMEOUT_MS = 8_000;
/** 连上过又断了：隔多久重连，逐次加长，一直重试到没有公网分享 */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
/** 服务器上的端口开不了时（上一条连接服务器还没发现断了、测试连接刚好占着）：隔多久再试、最多再试几次，期间状态一直是 starting */
const BIND_RETRY_MS = 2_000;
const BIND_RETRIES = 4;

/** 访客打开的地址：设置里的「链接里的地址」，没填用连接解析出的主机；IPv6 加方括号 */
export function publicUrlOf(server: ShareServer, sshHost: string): string {
  const host = server.publicHost || sshHost;
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
  /** 这一轮开端口失败后已经重试了几次 */
  private bindRetries = 0;
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
    if (!this.client && !(this.retryTimer && this.state.status === "starting")) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.bindRetries = 0;
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
    this.bindRetries = 0;
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
  private fail(client: ssh2.Client, message: string, wasReady: boolean, fix?: ShareTunnelState["fix"]): void {
    if (this.client !== client) return;
    this.client = null;
    client.end();
    this.log.error(message);
    this.set({ status: "error", url: null, error: message, ...(fix ? { fix } : {}) });
    if (!wasReady || !this.wanted) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.retries++, RETRY_DELAYS_MS.length - 1)]!;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.wanted && !this.client) this.start(true);
    }, delay);
  }

  private start(retrying = false): void {
    const server = this.server();
    if (!server.connectionId) {
      this.set({ status: "error", url: null, error: "设置里「公网分享」还没选 SSH 连接" });
      return;
    }
    this.set({ status: "starting", url: null, error: null });
    const client = new ssh2.Client();
    this.client = client;
    // 先按 ~/.ssh/config 解析出连接的地址、账号、密钥、跳板
    void dialOf(server).then(
      (dial) => {
        if (this.client === client) this.connect(client, server, dial, retrying);
      },
      (err: unknown) => this.fail(client, err instanceof Error ? err.message : String(err), false),
    );
  }

  private connect(client: ssh2.Client, server: ShareServer, dial: Dial, retrying: boolean): void {
    const url = publicUrlOf(server, dial.host);
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
        if (err) {
          const message = `服务器上开不了端口 ${server.remotePort}（被上一条还没断干净的连接或别的程序占着，或者 sshd 不允许反向转发）：${err.message}`;
          // 多半是一会儿就好的占用：断开，过 2 秒重新连，期间还算 starting；重试够了再报错（断线重连时报错后照样按退避继续）
          if (this.bindRetries < BIND_RETRIES) {
            this.bindRetries++;
            this.client = null;
            client.end();
            this.log.info({ attempt: this.bindRetries, error: err.message }, "服务器上的端口开不了，稍后重试（公网分享）");
            this.retryTimer = setTimeout(() => {
              this.retryTimer = undefined;
              if (this.wanted && !this.client) this.start(retrying);
            }, BIND_RETRY_MS);
            return;
          }
          this.bindRetries = 0;
          return this.fail(client, message, retrying);
        }
        void selfCheck(url).then(async (check) => {
          if (this.client !== client) return;
          if (check) {
            // 外面连不上：登录着服务器看一眼端口开在哪、GatewayPorts 是什么，报得具体些
            const { message, fix } = check.unreachable ? await explainUnreachable(client, url, server.remotePort, check.reason) : { message: check.message, fix: undefined };
            return this.fail(client, message, retrying, fix);
          }
          ready = true;
          this.retries = 0;
          this.bindRetries = 0;
          this.log.info({ url }, "公网分享已挂到服务器上");
          this.set({ status: "ready", url, error: null });
        });
      });
    });

    const hostVerifier = (blob: Buffer, verify: (ok: boolean) => void) => {
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

/** 怎么连服务器（设置「SSH 连接」里的连接） */
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

/**
 * 地址、账号、密钥、ProxyJump 都按 ~/.ssh/config 和那边的配置（同 SshHost 的连接参数）；
 * 主机密钥要是那边信任过的，或者本机 known_hosts 里记着的。密码先用「公网分享」里填的，没填用这次在「SSH 连接」里输入的
 */
async function dialOf(server: ShareServer): Promise<Dial> {
  const id = server.connectionId;
  const conn = id ? getConnection(id) : undefined;
  if (!id || !conn) throw new Error("「公网分享」选的 SSH 连接不存在了（可能已经在设置里删掉了），重新选一个");
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
async function selfCheck(url: string): Promise<{ message: string; unreachable: boolean; reason: string } | null> {
  try {
    const res = await fetch(`${url}${ENTRY_CHECK_PATH}`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    if (body?.id === ENTRY_ID) return null;
    return { message: `${url} 打开的不是这里的分享入口（HTTP ${res.status}），端口可能被服务器上别的程序占着`, unreachable: false, reason: "" };
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = (err as Error).name === "TimeoutError" ? "超时" : (cause?.code ?? cause?.message ?? (err as Error).message);
    return { message: "", unreachable: true, reason };
  }
}

/** 在服务器上跑一段 sh 脚本（从标准输入喂进去） */
function runScript(client: ssh2.Client, script: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    client.exec("sh -s", (err, channel) => {
      if (err) return resolve({ code: null, stdout: Buffer.alloc(0), stderr: err.message });
      void collect(channel, script, timeoutMs).then(resolve);
    });
  });
}

/** 服务器上这个端口监听在哪些地址、sshd 配置文件里写的 GatewayPorts（没写是默认的 no） */
const DIAGNOSE = (port: number) => `p=${port}
if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | awk -v p=":$p" 'substr($4, length($4)-length(p)+1) == p {print "LISTEN " $4}'
elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | awk -v p=":$p" 'substr($4, length($4)-length(p)+1) == p {print "LISTEN " $4}'
else echo "NOTOOL"; fi
g=$(grep -hiE '^[[:space:]]*GatewayPorts[[:space:]]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | head -n 1 | awk '{print tolower($2)}')
[ -n "$g" ] || g=no
echo "GP $g"
`;

/**
 * 外面打不开公网地址时的说明：端口只开在服务器的 127.0.0.1 上（sshd 的 GatewayPorts 没开）是能一键修的（fix），
 * 已经开在所有地址上还打不开是防火墙、安全组
 */
async function explainUnreachable(client: ssh2.Client, url: string, port: number, reason: string): Promise<{ message: string; fix?: ShareTunnelState["fix"] }> {
  const head = `已经登录服务器、开了端口，但从外面打不开 ${url}（${reason}）`;
  const result = await runScript(client, DIAGNOSE(port), 10_000).catch(() => null);
  const out = result?.stdout.toString("utf8") ?? "";
  const listen = [...out.matchAll(/^LISTEN (\S+)/gm)].map((m) => m[1]!);
  const gatewayPorts = /^GP (\S+)/m.exec(out)?.[1] ?? null;
  const loopback = (a: string) => a.startsWith("127.") || a.startsWith("[::1]") || a.startsWith("::1");
  if (listen.length ? listen.every(loopback) : gatewayPorts === "no") {
    // 配置里已经开了、端口还是只开在 127.0.0.1 上：改完没重启 sshd
    const configured = gatewayPorts === "clientspecified" || gatewayPorts === "yes";
    return {
      message: configured
        ? `${head}：服务器上的这个端口只开在 127.0.0.1 上。sshd 配置里已经写了 GatewayPorts ${gatewayPorts}，但还没生效，要重启 sshd`
        : `${head}：服务器上的这个端口只开在 127.0.0.1 上，因为 sshd 的 GatewayPorts 没开（现在是 ${gatewayPorts ?? "no"}）。要在 sshd 配置里加 GatewayPorts clientspecified 并重启 sshd`,
      fix: "gatewayPorts",
    };
  }
  if (listen.length) return { message: `${head}：服务器上已经在所有地址上监听 ${port}（${listen.join("、")}），多半是服务器的防火墙或云服务器的安全组没放行 TCP ${port}` };
  return { message: `${head}。检查服务器 sshd 配置里的 GatewayPorts（要 clientspecified 或 yes，改完重启 sshd），以及防火墙、云服务器的安全组有没有放行 TCP ${port}` };
}

/** 在服务器上开启 GatewayPorts：sudo 免密写一个单独的配置文件，sshd -t 检查过才重启；每种失败各有一个标记，见 fixGatewayPorts */
// String.raw：脚本里 grep 的 \. \* 要原样留着
const FIX_SCRIPT = String.raw`SUDO=""
if [ "$(id -u)" != "0" ]; then
  if ! sudo -n true >/dev/null 2>&1; then echo "RESULT nosudo"; exit 0; fi
  SUDO="sudo -n"
fi
SSHD=$(command -v sshd 2>/dev/null || echo /usr/sbin/sshd)
if ! grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config 2>/dev/null; then echo "RESULT noinclude"; exit 0; fi
F=/etc/ssh/sshd_config.d/99-claude-app.conf
echo "GatewayPorts clientspecified" | $SUDO tee "$F" >/dev/null || { echo "RESULT writefail"; exit 0; }
if ! err=$($SUDO "$SSHD" -t 2>&1); then $SUDO rm -f "$F"; echo "RESULT badconfig $err"; exit 0; fi
v=$($SUDO "$SSHD" -T 2>/dev/null | awk 'tolower($1)=="gatewayports"{print tolower($2)}')
if [ "$v" != "clientspecified" ] && [ "$v" != "yes" ]; then $SUDO rm -f "$F"; echo "RESULT overridden $v"; exit 0; fi
# 重启 sshd：systemd → service → 给监听进程发 HUP（sshd 收到 HUP 重新读配置），已经连着的 SSH 都不断
restarted=""
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl restart ssh >/dev/null 2>&1 || $SUDO systemctl restart sshd >/dev/null 2>&1 && restarted=1
fi
if [ -z "$restarted" ] && command -v service >/dev/null 2>&1; then
  $SUDO service ssh restart >/dev/null 2>&1 || $SUDO service sshd restart >/dev/null 2>&1 && restarted=1
fi
if [ -z "$restarted" ]; then
  for f in /run/sshd.pid /var/run/sshd.pid; do
    if [ -f "$f" ]; then $SUDO kill -HUP "$(cat "$f")" >/dev/null 2>&1 && restarted=1 && break; fi
  done
fi
[ -n "$restarted" ] || { echo "RESULT norestart"; exit 0; }
echo "RESULT ok"
`;

/** 手动开启的命令（自动开不了时给设置页显示） */
export const GATEWAY_PORTS_MANUAL = [
  'echo "GatewayPorts clientspecified" | sudo tee /etc/ssh/sshd_config.d/99-claude-app.conf',
  "sudo sshd -t && sudo systemctl restart ssh",
  "sudo sshd -T | grep -i gatewayports",
].join("\n");

/**
 * 设置页「在服务器上开启 GatewayPorts」：用填的配置登录服务器，写 /etc/ssh/sshd_config.d/99-claude-app.conf、sshd -t 检查、
 * 确认生效后重启 sshd（已经连着的 SSH 不断）。主配置不读 sshd_config.d、sudo 要密码等情况不改，给出原因
 */
export async function fixGatewayPorts(server: ShareServer, log: FastifyBaseLogger): Promise<ShareFixResult> {
  let dial: Dial;
  try {
    dial = await dialOf(server);
  } catch (err) {
    return { ok: false, error: (err as Error).message, manual: GATEWAY_PORTS_MANUAL };
  }
  const client = new ssh2.Client();
  try {
    await new Promise<void>((resolve, reject) => {
      let hostKeyError: string | null = null;
      client.once("ready", () => resolve());
      client.once("error", (err) => reject(new Error(hostKeyError ?? ((err as { level?: string }).level === "client-authentication" ? `登录不了 ${dial.where}：${dial.authHint}` : `连不上 ${dial.where}：${err.message}`))));
      client.connect(
        dial.config((blob, verify) => {
          void dial.verify(blob).then((problem) => {
            hostKeyError = problem;
            verify(!problem);
          });
        }),
      );
    });
    const result = await runScript(client, FIX_SCRIPT, 30_000);
    const line = /^RESULT (\S+)(?: (.*))?$/m.exec(result.stdout.toString("utf8"));
    const kind = line?.[1];
    const detail = line?.[2]?.trim() ?? "";
    log.info({ server: dial.where, result: kind, detail }, "在服务器上开启 GatewayPorts（公网分享）");
    const fail = (error: string): ShareFixResult => ({ ok: false, error, manual: GATEWAY_PORTS_MANUAL });
    switch (kind) {
      case "ok":
        return { ok: true, message: "已经在服务器上加了 /etc/ssh/sshd_config.d/99-claude-app.conf（GatewayPorts clientspecified）并重启了 sshd" };
      case "nosudo":
        return fail("这个账号用 sudo 要输密码（或者不能 sudo），没法自动改，请登录服务器手动执行下面的命令");
      case "noinclude":
        return fail("服务器的 /etc/ssh/sshd_config 不读 sshd_config.d 目录，没有自动改（免得改错位置），请手动在 sshd_config 开头加 GatewayPorts clientspecified 再重启 sshd");
      case "writefail":
        return fail("写不了 /etc/ssh/sshd_config.d/99-claude-app.conf");
      case "badconfig":
        return fail(`sshd -t 检查没通过，已经删掉刚写的文件、没有重启：${detail}`);
      case "overridden":
        return fail(`sshd 的配置里别处已经写了 GatewayPorts ${detail || "（别的值）"}，新加的不生效，已经删掉刚写的文件；请手动改那一处`);
      case "norestart":
        return fail("配置已经写好、检查通过，但重启不了 sshd（systemctl、service、给 sshd 发 HUP 都不行），请手动重启 sshd");
      default:
        return fail(`在服务器上执行没有结果（退出码 ${result.code ?? "无"}）：${result.stderr.trim() || "没有输出"}，Windows 服务器不支持自动开启`);
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message, manual: GATEWAY_PORTS_MANUAL };
  } finally {
    client.end();
  }
}

/**
 * 设置页「测试连接」：用填的配置连一次、开端口、自检，然后断开。本机的分享入口可能没在监听，
 * 进来的连接接到一个临时的本机服务上，它只回自检
 */
export async function probeServer(server: ShareServer, log: FastifyBaseLogger): Promise<ShareTunnelState> {
  const stub = http.createServer((req, res) => {
    res.writeHead(req.url === ENTRY_CHECK_PATH ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === ENTRY_CHECK_PATH ? { id: ENTRY_ID } : { error: "not found" }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as net.AddressInfo).port;
  const tunnel = new SshShareTunnel(() => port, () => server, log);
  try {
    return await tunnel.ensure();
  } finally {
    tunnel.stop();
    stub.closeAllConnections();
    stub.close();
  }
}
