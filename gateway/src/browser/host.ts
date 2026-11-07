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

/** 还没留下的临时标签页（desktop/src/browser/views.ts 的 temporaryTabs）；latest：AI 最近操作过的那个，browser_keep_tab 会留下它 */
export interface TemporaryTab {
  title: string;
  url: string;
  latest: boolean;
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
  /** 等外壳回复的请求（keep、temporaryTabs）：回复里的数据，断开或超时是 null */
  private readonly waiting = new Map<number, (reply: unknown) => void>();
  /** 每个会话还没告诉模型的标签页变化（BrowserRepl 下一次调用时取走） */
  private readonly tabEvents = new Map<string, TabEvent[]>();
  /** 这个会话的 worker 在运行时，标签页变化直接交给它（worker-repl.ts），不在这里攒 */
  private readonly tabListeners = new Map<string, (event: TabEvent) => void>();

  get connected(): boolean {
    return this.socket !== null;
  }

  /** 外壳连上来了；同时只认一个，新的顶掉旧的 */
  attach(socket: WebSocket): void {
    this.socket?.close();
    this.dropAll("桌面版重新连接了");
    this.socket = socket;
    socket.on("message", (data) => {
      let msg: {
        type?: string;
        session?: string;
        message?: object;
        id?: number;
        tab?: { title: string; url: string } | null;
        tabs?: TemporaryTab[];
        event?: TabEvent;
      };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "cdp" && msg.session && msg.message) this.transports.get(msg.session)?.onmessage?.(msg.message);
      else if (msg.type === "tabEvent" && msg.session && msg.event) {
        const listener = this.tabListeners.get(msg.session);
        if (listener) return listener(msg.event);
        const list = this.tabEvents.get(msg.session) ?? [];
        if (list.length < MAX_TAB_EVENTS) list.push(msg.event);
        this.tabEvents.set(msg.session, list);
      }
      else if ((msg.type === "kept" || msg.type === "temporary") && typeof msg.id === "number") {
        this.waiting.get(msg.id)?.(msg.type === "kept" ? (msg.tab ?? null) : (msg.tabs ?? null));
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

  /** 标签页变化改为直接交给 listener，先把攒着的给它；null 取消，之后的又攒在这里 */
  listenTabEvents(sessionId: string, listener: ((event: TabEvent) => void) | null): void {
    if (!listener) {
      this.tabListeners.delete(sessionId);
      return;
    }
    this.tabListeners.set(sessionId, listener);
    this.takeTabEvents(sessionId).forEach(listener);
  }

  /** 删会话：外壳关掉这个会话的所有标签页 */
  closeSession(sessionId: string): void {
    this.tabEvents.delete(sessionId);
    this.tabListeners.delete(sessionId);
    this.post({ type: "closeSession", session: sessionId });
  }

  /** 一轮结束：外壳关掉这个会话里 AI 开的、没留下的临时标签页 */
  turnEnded(sessionId: string): void {
    this.post({ type: "turnEnded", session: sessionId });
  }

  /** browser_keep_tab：把这个会话里 AI 最近操作过的标签页留给用户，返回它的标题和网址 */
  keep(sessionId: string): Promise<{ title: string; url: string } | null> {
    if (!this.socket) return Promise.reject(new Error("内置浏览器只在桌面版里有：桌面版没有运行"));
    return this.request<{ title: string; url: string }>("keep", sessionId, 5000);
  }

  /** 这个会话现在还没留下的临时标签页（一轮结束时会关）；桌面版没在运行、没回复（旧版本的桌面版）时是 null */
  temporaryTabs(sessionId: string): Promise<TemporaryTab[] | null> {
    if (!this.socket) return Promise.resolve(null);
    return this.request<TemporaryTab[]>("temporary", sessionId, 2000);
  }

  /** 发一个要外壳回复的请求，timeoutMs 内没回复是 null */
  private request<T>(type: string, sessionId: string, timeoutMs: number): Promise<T | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, (reply) => resolve((reply as T | null) ?? null));
      this.post({ type, session: sessionId, id });
      setTimeout(() => {
        if (this.waiting.delete(id)) resolve(null);
      }, timeoutMs);
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
