import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { config } from "../config.js";

/**
 * 远端 claude 的模型请求经 SSH 反向转发回到这里，再由网关发给真正的模型接口（.env.local 的 ANTHROPIC_BASE_URL）：
 * 远端只拿到一个临时令牌（每次连接新生成），真正的 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY、自定义请求头不出本机，
 * 远端也不用能访问模型接口。不在网关的 HTTP 端口上开接口，转发进来的连接直接交给这里的 http.Server（不监听端口）
 */
export interface ModelProxy {
  token: string;
  /** 一条转发进来的连接 */
  handle(stream: Duplex): void;
}

/** 不往上游转的请求头：逐跳的、远端的认证 */
const DROP_HEADERS = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "authorization", "x-api-key"]);

export function createModelProxy(): ModelProxy {
  const token = `claude-app-ssh-${randomBytes(24).toString("base64url")}`;
  const server = http.createServer((req, res) => void forward(req, res, token));
  return {
    token,
    handle(stream) {
      // http.Server 要的是 net.Socket，SSH 通道上没有的方法补成空的
      const s = stream as Duplex & Record<string, unknown>;
      for (const m of ["setTimeout", "setNoDelay", "setKeepAlive", "ref", "unref"]) if (typeof s[m] !== "function") s[m] = () => s;
      s.remoteAddress ??= "127.0.0.1";
      server.emit("connection", stream);
    },
  };
}

function authorized(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  const given = req.headers["x-api-key"] ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : undefined);
  if (typeof given !== "string" || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

async function forward(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  if (!authorized(req, token)) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "claude-app 网关：令牌不对" } }));
    return;
  }
  const base = new URL(config.baseUrl ?? "https://api.anthropic.com");
  const target = new URL(base.pathname.replace(/\/+$/, "") + (req.url ?? "/"), base);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.has(k) && v !== undefined) headers[k] = v;
  headers.host = target.host;
  const env = process.env;
  if (env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
  else if (env.ANTHROPIC_API_KEY) headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  // ANTHROPIC_CUSTOM_HEADERS：一行一个「名称: 值」，Claude Code 本来会自己加，远端没有它，这里补上
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const upstream = (target.protocol === "https:" ? https : http).request(target, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.statusMessage, filterResponseHeaders(up.headers));
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `claude-app 网关转发模型请求失败：${err.message}` } }));
  });
  // 远端断开（打断、进程退出）时上游请求一起断，不再计费
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

function filterResponseHeaders(h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !["connection", "keep-alive", "transfer-encoding"].includes(k)) out[k] = v;
  return out;
}
