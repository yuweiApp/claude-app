import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { PAGE_PREFIX } from "../http/routes/files.js";
import type { ShareStore } from "./store.js";

/**
 * 局域网分享的入口（见 docs/lan-share.md「局域网入口」）：有分享时监听 0.0.0.0:SHARE_PORT，没有分享时不监听。
 * 进来的请求都是访客的：/api/* 校验分享令牌、只放行这个会话用到的接口，转发给网关自己（127.0.0.1:PORT）；
 * 其余（页面、脚本、HMR）转发给页面服务（开发时是 Vite）。网关原来的监听、鉴权都不经过这里，也不受影响。
 */
export class LanServer {
  private server: http.Server | null = null;
  /** 正在进行的 sync()，排队执行 */
  private syncing: Promise<void> = Promise.resolve();
  /** 每个令牌的连接（HTTP 响应、WebSocket），停止分享时全部断开 */
  private readonly connections = new Map<string, Set<{ destroy(): void }>>();
  /** 上一次开始监听失败的原因（端口被占用等），开分享的接口据此报错 */
  error: string | null = null;

  constructor(
    private readonly shares: ShareStore,
    private readonly log: FastifyBaseLogger,
  ) {
    shares.onChange(() => void this.sync());
  }

  get listening(): boolean {
    return this.server !== null;
  }

  /** 按现在的分享开关监听，断开已经停掉的分享的连接 */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(() => this.doSync());
    return this.syncing;
  }

  async close(): Promise<void> {
    await this.syncing;
    await this.stop();
  }

  private async doSync(): Promise<void> {
    const tokens = new Set(this.shares.list().map((s) => s.token));
    for (const [token, set] of this.connections) {
      if (tokens.has(token)) continue;
      for (const c of set) c.destroy();
      this.connections.delete(token);
    }
    if (tokens.size > 0 && !this.server) await this.start();
    else if (tokens.size === 0 && this.server) await this.stop();
  }

  private start(): Promise<void> {
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
    return new Promise((resolve) => {
      server.once("error", (err) => {
        this.error = `局域网分享的端口 ${config.sharePort} 监听失败：${err.message}`;
        this.log.error({ err }, this.error);
        resolve();
      });
      server.listen(config.sharePort, "0.0.0.0", () => {
        this.server = server;
        this.error = null;
        this.log.info({ port: config.sharePort }, "局域网分享的入口已开始监听");
        resolve();
      });
    });
  }

  private async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const set of this.connections.values()) for (const c of set) c.destroy();
    this.connections.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.log.info("没有分享了，局域网分享的入口已关闭");
  }

  private track(token: string, conn: { destroy(): void }, closer: { once(event: "close", fn: () => void): unknown }): void {
    let set = this.connections.get(token);
    if (!set) this.connections.set(token, (set = new Set()));
    set.add(conn);
    closer.once("close", () => set.delete(conn));
  }

  /** 判断一个请求：转给谁、用什么路径，或者直接拒绝 */
  private route(req: IncomingMessage): Route {
    const url = new URL(req.url ?? "/", "http://lan");
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      // 没带分享链接打开根目录时，页面会当成本机的界面，接口全是 401，直接提示。
      // Vite 的 HMR 也连根目录（WebSocket），要放过去
      const page = url.pathname === "/" || url.pathname === "/index.html";
      if (page && !req.headers.upgrade) return { kind: "reject", status: 404, message: "请用完整的分享链接打开（http://…/share/<令牌>）" };
      return { kind: "client", path: url.pathname + url.search };
    }
    const apiPath = url.pathname.slice(4) || "/";
    const target = apiPath + url.search;
    // 网页预览（HTML 文件）里的相对地址带不了令牌，网关本身也不要求，见 http/routes/files.ts
    if (apiPath.startsWith(PAGE_PREFIX)) return { kind: "gateway", path: target, token: null };
    const token = headerValue(req.headers["x-share-token"]) ?? url.searchParams.get("share");
    const share = this.shares.byToken(token);
    if (!share || !token) return { kind: "reject", status: 401, message: "分享已结束或链接无效" };
    if (!allowed(req.method ?? "GET", apiPath, share.sessionId)) return { kind: "reject", status: 403, message: "分享的访客不能使用这个功能" };
    return { kind: "gateway", path: target, token };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const route = this.route(req);
    if (route.kind === "reject") {
      const accept = req.headers.accept ?? "";
      if (accept.includes("text/html") && !req.url?.startsWith("/api")) {
        res.writeHead(route.status, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>分享</title><p style="font:15px system-ui;padding:24px">${route.message}</p>`);
      } else {
        res.writeHead(route.status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: route.message }));
      }
      return;
    }
    const { host, port, headers } = this.upstream(route, req);
    const proxyReq = http.request({ host, port, method: req.method, path: route.path, headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
      // 上游（网关重启、停止分享）断了，访客这边的长连接（事件流）也断开，页面才会重连
      proxyRes.on("close", () => {
        if (!res.writableEnded) res.destroy();
      });
    });
    proxyReq.on("error", (err) => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: route.kind === "client" ? `页面服务连不上：${err.message}` : `网关连不上：${err.message}` }));
    });
    // 访客关掉页面时取消上游的请求（事件流不会自己结束）
    res.on("close", () => proxyReq.destroy());
    if (route.kind === "gateway" && route.token) this.track(route.token, res, res);
    req.pipe(proxyReq);
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const route = this.route(req);
    if (route.kind === "reject") {
      socket.end(`HTTP/1.1 ${route.status} ${http.STATUS_CODES[route.status] ?? ""}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      return;
    }
    const { host, port, headers } = this.upstream(route, req);
    const upstream = net.connect({ host, port, autoSelectFamily: true }, () => {
      let raw = `${req.method ?? "GET"} ${route.path} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) raw += `${key}: ${v}\r\n`;
      }
      upstream.write(`${raw}\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const destroy = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", destroy);
    socket.on("error", destroy);
    upstream.on("close", destroy);
    socket.on("close", destroy);
    if (route.kind === "gateway" && route.token) this.track(route.token, { destroy }, socket);
  }

  /** 上游地址和转发的请求头：Host 换成上游自己的（Vite 只认本机的 Host），令牌换成校验过的，网关设了 API_TOKEN 时补上 */
  private upstream(route: Exclude<Route, { kind: "reject" }>, req: IncomingMessage): { host: string; port: number; headers: OutgoingHttpHeaders } {
    const headers: OutgoingHttpHeaders = { ...req.headers };
    delete headers.authorization;
    delete headers["x-share-token"];
    if (route.kind === "client") {
      const target = new URL(config.shareClientUrl);
      headers.host = target.host;
      // Vite 的 WebSocket（HMR）检查 Origin 是不是它自己
      if (headers.origin) headers.origin = target.origin;
      return { host: target.hostname, port: Number(target.port) || 80, headers };
    }
    const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    headers.host = `${host}:${config.port}`;
    if (route.token) headers["x-share-token"] = route.token;
    if (config.apiToken) headers.authorization = `Bearer ${config.apiToken}`;
    return { host, port: config.port, headers };
  }
}

type Route =
  | { kind: "reject"; status: number; message: string }
  | { kind: "client"; path: string }
  | { kind: "gateway"; path: string; token: string | null };

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 访客能用的接口（路径去掉了 /api）：这个会话自己的、输入框和右侧面板用到的。见 docs/lan-share.md 的表 */
const GLOBAL_GET = new Set(["/config", "/models", "/capabilities", "/external/tabs", "/health", "/share/info"]);

export function allowed(method: string, path: string, sessionId: string): boolean {
  if (GLOBAL_GET.has(path)) return method === "GET" || method === "HEAD";
  if (path === "/uploads") return method === "POST";
  if (path === "/share/browser") return true;
  if (/^\/(files|terminals)(\/|$)/.test(path)) return true;
  const m = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return false;
  let id: string;
  try {
    id = decodeURIComponent(m[1]!);
  } catch {
    return false;
  }
  if (id !== sessionId) return false;
  const rest = m[2] ?? "";
  // 会话本身只能读：重命名（PATCH）、删除（DELETE）不行；分叉出来的新会话不在分享里；开关分享是本机的事
  if (rest === "") return method === "GET";
  return rest !== "/fork" && rest !== "/share";
}
