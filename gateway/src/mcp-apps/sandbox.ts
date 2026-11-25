import http from "node:http";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { McpAppCsp } from "../shared/types.js";

/**
 * MCP Apps 的沙箱代理（规范「Sandbox proxy」，两层 iframe 的外层），见 docs/mcp-apps.md 5.1 节。
 * 网关另开一个端口（MCP_APPS_SANDBOX_PORT）只提供这一个静态页，和网页不同源：
 * 网页把它嵌成外层 iframe，它收到界面的 HTML 后建内层 iframe 装进去，之后双向转发 JSON-RPC。
 * CSP 按地址里的 ?csp=（资源 _meta.ui.csp 的 JSON）设成 HTTP 头，内层用 document.write 写入，源和 CSP 都跟代理页走。
 *
 * 代理页的脚本和 CSP 规则照搬官方 @modelcontextprotocol/ext-apps 仓库的 examples/basic-host（src/sandbox.ts、serve.ts），
 * 许可证 Apache-2.0（部分 MIT），https://github.com/modelcontextprotocol/ext-apps 。
 * 改动：允许嵌入的地址（官方只认 localhost / 127.0.0.1）改成本项目网页、局域网分享入口的端口；
 * buildAllowAttribute 照 SDK 的同名函数写进脚本（SDK 是给浏览器打包的模块，网关不依赖它）
 */

/** 去掉能跳出指令、注入关键字的地址（分号、换行、引号、空格），同官方 serve.ts 的 sanitizeCspDomains */
function sanitizeCspDomains(domains?: string[]): string[] {
  if (!domains) return [];
  return domains.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
}

/** 按资源声明的地址生成 CSP，同官方 serve.ts 的 buildCspHeader。单层显示（公网分享的访客）时网页把它放进 <meta> */
export function buildCsp(csp?: McpAppCsp): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(" ");
  const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(" ");
  const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(" ") || null;
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(" ") || null;
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `media-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ].join("; ");
}

/** 地址里的 ?csp=：解析不了、不是对象的当作没声明 */
function cspOf(url: URL): McpAppCsp | undefined {
  const raw = url.searchParams.get("csp");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as McpAppCsp) : undefined;
  } catch {
    return undefined;
  }
}

/** 允许嵌入代理页的网页端口：本机网页（SHARE_CLIENT_URL，开发时是 Vite）和局域网分享的入口 */
function embedderPorts(): string[] {
  const client = new URL(config.shareClientUrl);
  return [...new Set([client.port || (client.protocol === "https:" ? "443" : "80"), String(config.sharePort)])];
}

/** 代理页的脚本：官方 examples/basic-host/src/sandbox.ts 的 JavaScript 版 */
const PROXY_SCRIPT = String.raw`(function () {
  var PORTS = __PORTS__;
  if (window.self === window.top) throw new Error("This file is only to be used in an iframe sandbox.");
  if (!document.referrer) throw new Error("No referrer, cannot validate embedding site.");
  var ref = new URL(document.referrer);
  var loopback = function (h) { return h === "localhost" || h === "127.0.0.1" || h === "[::1]"; };
  var refPort = ref.port || (ref.protocol === "https:" ? "443" : "80");
  // 网页按自己的主机名拼代理页的地址：主机名要一样（都是本机的算一样），端口要是本项目网页或局域网分享的入口
  var sameHost = ref.hostname === location.hostname || (loopback(ref.hostname) && loopback(location.hostname));
  if (!sameHost || PORTS.indexOf(refPort) < 0) throw new Error("Embedding domain not allowed in referrer " + document.referrer + ".");
  var EXPECTED_HOST_ORIGIN = ref.origin;
  var OWN_ORIGIN = location.origin;

  // 隔离自检：能访问 window.top 说明沙箱没生效
  try {
    window.top.alert("If you see this, the sandbox is not setup securely.");
    throw "FAIL";
  } catch (e) {
    if (e === "FAIL") throw new Error("The sandbox is not setup securely.");
  }

  // 同 SDK 的 buildAllowAttribute
  function buildAllowAttribute(p) {
    if (!p) return "";
    var list = [];
    if (p.camera) list.push("camera");
    if (p.microphone) list.push("microphone");
    if (p.geolocation) list.push("geolocation");
    if (p.clipboardWrite) list.push("clipboard-write");
    return list.join("; ");
  }

  var inner = document.createElement("iframe");
  inner.style = "width:100%; height:100%; border:none;";
  inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  document.body.appendChild(inner);

  var RESOURCE_READY = "ui/notifications/sandbox-resource-ready";
  var PROXY_READY = "ui/notifications/sandbox-proxy-ready";

  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (event.origin !== EXPECTED_HOST_ORIGIN) {
        console.error("[Sandbox] Rejecting message from unexpected origin:", event.origin, "expected:", EXPECTED_HOST_ORIGIN);
        return;
      }
      if (event.data && event.data.method === RESOURCE_READY) {
        var params = event.data.params || {};
        if (typeof params.sandbox === "string") inner.setAttribute("sandbox", params.sandbox);
        var allow = buildAllowAttribute(params.permissions);
        if (allow) inner.setAttribute("allow", allow);
        if (typeof params.html === "string") {
          // 用 document.write，不用 srcdoc（官方注释：CesiumJS 在 srcdoc 里不能用）
          var doc = inner.contentDocument || (inner.contentWindow && inner.contentWindow.document);
          if (doc) {
            doc.open();
            doc.write(params.html);
            doc.close();
          } else {
            inner.srcdoc = params.html;
          }
        }
      } else if (inner.contentWindow) {
        inner.contentWindow.postMessage(event.data, "*");
      }
    } else if (event.source === inner.contentWindow) {
      if (event.origin !== OWN_ORIGIN) {
        console.error("[Sandbox] Rejecting message from inner iframe with unexpected origin:", event.origin, "expected:", OWN_ORIGIN);
        return;
      }
      window.parent.postMessage(event.data, EXPECTED_HOST_ORIGIN);
    }
  });

  window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, EXPECTED_HOST_ORIGIN);
})();`;

function proxyPage(): string {
  const script = PROXY_SCRIPT.replace("__PORTS__", JSON.stringify(embedderPorts()));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent}</style></head><body><script>${script}</script></body></html>`;
}

/**
 * 代理页的监听：开了 MCP Apps 才有。平时只监听网关自己的地址（HOST），局域网分享开着时改成 0.0.0.0（访客的浏览器要直接连它）。
 * 端口被占用等监听失败只记日志，listening 为 false，网页退回单层显示
 */
export class SandboxServer {
  private server: http.Server | null = null;
  private host: string | null = null;
  private syncing: Promise<void> = Promise.resolve();

  constructor(private readonly log: FastifyBaseLogger) {}

  get listening(): boolean {
    return this.server !== null;
  }

  readonly port = config.mcpAppsSandboxPort;

  /** lan：局域网分享的入口在不在监听 */
  sync(lan: boolean): Promise<void> {
    const host = lan ? "0.0.0.0" : config.host;
    this.syncing = this.syncing.then(async () => {
      if (this.server && this.host === host) return;
      await this.stop();
      await this.start(host);
    });
    return this.syncing;
  }

  async close(): Promise<void> {
    await this.syncing;
    await this.stop();
  }

  private start(host: string): Promise<void> {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://sandbox");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname !== "/" && url.pathname !== "/sandbox.html") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // HTTP 头里的 CSP 界面改不了（<meta> 的可以被界面自己的 HTML 影响）
        "content-security-policy": buildCsp(cspOf(url)),
        "cache-control": "no-cache, no-store, must-revalidate",
        pragma: "no-cache",
        expires: "0",
        "x-content-type-options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : proxyPage());
    });
    return new Promise((resolve) => {
      server.once("error", (err) => {
        this.log.error({ err, host, port: this.port }, `MCP Apps 沙箱代理端口 ${this.port} 监听失败，界面改用单层显示`);
        resolve();
      });
      server.listen(this.port, host, () => {
        this.server = server;
        this.host = host;
        this.log.info({ host, port: this.port }, "MCP Apps 沙箱代理已开始监听");
        resolve();
      });
    });
  }

  private async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.host = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
