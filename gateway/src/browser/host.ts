import type { WebSocket } from "ws";

/** playwright-core 的 ConnectOverCDPTransport：send / close 由这里实现，onmessage / onclose 由 Playwright 连接时挂上 */
export interface CdpTransport {
  send(message: object): void;
  close(): void;
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
}

/**
 * 桌面版外壳（内置浏览器所在的地方）连到网关的那条 WebSocket（/browser/host），见 desktop/src/browser/bridge.ts。
 * 每个对话会话的 Playwright 连接经它收发 CDP 消息，外壳那边由这个会话的 CDP 代理接着，只看得到这个会话的标签页
 */
export class BrowserHost {
  private socket: WebSocket | null = null;
  private readonly transports = new Map<string, CdpTransport>();
  private nextId = 1;
  private readonly waiting = new Map<number, (tab: { title: string; url: string } | null) => void>();

  get connected(): boolean {
    return this.socket !== null;
  }

  /** 外壳连上来了；同时只认一个，新的顶掉旧的 */
  attach(socket: WebSocket): void {
    this.socket?.close();
    this.dropAll("桌面版重新连接了");
    this.socket = socket;
    socket.on("message", (data) => {
      let msg: { type?: string; session?: string; message?: object; id?: number; tab?: { title: string; url: string } | null };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "cdp" && msg.session && msg.message) this.transports.get(msg.session)?.onmessage?.(msg.message);
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
