import { CdpProxy } from "./cdp-proxy.js";
import type { BrowserViews } from "./views.js";

/**
 * 外壳和网关之间的连接（WebSocket，外壳连网关的 /browser/host）。AI 的浏览器工具（Playwright MCP）在网关里，
 * 每个对话会话一条 Playwright 连接，经这里转给这个会话的 CDP 代理。消息：
 * - 网关 → 外壳：{ type: "open", session }（新的 Playwright 连接）、{ type: "cdp", session, message }、{ type: "close", session }、
 *   { type: "turnEnded", session }（一轮结束，关掉 AI 的临时标签页）、{ type: "keep", session, id }（browser_keep_tab）
 * - 外壳 → 网关：{ type: "cdp", session, message }、{ type: "kept", id, tab }（tab 是留下的标签页的标题和网址，没有可留的是 null）
 * 网关重启、还没起来时每 2 秒重连
 */
export class GatewayBridge {
  private socket: WebSocket | null = null;
  private readonly proxies = new Map<string, CdpProxy>();
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly views: BrowserViews,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => this.log("内置浏览器已连上网关"));
    socket.addEventListener("message", (e) => this.onMessage(String(e.data)));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.closeAll();
      if (!this.stopped) setTimeout(() => this.start(), 2000);
    });
    // error 之后一定还会有 close，重连在那里做
    socket.addEventListener("error", () => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.closeAll();
    this.socket?.close();
  }

  private onMessage(data: string): void {
    let msg: { type?: string; session?: string; message?: object; id?: number };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const session = msg.session;
    if (!session) return;
    if (msg.type === "open") {
      this.proxies.get(session)?.dispose();
      this.proxies.set(session, new CdpProxy(session, this.views, (message) => this.post({ type: "cdp", session, message })));
    } else if (msg.type === "close") {
      this.proxies.get(session)?.dispose();
      this.proxies.delete(session);
    } else if (msg.type === "cdp" && msg.message) {
      this.proxies.get(session)?.handle(msg.message);
    } else if (msg.type === "turnEnded") {
      this.views.turnEnded(session);
    } else if (msg.type === "keep") {
      const tab = this.views.keepLatest(session);
      this.post({ type: "kept", id: msg.id, tab: tab && { title: tab.title, url: tab.url } });
    }
  }

  private post(msg: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private closeAll(): void {
    for (const proxy of this.proxies.values()) proxy.dispose();
    this.proxies.clear();
  }
}
