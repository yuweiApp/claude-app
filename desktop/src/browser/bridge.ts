import { app } from "electron";
import { CdpProxy } from "./cdp-proxy.js";
import type { BrowserViews } from "./views.js";

/**
 * 外壳和网关之间的连接（WebSocket，外壳连网关的 /browser/host）。AI 的浏览器工具（Playwright MCP）在网关里，
 * 每个对话会话一条 Playwright 连接，经这里转给这个会话的 CDP 代理。消息：
 * - 网关 → 外壳：{ type: "open", session }（新的 Playwright 连接）、{ type: "cdp", session, message }、{ type: "close", session }、
 *   { type: "turnEnded", session }（一轮结束，关掉 AI 的临时标签页）、{ type: "keep", session, id }（browser_keep_tab）、
 *   { type: "closeSession", session }（会话删除了，关掉它的所有标签页）、
 *   { type: "temporary", session, id }（问这个会话现在有哪些临时标签页）、
 *   { type: "sessionDir", session, dir }（会话的工作目录，回答下面的问题；网关不知道这个会话时 dir 是 null）
 * - 外壳 → 网关：{ type: "hello", pids }（连上时发，外壳的进程号：网关的桌面工具不能读取、操作这些进程的窗口，见 docs/agent-desktop.md 6.1）、
 *   { type: "cdp", session, message }、{ type: "kept", id, tab }（tab 是留下的标签页的标题和网址，没有可留的是 null）、
 *   { type: "temporary", id, tabs }（还没留下的临时标签页的标题、网址，latest 标出 AI 最近操作过的那个）、
 *   { type: "tabEvent", session, event }（标签页新开、关闭、用户跳转，带上是谁做的，见 views.ts 的 TabEvent）、
 *   { type: "sessionDir", session }（问会话的工作目录：下载存到那里。连上时问有标签页的会话，之后会话有了第一个标签页时问）
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
  ) {
    // 标签页的变化和是谁做的（views.ts 的 TabEvent），网关记下来，模型下一次调用浏览器工具时告诉它
    views.on("tabEvent", (session, event) => this.post({ type: "tabEvent", session, event }));
    views.on("created", (tab) => {
      if (!views.hasSessionDir(tab.sessionId)) this.post({ type: "sessionDir", session: tab.sessionId });
    });
  }

  start(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.log("内置浏览器已连上网关");
      // 窗口在系统无障碍接口里报的是主进程号；子进程（渲染、GPU）也带上，宁可多拦
      const pids = new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]);
      this.post({ type: "hello", pids: [...pids] });
      // 网关重启后会话的目录可能变了（WORKSPACE_DIR 改了），有标签页的会话都重新问一遍
      for (const session of new Set(this.views.list().map((t) => t.sessionId))) this.post({ type: "sessionDir", session });
    });
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
    let msg: { type?: string; session?: string; message?: object; id?: number; dir?: string | null };
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
    } else if (msg.type === "closeSession") {
      this.views.closeSession(session);
    } else if (msg.type === "turnEnded") {
      this.views.turnEnded(session);
    } else if (msg.type === "keep") {
      const tab = this.views.keepLatest(session);
      this.post({ type: "kept", id: msg.id, tab: tab && { title: tab.title, url: tab.url } });
    } else if (msg.type === "sessionDir") {
      this.views.setSessionDir(session, typeof msg.dir === "string" ? msg.dir : null);
    } else if (msg.type === "temporary") {
      this.post({ type: "temporary", id: msg.id, tabs: this.views.temporaryTabs(session) });
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
