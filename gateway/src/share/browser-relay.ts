import type { WebSocket } from "ws";
import type { BrowserHost, ShareShellMessage } from "../browser/host.js";
import type { ShareStore } from "./store.js";

/**
 * 局域网分享的访客操作内置浏览器（见 docs/lan-share.md「内置浏览器」）：访客的页面经 WebSocket（/share/browser）连到这里，
 * 这里把它要的转给桌面版外壳（经 BrowserHost 原有的那条连接，share 开头的消息，见 desktop/src/browser/share-stream.ts），
 * 外壳推来的标签页列表、画面转给看着的访客。几个访客看同一个会话、同一个标签页时，外壳那边只推一份。
 *
 * 访客 → 这里：frames { id, on }（看 / 不看这个标签页的画面）、create { url, reqId }、suggest { query, reqId }、
 *   close { id }、navigate { id, url }、go { id, action }、input { id, event }
 * 这里 → 访客：shell { connected }、tabs { tabs }、frame { id, data, width, height }、cursor { id, cursor }、activate { id }、reply { reqId, result }
 */
interface Viewer {
  socket: WebSocket;
  token: string;
  sessionId: string;
  /** 在看画面的标签页 */
  frames: Set<string>;
}

/** 发给一个访客时还没发出去的字节数超过这么多，画面这一帧不给他 */
const MAX_VIEWER_BACKLOG = 4 * 1024 * 1024;

export class ShareBrowserRelay {
  private readonly viewers = new Set<Viewer>();
  /** 每个会话最近一次的标签页列表（外壳推来的），校验访客操作的标签页是不是这个会话的 */
  private readonly tabs = new Map<string, { id: string }[]>();
  /** 等外壳回复的请求：网关这边的编号 → 哪个访客的哪个请求 */
  private readonly pending = new Map<number, { viewer: Viewer; reqId: unknown }>();
  private nextReq = 1;

  constructor(
    private readonly host: BrowserHost,
    private readonly shares: ShareStore,
  ) {
    host.onShare(
      (msg) => this.fromShell(msg),
      (connected) => {
        for (const v of this.viewers) send(v, { type: "shell", connected });
        // 外壳重连了：重新要列表和画面
        if (connected) this.resync();
      },
    );
    // 停止分享、会话清空后分享换了 id：访客的连接断开（页面按新的会话重连）
    shares.onChange(() => {
      for (const v of [...this.viewers]) {
        if (this.shares.byToken(v.token)?.sessionId !== v.sessionId) v.socket.close();
      }
    });
  }

  connect(socket: WebSocket, token: string | undefined): void {
    const share = this.shares.byToken(token);
    if (!share || !token) {
      socket.close(4401, "分享已结束或链接无效");
      return;
    }
    const viewer: Viewer = { socket, token, sessionId: share.sessionId, frames: new Set() };
    const firstOfSession = !this.watchers(viewer.sessionId);
    this.viewers.add(viewer);
    send(viewer, { type: "shell", connected: this.host.connected });
    if (firstOfSession) this.host.postShare({ type: "shareWatch", session: viewer.sessionId });
    else send(viewer, { type: "tabs", tabs: this.tabs.get(viewer.sessionId) ?? [] });
    socket.on("message", (data) => {
      let msg: { type?: string; id?: unknown; on?: unknown; url?: unknown; query?: unknown; action?: unknown; event?: unknown; reqId?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.fromViewer(viewer, msg);
    });
    socket.on("close", () => this.drop(viewer));
  }

  private fromViewer(viewer: Viewer, msg: { type?: string; id?: unknown; on?: unknown; url?: unknown; query?: unknown; action?: unknown; event?: unknown; reqId?: unknown }): void {
    if (msg.type === "create") {
      const reqId = this.request(viewer, msg.reqId);
      this.host.postShare({ type: "shareCreate", session: viewer.sessionId, url: typeof msg.url === "string" ? msg.url : "", reqId });
      return;
    }
    if (msg.type === "suggest") {
      const reqId = this.request(viewer, msg.reqId);
      this.host.postShare({ type: "shareSuggest", query: typeof msg.query === "string" ? msg.query : "", reqId });
      return;
    }
    // 下面的都是对某个标签页的：只能是这个会话的
    const id = typeof msg.id === "string" ? msg.id : null;
    if (!id || !this.tabs.get(viewer.sessionId)?.some((t) => t.id === id)) return;
    if (msg.type === "frames") {
      if (msg.on === true && !viewer.frames.has(id)) {
        const first = !this.frameWatchers(id);
        viewer.frames.add(id);
        if (first) this.host.postShare({ type: "shareFrames", id, on: true });
      } else if (msg.on === false && viewer.frames.delete(id) && !this.frameWatchers(id)) {
        this.host.postShare({ type: "shareFrames", id, on: false });
      }
    } else if (msg.type === "close") this.host.postShare({ type: "shareClose", id });
    else if (msg.type === "navigate" && typeof msg.url === "string") this.host.postShare({ type: "shareNavigate", id, url: msg.url });
    else if (msg.type === "go" && typeof msg.action === "string") this.host.postShare({ type: "shareGo", id, action: msg.action });
    else if (msg.type === "input" && msg.event && typeof msg.event === "object") this.host.postShare({ type: "shareInput", id, event: msg.event });
  }

  private fromShell(msg: ShareShellMessage): void {
    if (msg.type === "shareTabs" && msg.session && Array.isArray(msg.tabs)) {
      const tabs = msg.tabs as { id: string }[];
      this.tabs.set(msg.session, tabs);
      for (const v of this.viewers) if (v.sessionId === msg.session) send(v, { type: "tabs", tabs });
    } else if (msg.type === "shareFrame" && msg.id) {
      const frame = JSON.stringify({ type: "frame", id: msg.id, data: msg.data, width: msg.width, height: msg.height });
      for (const v of this.viewers) {
        if (v.frames.has(msg.id) && v.socket.bufferedAmount < MAX_VIEWER_BACKLOG) sendRaw(v, frame);
      }
    } else if (msg.type === "shareCursor" && msg.id) {
      for (const v of this.viewers) if (v.frames.has(msg.id)) send(v, { type: "cursor", id: msg.id, cursor: msg.cursor });
    } else if (msg.type === "shareActivate" && msg.session) {
      for (const v of this.viewers) if (v.sessionId === msg.session) send(v, { type: "activate", id: msg.id });
    } else if (msg.type === "shareReply" && typeof msg.reqId === "number") {
      const waiting = this.pending.get(msg.reqId);
      this.pending.delete(msg.reqId);
      if (waiting) send(waiting.viewer, { type: "reply", reqId: waiting.reqId, result: msg.result ?? null });
    }
  }

  private request(viewer: Viewer, clientReqId: unknown): number {
    const reqId = this.nextReq++;
    this.pending.set(reqId, { viewer, reqId: clientReqId });
    // 外壳没连着、没回复：10 秒后回 null
    setTimeout(() => {
      const waiting = this.pending.get(reqId);
      if (!waiting) return;
      this.pending.delete(reqId);
      send(waiting.viewer, { type: "reply", reqId: waiting.reqId, result: null });
    }, 10_000);
    return reqId;
  }

  private drop(viewer: Viewer): void {
    if (!this.viewers.delete(viewer)) return;
    for (const id of viewer.frames) if (!this.frameWatchers(id)) this.host.postShare({ type: "shareFrames", id, on: false });
    if (!this.watchers(viewer.sessionId)) {
      this.host.postShare({ type: "shareUnwatch", session: viewer.sessionId });
      this.tabs.delete(viewer.sessionId);
    }
  }

  private resync(): void {
    const sessions = new Set([...this.viewers].map((v) => v.sessionId));
    for (const session of sessions) this.host.postShare({ type: "shareWatch", session });
    const frames = new Set([...this.viewers].flatMap((v) => [...v.frames]));
    for (const id of frames) this.host.postShare({ type: "shareFrames", id, on: true });
  }

  private watchers(sessionId: string): number {
    let n = 0;
    for (const v of this.viewers) if (v.sessionId === sessionId) n++;
    return n;
  }

  private frameWatchers(id: string): number {
    let n = 0;
    for (const v of this.viewers) if (v.frames.has(id)) n++;
    return n;
  }
}

function send(viewer: Viewer, msg: object): void {
  sendRaw(viewer, JSON.stringify(msg));
}

function sendRaw(viewer: Viewer, data: string): void {
  if (viewer.socket.readyState === viewer.socket.OPEN) viewer.socket.send(data);
}
