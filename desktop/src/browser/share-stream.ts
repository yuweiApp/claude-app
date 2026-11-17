import { tabInfo, type BrowserViews, type Tab } from "./views.js";

/**
 * 局域网分享的访客操作内置浏览器（见 docs/lan-share.md「内置浏览器」）：访客那边没有外壳，
 * 这里把标签页列表、画面（JPEG）推给网关，网关转给访客；访客的鼠标、键盘经网关发回来，用调试接口注入。
 * 只在有访客看着时做事：没人看的会话不推列表，没人看的标签页不截图。
 *
 * 网关 → 外壳：shareWatch / shareUnwatch { session }（开始 / 停止推这个会话的标签页列表）、shareFrames { id, on }（开始 / 停止推这个标签页的画面）、
 *   shareCreate { session, url, reqId }、shareSuggest { query, reqId }（要回复 shareReply { reqId, result }）、
 *   shareClose { id }、shareNavigate { id, url }、shareGo { id, action }、shareInput { id, event }、
 *   shareResize { id, width, height }（访客面板的大小：本机没在显示这个标签页时网页按它排版，见 views.ts 的 fitParked）
 * 外壳 → 网关：shareTabs { session, tabs }、shareFrame { id, data, width, height }、shareCursor { id, cursor }、shareActivate { session, id }、shareReply
 */

/** 画面的间隔（毫秒），约每秒 10 帧；画面没变不发 */
const FRAME_MS = 100;
/** 画面最宽多少像素（高分屏上截出来是设备像素，缩到这个宽度再编码） */
const MAX_FRAME_WIDTH = 1600;
const JPEG_QUALITY = 70;

/** 访客的一次输入，坐标是网页的 CSS 像素；modifiers 同 CDP（Alt 1、Ctrl 2、Meta 4、Shift 8） */
export type ShareInput =
  | { type: "mouse"; kind: "down" | "up" | "move"; x: number; y: number; button: "left" | "middle" | "right" | "none"; buttons: number; clickCount: number; modifiers: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { type: "key"; kind: "down" | "up"; key: string; code: string; keyCode: number; text?: string; modifiers: number }
  | { type: "text"; text: string };

type Message = { type?: string; session?: string; id?: string; on?: boolean; url?: string; query?: string; reqId?: number; action?: string; event?: ShareInput; width?: number; height?: number };

/** 访客面板的大小限在这个范围里（CSS 像素） */
const MIN_SIZE = { width: 200, height: 150 };
const MAX_SIZE = { width: 2560, height: 1600 };

export class ShareStream {
  /** 有访客看着的会话：标签页有变化时推列表 */
  private readonly sessions = new Set<string>();
  /** 正在推画面的标签页 → 停止用的开关 */
  private readonly frames = new Map<string, { on: boolean; off: () => void }>();
  private pushTimer: NodeJS.Timeout | undefined;
  /** 访客要的网页大小（最近一次 shareResize）：本机在面板里显示过、又收回停放窗口后，截图循环里再按它改回来 */
  private readonly sizes = new Map<string, { width: number; height: number }>();

  constructor(
    private readonly views: BrowserViews,
    private readonly post: (msg: object) => void,
    /** 发给网关的还没发出去的字节数：积压时这一帧不发 */
    private readonly backlog: () => number,
  ) {
    for (const event of ["created", "closed", "changed"] as const) views.on(event, () => this.schedulePush());
    views.on("activate", (tab) => {
      if (this.sessions.has(tab.sessionId)) this.post({ type: "shareActivate", session: tab.sessionId, id: tab.id });
    });
    views.on("closed", (tab) => this.stopFrames(tab.id));
  }

  /** 网关断开了：全部停下，重连后网关会重新要 */
  stopAll(): void {
    this.sessions.clear();
    for (const id of [...this.frames.keys()]) this.stopFrames(id);
  }

  handle(msg: Message): void {
    switch (msg.type) {
      case "shareWatch":
        if (!msg.session) return;
        this.sessions.add(msg.session);
        this.pushTabs(msg.session);
        return;
      case "shareUnwatch":
        if (msg.session) this.sessions.delete(msg.session);
        return;
      case "shareFrames":
        if (!msg.id) return;
        if (msg.on) this.startFrames(msg.id);
        else this.stopFrames(msg.id);
        return;
      case "shareCreate":
        if (!msg.session) return;
        void this.views.create(msg.session, msg.url || undefined, "user").then(
          (tab) => this.post({ type: "shareReply", reqId: msg.reqId, result: tabInfo(tab) }),
          () => this.post({ type: "shareReply", reqId: msg.reqId, result: null }),
        );
        return;
      case "shareSuggest":
        this.post({ type: "shareReply", reqId: msg.reqId, result: typeof msg.query === "string" ? this.views.history.suggest(msg.query) : [] });
        return;
      case "shareClose":
        if (msg.id) this.views.close(msg.id, "user");
        return;
      case "shareNavigate":
        if (msg.id && typeof msg.url === "string") void this.views.navigate(msg.id, msg.url);
        return;
      case "shareGo":
        if (msg.id && (msg.action === "back" || msg.action === "forward" || msg.action === "reload" || msg.action === "stop")) this.views.go(msg.id, msg.action);
        return;
      case "shareInput":
        if (msg.id && msg.event) void this.input(msg.id, msg.event).catch(() => undefined);
        return;
      case "shareResize": {
        if (!msg.id || typeof msg.width !== "number" || typeof msg.height !== "number") return;
        const size = {
          width: Math.round(Math.min(MAX_SIZE.width, Math.max(MIN_SIZE.width, msg.width))),
          height: Math.round(Math.min(MAX_SIZE.height, Math.max(MIN_SIZE.height, msg.height))),
        };
        this.sizes.set(msg.id, size);
        this.views.fitParked(msg.id, size.width, size.height);
        return;
      }
    }
  }

  private schedulePush(): void {
    if (!this.sessions.size) return;
    this.pushTimer ??= setTimeout(() => {
      this.pushTimer = undefined;
      for (const session of this.sessions) this.pushTabs(session);
    }, 50);
  }

  private pushTabs(session: string): void {
    this.post({ type: "shareTabs", session, tabs: this.views.list(session).map(tabInfo) });
  }

  /**
   * 接连截图（capturePage）推给网关。停放窗口里（本机没在看）的标签页截图期间照常渲染（同 views.ts 的 whileRendering），
   * 所以不在显示的标签页也有画面，macOS 隐藏的停放窗口也一样
   */
  private startFrames(id: string): void {
    const tab = this.views.get(id);
    if (!tab || this.frames.has(id)) return;
    const wc = tab.view.webContents;
    const onCursor = (_e: unknown, type: string) => this.post({ type: "shareCursor", id, cursor: cssCursor(type) });
    wc.on("cursor-changed", onCursor);
    const state = { on: true, off: () => !wc.isDestroyed() && wc.off("cursor-changed", onCursor) };
    this.frames.set(id, state);
    void this.loop(tab, state);
  }

  private stopFrames(id: string): void {
    const state = this.frames.get(id);
    if (!state) return;
    state.on = false;
    state.off();
    this.frames.delete(id);
    // 网页保持访客最后的大小，等本机在面板里打开它时再按本机的
    this.sizes.delete(id);
  }

  private async loop(tab: Tab, state: { on: boolean }): Promise<void> {
    const wc = tab.view.webContents;
    let last: Buffer | null = null;
    while (state.on && !wc.isDestroyed()) {
      const started = Date.now();
      const size = this.sizes.get(tab.id);
      if (size) this.views.fitParked(tab.id, size.width, size.height);
      const { width, height } = tab.view.getBounds();
      const image = await (this.views.isShown(tab.id) ? wc.capturePage() : wc.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true })).catch(() => null);
      if (state.on && image && !image.isEmpty()) {
        const scaled = image.getSize().width > MAX_FRAME_WIDTH ? image.resize({ width: MAX_FRAME_WIDTH, quality: "good" }) : image;
        const jpeg = scaled.toJPEG(JPEG_QUALITY);
        // 画面没变不发；网关那边积压着（访客网慢）这一帧也不发，下一轮再试
        if ((!last || !jpeg.equals(last)) && this.backlog() < 2 * 1024 * 1024) {
          last = jpeg;
          this.post({ type: "shareFrame", id: tab.id, data: jpeg.toString("base64"), width, height });
        }
      }
      await new Promise((r) => setTimeout(r, Math.max(20, FRAME_MS - (Date.now() - started))));
    }
  }

  /** 访客的输入用调试接口注入（同 AI 的 Playwright）：网页不在前台、窗口没有焦点也能收到 */
  private async input(id: string, ev: ShareInput): Promise<void> {
    const tab = this.views.get(id);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) return;
    switch (ev.type) {
      case "mouse":
        await dbg.sendCommand("Input.dispatchMouseEvent", {
          type: ev.kind === "down" ? "mousePressed" : ev.kind === "up" ? "mouseReleased" : "mouseMoved",
          x: ev.x,
          y: ev.y,
          button: ev.button,
          buttons: ev.buttons,
          clickCount: ev.clickCount,
          modifiers: ev.modifiers,
        });
        return;
      case "wheel":
        await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: ev.modifiers });
        return;
      case "key":
        await dbg.sendCommand("Input.dispatchKeyEvent", {
          type: ev.kind === "up" ? "keyUp" : ev.text ? "keyDown" : "rawKeyDown",
          key: ev.key,
          code: ev.code,
          windowsVirtualKeyCode: ev.keyCode,
          modifiers: ev.modifiers,
          ...(ev.kind === "down" && ev.text ? { text: ev.text, unmodifiedText: ev.text } : {}),
        });
        return;
      case "text":
        await dbg.sendCommand("Input.insertText", { text: ev.text });
        return;
    }
  }
}

/** Electron 的鼠标指针类型（cursor-changed）换成 CSS 的 cursor */
function cssCursor(type: string): string {
  const map: Record<string, string> = { hand: "pointer", nodrop: "no-drop", "eastwest-resize": "ew-resize", "northsouth-resize": "ns-resize", custom: "default" };
  return map[type] ?? type;
}
