import type { WebSocket } from "ws";

/** playwright-core 的 ConnectOverCDPTransport：send / close 由这里实现，onmessage / onclose 由 Playwright 连接时挂上 */
export interface CdpTransport {
  send(message: object): void;
  close(): void;
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
}

/**
 * 内置浏览器标签页的变化和是谁做的，桌面版发来（desktop/src/browser/views.ts 的 TabEvent，两边各写一份）：
 * - opened：agent（AI 用 newPage 开的）、user（用户点面板的「+」、右键「新标签页打开」）、
 *   agent-input / user-input（网页弹出的，弹出前 AI / 用户刚在原标签页上点击或按键）、page（网页自己弹出的）
 * - closed：agent（AI 用 page.close）、user（用户点标签上的 ×）、turn-end（一轮结束自动关的临时标签页）、page（网页 window.close 或崩溃）
 * - navigated：user（用户在地址栏跳转、点后退、前进、刷新；action 是哪一种）
 */
export interface TabEvent {
  kind: "opened" | "closed" | "navigated";
  by: "agent" | "user" | "agent-input" | "user-input" | "page" | "turn-end";
  tabId: string;
  url: string;
  title: string;
  openerId?: string;
  action?: "address" | "back" | "forward" | "reload";
}

/** 每个会话最多攒多少条没告诉模型的标签页变化 */
const MAX_TAB_EVENTS = 50;

/**
 * 桌面版外壳（内置浏览器所在的地方）连到网关的那条 WebSocket（/browser/host），见 desktop/src/browser/bridge.ts。
 * 每个对话会话的 Playwright 连接经它收发 CDP 消息，外壳那边由这个会话的 CDP 代理接着，只看得到这个会话的标签页
 */
export class BrowserHost {
  private socket: WebSocket | null = null;
  private readonly transports = new Map<string, CdpTransport>();
  private nextId = 1;
  private readonly waiting = new Map<number, (tab: { title: string; url: string } | null) => void>();
  /** 每个会话还没告诉模型的标签页变化（BrowserRepl 下一次调用时取走） */
  private readonly tabEvents = new Map<string, TabEvent[]>();

  get connected(): boolean {
    return this.socket !== null;
  }

  /** 外壳连上来了；同时只认一个，新的顶掉旧的 */
  attach(socket: WebSocket): void {
    this.socket?.close();
    this.dropAll("桌面版重新连接了");
    this.socket = socket;
    socket.on("message", (data) => {
      let msg: { type?: string; session?: string; message?: object; id?: number; tab?: { title: string; url: string } | null; event?: TabEvent };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "cdp" && msg.session && msg.message) this.transports.get(msg.session)?.onmessage?.(msg.message);
      else if (msg.type === "tabEvent" && msg.session && msg.event) {
        const list = this.tabEvents.get(msg.session) ?? [];
        if (list.length < MAX_TAB_EVENTS) list.push(msg.event);
        this.tabEvents.set(msg.session, list);
      }
      else if (msg.type === "kept" && typeof msg.id === "number") {
        this.waiting.get(msg.id)?.(msg.tab ?? null);
        this.waiting.delete(msg.id);
      }
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.dropAll("桌面版断开了");
      for (const resolve of this.waiting.values()) resolve(null);
      this.waiting.clear();
    });
  }

  /** 取走这个会话还没告诉模型的标签页变化 */
  takeTabEvents(sessionId: string): TabEvent[] {
    const list = this.tabEvents.get(sessionId) ?? [];
    this.tabEvents.delete(sessionId);
    return list;
  }

  /** 一轮结束：外壳关掉这个会话里 AI 开的、没留下的临时标签页 */
  turnEnded(sessionId: string): void {
    this.post({ type: "turnEnded", session: sessionId });
  }

  /** browser_keep_tab：把这个会话里 AI 最近操作过的标签页留给用户，返回它的标题和网址 */
  keep(sessionId: string): Promise<{ title: string; url: string } | null> {
    if (!this.socket) return Promise.reject(new Error("内置浏览器只在桌面版里有：桌面版没有运行"));
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.post({ type: "keep", session: sessionId, id });
      setTimeout(() => {
        if (this.waiting.delete(id)) resolve(null);
      }, 5000);
    });
  }

  private post(msg: object): void {
    const socket = this.socket;
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  /** 给一个对话会话开一条 CDP 通道（这个会话原来的会断开） */
  transport(sessionId: string): CdpTransport {
    const socket = this.socket;
    if (!socket) throw new Error("内置浏览器只在桌面版里有：桌面版没有运行，或者还没连上网关");
    this.transports.get(sessionId)?.onclose?.("同一个会话开了新的连接");
    const post = (msg: object) => {
      if (this.socket === socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const transport: CdpTransport = {
      send: (message) => post({ type: "cdp", session: sessionId, message }),
      close: () => {
        if (this.transports.get(sessionId) !== transport) return;
        this.transports.delete(sessionId);
        post({ type: "close", session: sessionId });
      },
    };
    this.transports.set(sessionId, transport);
    post({ type: "open", session: sessionId });
    return transport;
  }

  private dropAll(reason: string): void {
    const all = [...this.transports.values()];
    this.transports.clear();
    for (const t of all) t.onclose?.(reason);
  }
}
