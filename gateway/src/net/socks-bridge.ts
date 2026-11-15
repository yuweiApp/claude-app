import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/**
 * SOCKS5 代理的转接：Claude Code、curl、git、Node 的 fetch 都只认 HTTP 代理（HTTPS_PROXY），
 * 设置页「网络代理」用的是 SOCKS5 时，网关在 127.0.0.1 上开一个 HTTP 代理，收到的 CONNECT 和普通 HTTP 请求都经 SOCKS5 连出去
 * （域名交给 SOCKS5 代理解析）。见 docs/proxy.md「SOCKS5」。
 * 要认证（Basic，用户名 claude-app，密码是令牌）：本机别的进程不能拿它当跳板；每个令牌对应一个上游，
 * 正在用的设置一个固定令牌（地址不变，换上游不用换子进程的环境变量），测试连接临时开一个
 */
export interface SocksUpstream {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const USER = "claude-app";
const CONNECT_TIMEOUT_MS = 20_000;

export class SocksBridge {
  private server: http.Server | null = null;
  private port = 0;
  private readonly upstreams = new Map<string, SocksUpstream>();

  /** 网关启动时开好（不管用不用），之后地址都是同步拿的 */
  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.onRequest(req, res));
    server.on("connect", (req: IncomingMessage, socket: net.Socket, head: Buffer) => void this.onConnect(req, socket, head));
    server.on("clientError", (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  /** 给一个上游开一个令牌，返回指向它的代理地址（带用户名、令牌）；token 不传是新生成的 */
  register(upstream: SocksUpstream, token = randomBytes(18).toString("base64url")): { url: string; token: string } {
    if (!this.server) throw new Error("SOCKS5 转接还没启动");
    this.upstreams.set(token, upstream);
    return { url: this.urlFor(token), token };
  }

  /** 令牌对应的代理地址（带用户名、令牌）；令牌还没 register 时连过来会被拒绝（407） */
  urlFor(token: string): string {
    if (!this.server) throw new Error("SOCKS5 转接还没启动");
    return `http://${USER}:${token}@127.0.0.1:${this.port}`;
  }

  unregister(token: string): void {
    this.upstreams.delete(token);
  }

  /** 认证不对、令牌不认识是 undefined */
  private upstreamOf(req: IncomingMessage): SocksUpstream | undefined {
    const auth = req.headers["proxy-authorization"];
    if (typeof auth !== "string" || !auth.startsWith("Basic ")) return undefined;
    const [user, token] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    return user === USER && token ? this.upstreams.get(token) : undefined;
  }

  /** CONNECT host:port（https，以及 undici 经代理的 http） */
  private async onConnect(req: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    socket.on("error", () => undefined);
    const upstream = this.upstreamOf(req);
    if (!upstream) return void socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="claude-app"\r\nContent-Length: 0\r\n\r\n');
    const target = splitHostPort(req.url ?? "", 443);
    if (!target) return void socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
    let s: net.Socket;
    try {
      s = await socksConnect(upstream, target.host, target.port);
    } catch (err) {
      const msg = Buffer.from((err as Error).message);
      return void socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${msg.length}\r\n\r\n${msg}`);
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) s.write(head);
    pipeBoth(socket, s);
  }

  /** 普通的 http 请求（代理收到的是完整网址；curl 等对 http:// 地址这样发） */
  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const upstream = this.upstreamOf(req);
    if (!upstream) return void res.writeHead(407, { "proxy-authenticate": 'Basic realm="claude-app"', "content-length": "0" }).end();
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return void res.writeHead(400).end();
    }
    if (url.protocol !== "http:") return void res.writeHead(400).end();
    let s: net.Socket;
    try {
      s = await socksConnect(upstream, url.hostname.replace(/^\[(.*)\]$/, "$1"), Number(url.port) || 80);
    } catch (err) {
      return void res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end((err as Error).message);
    }
    const headers = { ...req.headers };
    for (const h of ["proxy-authorization", "proxy-connection", "connection", "keep-alive"]) delete headers[h];
    // 不传 agent：传了 agent（包括 false，会新建一个）时 createConnection 不起作用，又按 localhost:80 去连
    const out = http.request({ method: req.method, path: `${url.pathname}${url.search}`, headers, createConnection: () => s.resume() }, (up) => {
      const h = { ...up.headers };
      for (const k of ["connection", "keep-alive", "transfer-encoding"]) delete h[k];
      res.writeHead(up.statusCode ?? 502, up.statusMessage, h);
      up.pipe(res);
    });
    out.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(err.message);
    });
    res.on("close", () => out.destroy());
    req.pipe(out);
  }
}

/** SOCKS5 连到 host:port：有用户名时用用户名、密码认证（RFC 1929）；域名交给代理解析 */
export async function socksConnect(upstream: SocksUpstream, host: string, port: number): Promise<net.Socket> {
  const s = await new Promise<net.Socket>((resolve, reject) => {
    const sock = net.connect({ host: upstream.host, port: upstream.port });
    const timer = setTimeout(() => sock.destroy(new Error(`连 SOCKS5 代理 ${upstream.host}:${upstream.port} 超时`)), CONNECT_TIMEOUT_MS);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.off("error", onError);
      resolve(sock);
    });
    const onError = (err: Error & { code?: string }) => {
      clearTimeout(timer);
      reject(new Error(`连不上 SOCKS5 代理 ${upstream.host}:${upstream.port}（${err.code ?? err.message}）`));
    };
    sock.once("error", onError);
  });
  try {
    const auth = upstream.username !== undefined && upstream.username !== "";
    s.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
    const hello = await readBytes(s, 2);
    if (hello[0] !== 5) throw new Error("对方不是 SOCKS5 代理");
    if (hello[1] === 2) {
      if (!auth) throw new Error("SOCKS5 代理要求用户名、密码");
      const u = Buffer.from(upstream.username!);
      const p = Buffer.from(upstream.password ?? "");
      s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const reply = await readBytes(s, 2);
      if (reply[1] !== 0) throw new Error("SOCKS5 代理认证失败：用户名或密码不对");
    } else if (hello[1] !== 0) {
      throw new Error(hello[1] === 0xff ? "SOCKS5 代理不接受这种认证方式" : `SOCKS5 代理选了不支持的认证方式（${hello[1]}）`);
    }
    s.write(Buffer.concat([Buffer.from([5, 1, 0]), address(host), Buffer.from([port >> 8, port & 255])]));
    const head = await readBytes(s, 5);
    if (head[1] !== 0) throw new Error(`SOCKS5 代理连不上 ${host}:${port}（${SOCKS_ERRORS[head[1]!] ?? `错误 ${head[1]}`}）`);
    // 剩下的绑定地址读掉：IPv4 4 字节、IPv6 16 字节、域名 1 + 长度，再加 2 字节端口；已经读了 1 个字节（类型后面的第一个）
    const rest = head[3] === 1 ? 3 + 2 : head[3] === 4 ? 15 + 2 : head[4]! + 2;
    await readBytes(s, rest);
    return s;
  } catch (err) {
    s.destroy();
    throw err;
  }
}

const SOCKS_ERRORS: Record<number, string> = {
  1: "代理内部错误",
  2: "代理的规则不允许",
  3: "网络不可达",
  4: "主机不可达",
  5: "连接被拒绝",
  6: "TTL 过期",
  7: "不支持的命令",
  8: "不支持的地址类型",
};

function address(host: string): Buffer {
  const h = host.replace(/^\[(.*)\]$/, "$1");
  if (net.isIPv4(h)) return Buffer.from([1, ...h.split(".").map(Number)]);
  if (net.isIPv6(h)) {
    // 展开 :: 后按 8 组写
    const [head, tail] = h.split("::") as [string, string | undefined];
    const a = head ? head.split(":") : [];
    const b = tail !== undefined && tail ? tail.split(":") : [];
    const groups = tail === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
    const buf = Buffer.alloc(17);
    buf[0] = 4;
    groups.forEach((g, i) => buf.writeUInt16BE(Number.parseInt(g || "0", 16), 1 + i * 2));
    return buf;
  }
  const name = Buffer.from(h);
  if (name.length > 255) throw new Error(`域名太长：${h}`);
  return Buffer.concat([Buffer.from([3, name.length]), name]);
}

/** 读正好 n 个字节；多读到的放回去 */
function readBytes(s: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error("SOCKS5 代理没有回复")), CONNECT_TIMEOUT_MS);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < n) return;
      // 先摘掉监听、停下来再放回多读的，不然放回去的又被这里读到
      done(null, buf.subarray(0, n));
      if (buf.length > n) s.unshift(buf.subarray(n));
    };
    const onEnd = () => done(new Error("SOCKS5 代理断开了连接"));
    const done = (err: Error | null, value?: Buffer) => {
      clearTimeout(timer);
      s.off("data", onData);
      s.off("end", onEnd);
      s.off("error", onEnd);
      s.pause();
      if (err) reject(err);
      else resolve(value!);
    };
    s.on("data", onData);
    s.on("end", onEnd);
    s.on("error", onEnd);
    s.resume();
  });
}

function splitHostPort(s: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  return port > 0 && port < 65536 ? { host: m[1]!.replace(/^\[(.*)\]$/, "$1"), port } : null;
}

function pipeBoth(a: Duplex, b: Duplex): void {
  a.on("error", () => b.destroy());
  b.on("error", () => a.destroy());
  a.on("close", () => b.destroy());
  b.on("close", () => a.destroy());
  a.pipe(b).pipe(a);
}
