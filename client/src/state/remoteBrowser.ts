import { createContext } from "react";
import { withToken } from "../api";
import type { BrowserDownload, BrowserPickedElement, BrowserSuggestion, BrowserTabInfo, DesktopBrowserApi } from "../desktop";

/** 访客的一次输入，坐标是网页的 CSS 像素；modifiers 同 CDP（Alt 1、Ctrl 2、Meta 4、Shift 8）。和 desktop/src/browser/share-stream.ts 的 ShareInput 一致 */
export type RemoteInput =
  | { type: "mouse"; kind: "down" | "up" | "move"; x: number; y: number; button: "left" | "middle" | "right" | "none"; buttons: number; clickCount: number; modifiers: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { type: "key"; kind: "down" | "up"; key: string; code: string; keyCode: number; text?: string; modifiers: number }
  | { type: "text"; text: string };

/** 一帧画面：JPEG 的 data URL，width / height 是网页视口的 CSS 像素（换算鼠标坐标用） */
export interface RemoteFrame {
  url: string;
  width: number;
  height: number;
}

type Listener<T> = (value: T) => void;

/**
 * 局域网分享的访客操作分享方的内置浏览器（见 docs/lan-share.md「内置浏览器」）：经 WebSocket（/api/share/browser）连网关，
 * 网关转给分享方的桌面版。实现和桌面版一样的 DesktopBrowserApi（右侧面板的标签页逻辑照用），
 * 网页画面不是原生视图，而是推过来的截图（watch），输入经 input 发回去，见 RemoteBrowserTab。
 * 下载、选择元素没有（下载存在会话的工作目录里，文件树里看得到）
 */
export class RemoteBrowser implements DesktopBrowserApi {
  private socket: WebSocket | null = null;
  private disposed = false;
  private tabs: BrowserTabInfo[] | null = null;
  private readonly tabListeners = new Set<Listener<BrowserTabInfo[]>>();
  private readonly activateListeners = new Set<Listener<string>>();
  private readonly shellListeners = new Set<Listener<boolean>>();
  /** 分享方的桌面版连着网关没有（内置浏览器在那里）；null 是还不知道 */
  shellConnected: boolean | null = null;
  /** 每个标签页的画面、鼠标指针的订阅（同一个标签页可能有几个） */
  private readonly frameListeners = new Map<string, Set<{ frame: Listener<RemoteFrame>; cursor: Listener<string> }>>();
  private readonly waiting = new Map<number, Listener<unknown>>();
  private nextReq = 1;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retry);
    this.socket?.close();
  }

  private connect(): void {
    if (this.disposed) return;
    const url = new URL(withToken("/share/browser"), location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      // 重连后重新要画面
      for (const id of this.frameListeners.keys()) this.send({ type: "frames", id, on: true });
    };
    socket.onmessage = (e) => this.onMessage(String(e.data));
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const resolve of this.waiting.values()) resolve(null);
      this.waiting.clear();
      if (!this.disposed) this.retry = setTimeout(() => this.connect(), 2000);
    };
  }

  private onMessage(data: string): void {
    let msg: { type?: string; tabs?: BrowserTabInfo[]; id?: string; data?: string; width?: number; height?: number; cursor?: string; reqId?: number; result?: unknown; connected?: boolean };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "tabs" && Array.isArray(msg.tabs)) {
      this.tabs = msg.tabs;
      this.tabListeners.forEach((l) => l(msg.tabs!));
      // 网关要先知道标签页属于这个会话才转发画面请求：列表到了再要一次（重复的网关不理）
      for (const id of this.frameListeners.keys()) this.send({ type: "frames", id, on: true });
    } else if (msg.type === "frame" && msg.id && msg.data) {
      const frame = { url: `data:image/jpeg;base64,${msg.data}`, width: msg.width ?? 0, height: msg.height ?? 0 };
      this.frameListeners.get(msg.id)?.forEach((l) => l.frame(frame));
    } else if (msg.type === "cursor" && msg.id && msg.cursor) {
      this.frameListeners.get(msg.id)?.forEach((l) => l.cursor(msg.cursor!));
    } else if (msg.type === "activate" && msg.id) {
      this.activateListeners.forEach((l) => l(msg.id!));
    } else if (msg.type === "shell") {
      this.shellConnected = !!msg.connected;
      this.shellListeners.forEach((l) => l(this.shellConnected!));
    } else if (msg.type === "reply" && typeof msg.reqId === "number") {
      this.waiting.get(msg.reqId)?.(msg.result);
      this.waiting.delete(msg.reqId);
    }
  }

  private send(msg: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private request<T>(msg: object): Promise<T | null> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      this.waiting.set(reqId, (value) => resolve((value as T | null) ?? null));
      this.send({ ...msg, reqId });
    });
  }

  list(): Promise<BrowserTabInfo[]> {
    if (this.tabs) return Promise.resolve(this.tabs);
    return new Promise((resolve) => {
      const off = this.onTabs((tabs) => {
        off();
        resolve(tabs);
      });
    });
  }

  create(_sessionId: string, url?: string): Promise<BrowserTabInfo | null> {
    return this.request<BrowserTabInfo>({ type: "create", url: url ?? "" });
  }

  close(id: string): void {
    this.send({ type: "close", id });
  }

  navigate(id: string, url: string): void {
    this.send({ type: "navigate", id, url });
  }

  go(id: string, action: "back" | "forward" | "reload" | "stop"): void {
    this.send({ type: "go", id, action });
  }

  /** 没有原生视图，显示位置不用告诉谁 */
  show(): void {}
  hide(): void {}

  snapshot(): Promise<string | null> {
    return Promise.resolve(null);
  }

  suggest = (query: string): Promise<BrowserSuggestion[]> => this.request<BrowserSuggestion[]>({ type: "suggest", query }).then((list) => list ?? []);

  onTabs(callback: Listener<BrowserTabInfo[]>): () => void {
    this.tabListeners.add(callback);
    return () => void this.tabListeners.delete(callback);
  }

  onActivate(callback: Listener<string>): () => void {
    this.activateListeners.add(callback);
    return () => void this.activateListeners.delete(callback);
  }

  onShell(callback: Listener<boolean>): () => void {
    this.shellListeners.add(callback);
    return () => void this.shellListeners.delete(callback);
  }

  downloads(): Promise<BrowserDownload[]> {
    return Promise.resolve([]);
  }

  onDownload(): () => void {
    return () => undefined;
  }

  downloadAction(): Promise<boolean> {
    return Promise.resolve(false);
  }

  inspect(): Promise<boolean> {
    return Promise.resolve(false);
  }

  onPicked(_callback: Listener<BrowserPickedElement>): () => void {
    return () => undefined;
  }

  onInspectEnded(): () => void {
    return () => undefined;
  }

  /** 看这个标签页的画面；返回取消的函数（没人看了网关就让桌面版停止截图） */
  watch(id: string, frame: Listener<RemoteFrame>, cursor: Listener<string>): () => void {
    let set = this.frameListeners.get(id);
    if (!set) {
      this.frameListeners.set(id, (set = new Set()));
      this.send({ type: "frames", id, on: true });
    }
    const entry = { frame, cursor };
    set.add(entry);
    return () => {
      set.delete(entry);
      if (set.size || this.frameListeners.get(id) !== set) return;
      this.frameListeners.delete(id);
      this.send({ type: "frames", id, on: false });
    };
  }

  input(id: string, event: RemoteInput): void {
    this.send({ type: "input", id, event });
  }
}

/** 访客页面（ShareApp）提供，右侧面板据此用 RemoteBrowser 代替桌面版的内置浏览器；本机的界面没有，是 null */
export const RemoteBrowserContext = createContext<RemoteBrowser | null>(null);
