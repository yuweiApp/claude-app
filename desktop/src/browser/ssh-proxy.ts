import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { app, session } from "electron";

/**
 * 远程会话（SSH）的内置浏览器访问远端的 localhost：这样的标签页用这台主机自己的分区（views.ts 的 partitionFor），
 * 分区的代理是这里在本机 127.0.0.1 上开的（每台主机一个端口）。请求 localhost、127.0.0.1、[::1]、*.localhost 的连接，
 * 每条开一个 WebSocket 到网关的 /browser/tunnel，网关经 SSH 连远端的同一个地址（gateway/src/browser/tunnel.ts），地址不用改；
 * 其他地址照系统的代理设置（默认会话的 resolveProxy）直连，或者经 HTTP、SOCKS5 代理连出去，同本机会话的标签页。
 *
 * 分区不用 PAC：Chromium 对 loopback 的隐式直连在 PAC 下去不掉；只能固定代理加 <-loopback>，所有请求都到这里，
 * 而绕过规则又分不出「只有 loopback 走代理」（<local> 把 localhost 也算进去），所以非 loopback 的也由这里转。
 * 代理要认证（Basic，令牌每次启动新生成），浏览器的 login 事件在这里回答：本机别的进程不能拿它当跳板
 */

const USER = "claude-app";

export class SshProxies {
  private readonly token = randomBytes(18).toString("base64url");
  private readonly servers = new Map<string, Promise<number>>();
  private readonly ports = new Set<number>();
  /** 普通 http 请求用的连接池，每台主机一个：连接留着给后面的请求用（远端的每条连接都要新开一个 SSH 通道，要一个来回） */
  private readonly agents = new Map<string, http.Agent>();

  /** gatewayUrl：http(s)://…，token：网关的 API_TOKEN（没有是空串） */
  constructor(
    private readonly gatewayUrl: string,
    private readonly gatewayToken: string,
  ) {
    app.on("login", (event, _wc, _details, authInfo, callback) => {
      if (!authInfo.isProxy || !["127.0.0.1", "localhost"].includes(authInfo.host) || !this.ports.has(authInfo.port)) return;
      event.preventDefault();
      callback(USER, this.token);
    });
  }

  /** 这台主机的代理端口（第一次用时开） */
  portFor(remote: string): Promise<number> {
    let port = this.servers.get(remote);
    if (!port) {
      port = this.listen(remote);
      this.servers.set(remote, port);
      port.catch(() => this.servers.delete(remote));
    }
    return port;
  }

  /** 给分区设上这台主机的代理 */
  async apply(ses: Electron.Session, remote: string): Promise<void> {
    const port = await this.portFor(remote);
    await ses.setProxy({ mode: "fixed_servers", proxyRules: `127.0.0.1:${port}`, proxyBypassRules: "<-loopback>" });
  }

  private listen(remote: string): Promise<number> {
    const server = http.createServer((req, res) => void this.onRequest(remote, req, res));
    server.on("connect", (req: IncomingMessage, socket: net.Socket, head: Buffer) => void this.onConnect(remote, req, socket, head));
    server.on("clientError", (_err, socket) => socket.destroy());
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        this.ports.add(port);
        resolve(port);
      });
    });
  }

  private authorized(req: IncomingMessage): boolean {
    return req.headers["proxy-authorization"] === `Basic ${Buffer.from(`${USER}:${this.token}`).toString("base64")}`;
  }

  /** CONNECT host:port（https、wss，以及经代理的 ws） */
  private async onConnect(remote: string, req: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    socket.on("error", () => undefined);
    if (!this.authorized(req)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="claude-app"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = splitHostPort(req.url ?? "", 443);
    if (!target) return void socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
    let upstream: Duplex;
    try {
      upstream = await this.open(remote, target.host, target.port, `https://${req.url}/`);
    } catch (err) {
      const msg = Buffer.from(err instanceof Error ? err.message : String(err));
      return void socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${msg.length}\r\n\r\n${msg}`);
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    pipeBoth(socket, upstream);
  }

  /** 普通的 http 请求（代理收到的是完整网址） */
  private async onRequest(remote: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="claude-app"', "content-length": "0" }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== "http:") return void res.writeHead(400).end();
    const headers = { ...req.headers };
    for (const h of ["proxy-authorization", "proxy-connection", "connection", "keep-alive"]) delete headers[h];
    const idempotent = req.method === "GET" || req.method === "HEAD";
    const send = (first: boolean): void => {
      const out = http.request({ host: url.hostname, port: Number(url.port) || 80, method: req.method, path: `${url.pathname}${url.search}`, headers, agent: this.agentFor(remote) }, (up) => {
        const h = { ...up.headers };
        for (const k of ["connection", "keep-alive", "transfer-encoding"]) delete h[k];
        res.writeHead(up.statusCode ?? 502, up.statusMessage, h);
        up.pipe(res);
      });
      out.on("error", (err) => {
        // 分到的空闲连接恰好在这时被远端关掉：GET、HEAD 换一条连接重发一次（同浏览器自己的做法）
        if (first && idempotent && out.reusedSocket && !res.headersSent) return send(false);
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(err.message);
      });
      const abort = () => out.destroy();
      res.on("close", abort);
      out.on("close", () => res.off("close", abort));
      if (first) req.pipe(out);
      else out.end();
    };
    send(true);
  }

  private agentFor(remote: string): http.Agent {
    let agent = this.agents.get(remote);
    if (!agent) {
      agent = new RouteAgent((host, port) => this.open(remote, host, port, `http://${host.includes(":") ? `[${host}]` : host}:${port}/`));
      this.agents.set(remote, agent);
    }
    return agent;
  }

  /** 连到 host:port：loopback 经网关到远端，其他的按系统代理设置 */
  private async open(remote: string, host: string, port: number, url: string): Promise<Duplex> {
    if (isLoopback(host)) return this.tunnel(remote, host, port);
    const route = await session.defaultSession.resolveProxy(url);
    for (const entry of route.split(";").map((s) => s.trim()).filter(Boolean)) {
      const [kind, addr] = entry.split(/\s+/) as [string, string | undefined];
      const proxy = addr ? splitHostPort(addr, kind === "PROXY" ? 80 : 1080) : null;
      try {
        if (kind === "DIRECT") return await direct(host, port);
        if (kind === "PROXY" && proxy) return await viaHttpProxy(proxy, host, port);
        if ((kind === "SOCKS5" || kind === "SOCKS") && proxy) return await viaSocks5(proxy, host, port);
      } catch {
        // 试下一个
      }
    }
    return direct(host, port);
  }

  private tunnel(remote: string, host: string, port: number): Promise<Duplex> {
    const url = new URL("/browser/tunnel", this.gatewayUrl.replace(/^http/, "ws"));
    url.searchParams.set("host", remote);
    url.searchParams.set("dest", host.replace(/^\[(.*)\]$/, "$1"));
    url.searchParams.set("port", String(port));
    if (this.gatewayToken) url.searchParams.set("token", this.gatewayToken);
    return new Promise((resolve, reject) => {
      const stream = new WsStream(url.toString());
      stream.once("open", () => resolve(stream));
      stream.once("error", reject);
    });
  }
}

/** 连接池：连接由 open 建（经网关到远端，或者按系统代理），建好的留着复用 */
class RouteAgent extends http.Agent {
  constructor(private readonly open: (host: string, port: number) => Promise<Duplex>) {
    super({ keepAlive: true, keepAliveMsecs: 15_000 });
  }

  override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex | undefined {
    this.open(String(options.host), Number(options.port)).then(
      (s) => callback?.(null, s),
      (err: Error) => callback?.(err, undefined as unknown as Duplex),
    );
    return undefined;
  }
}

/** localhost、*.localhost、127.0.0.0/8、[::1]，同 Chromium 的 loopback */
function isLoopback(host: string): boolean {
  const h = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
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

function direct(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
}

/** 经 HTTP 代理（系统设置的）：CONNECT 过去 */
async function viaHttpProxy(proxy: { host: string; port: number }, host: string, port: number): Promise<net.Socket> {
  const s = await direct(proxy.host, proxy.port);
  const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const head = await readUntil(s, (b) => b.indexOf("\r\n\r\n"));
  const end = head.indexOf("\r\n\r\n") + 4;
  if (!/^HTTP\/1\.[01] 200/.test(head.subarray(0, end).toString("latin1"))) {
    s.destroy();
    throw new Error(`代理拒绝了 CONNECT：${head.subarray(0, head.indexOf("\r\n")).toString("latin1")}`);
  }
  if (head.length > end) s.unshift(head.subarray(end));
  return s;
}

/** 经 SOCKS5 代理（不认证，地址交给代理解析） */
async function viaSocks5(proxy: { host: string; port: number }, host: string, port: number): Promise<net.Socket> {
  const s = await direct(proxy.host, proxy.port);
  s.write(Buffer.from([5, 1, 0]));
  const hello = await readUntil(s, (b) => (b.length >= 2 ? 2 : -1));
  if (hello[0] !== 5 || hello[1] !== 0) {
    s.destroy();
    throw new Error("SOCKS5 代理要认证，不支持");
  }
  const name = Buffer.from(host);
  s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
  const size = (b: Buffer) => 4 + (b[3] === 1 ? 4 : b[3] === 4 ? 16 : 1 + b[4]!) + 2;
  const reply = await readUntil(s, (b) => (b.length >= 5 && b.length >= size(b) ? size(b) : -1));
  if (reply[1] !== 0) {
    s.destroy();
    throw new Error(`SOCKS5 代理连不上目标（${reply[1]}）`);
  }
  if (reply.length > size(reply)) s.unshift(reply.subarray(size(reply)));
  return s;
}

/** 读到 done 返回非负为止（返回读到的全部，多出来的由调用方放回去） */
function readUntil(s: net.Socket, done: (b: Buffer) => number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (done(buf) >= 0) {
        cleanup();
        resolve(buf);
      } else if (buf.length > 16384) {
        cleanup();
        reject(new Error("代理的回复太长"));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("代理断开了"));
    };
    const cleanup = () => {
      s.off("data", onData);
      s.off("end", onEnd);
      s.off("error", onEnd);
    };
    s.on("data", onData);
    s.on("end", onEnd);
    s.on("error", onEnd);
  });
}

/**
 * 一条 WebSocket 当成字节流用（每条连接一个，到网关的 /browser/tunnel）；连上前写的先存着。
 * http.Agent 的连接池把它当 net.Socket 用，空闲连接的回收靠的是 net.Socket 的这两点，这里照做：
 * - 不半开（allowHalfOpen: false）：远端关了（网关关 WebSocket）就整个关掉，连接池听 close 把它移出去；
 * - setTimeout 到点真的发 timeout：连接池按服务器的 Keep-Alive: timeout=N 提前 1 秒回收空闲连接（Vite 等 Node 服务器是 5 秒）。
 * 以前两样都没有：远端关掉的空闲连接一直留在池里，下一个请求分到它，写进已经关了的 WebSocket 被丢掉，网页一直转圈
 */
class WsStream extends Duplex {
  private readonly ws: WebSocket;
  private queue: Buffer[] = [];
  private opened = false;
  private idleMs = 0;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(url: string) {
    super({ allowHalfOpen: false });
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      this.opened = true;
      for (const b of this.queue.splice(0)) this.ws.send(b);
      this.emit("open");
    });
    this.ws.addEventListener("message", (e) => {
      const data = e.data instanceof ArrayBuffer ? Buffer.from(e.data) : Buffer.from(String(e.data));
      this.touch();
      this.push(data);
    });
    this.ws.addEventListener("close", (e) => {
      clearTimeout(this.idleTimer);
      // 网关在连远端之前、连不上时关闭，原因写在 reason 里
      if (!this.opened || (e.code !== 1000 && e.code !== 1005 && e.reason)) this.destroy(new Error(e.reason || `连不上网关的转发（${e.code}）`));
      else this.push(null);
    });
    this.ws.addEventListener("error", () => undefined);
  }

  // http.Agent 把它当 net.Socket 用：这几个调用在 WebSocket 上没有意义
  setKeepAlive(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  /** 同 net.Socket：ms 内没有收发就发一次 timeout（不自己关），0 是不限 */
  setTimeout(ms: number, cb?: () => void): this {
    if (cb) {
      if (ms === 0) this.off("timeout", cb);
      else this.once("timeout", cb);
    }
    this.idleMs = ms;
    this.touch();
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = this.idleMs > 0 && !this.destroyed ? setTimeout(() => this.emit("timeout"), this.idleMs) : undefined;
  }

  override _read(): void {}

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (!this.opened) {
      this.queue.push(chunk);
      return cb();
    }
    // 已经关了的 WebSocket，send 不报错、数据直接丢掉：这里报错，请求马上失败，不会一直等回复
    if (this.ws.readyState !== WebSocket.OPEN) return cb(new Error("到远端的连接已经断开"));
    this.touch();
    this.ws.send(chunk);
    // 发不出去的积太多时等一等
    const wait = () => (this.ws.bufferedAmount > 4 * 1024 * 1024 && this.ws.readyState === WebSocket.OPEN ? setTimeout(wait, 20) : cb());
    wait();
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.ws.close(1000);
    cb();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    clearTimeout(this.idleTimer);
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(1000);
    cb(err);
  }
}
