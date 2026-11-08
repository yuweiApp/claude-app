import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, Menu, session, WebContentsView, type DownloadItem, type MenuItemConstructorOptions, type Rectangle, type Session, type WebContents } from "electron";
import { BrowserHistory } from "./history.js";

/**
 * 内置浏览器的标签页：每个标签页一个原生网页视图（WebContentsView），属于一个对话会话。
 * 显示中的那个叠放在主窗口右侧面板的位置上，其他的放在屏幕外的停放窗口里继续渲染
 * （从窗口里拿走的视图不出画面，AI 截图会一直等到超时）。
 * 每个视图一直挂着自己的调试接口（webContents.debugger），AI 经 cdp-proxy 用它操作页面，不开调试端口
 */

export interface TabInfo {
  /** 就是 CDP 的 targetId（重启后恢复的标签页是新的） */
  id: string;
  /** 不随重启变的编号：标签页存在 browser-tabs.json 里，重启后恢复，界面按它把面板里的标签对回来 */
  key: string;
  /** 所属的对话会话 */
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  openedBy: "user" | "agent";
  openerId?: string;
  /**
   * 一轮结束时留着：用户开的一直留着；AI 开的是临时标签页，这一轮结束时关掉，
   * 除非 AI 用 browser_keep_tab 留给用户、用户在地址栏里自己跳转过、或者用户正在面板里看着它
   */
  kept: boolean;
  /**
   * 网页的图标（favicon），favicon://icon/<编号> 地址（主进程的协议，见 faviconResponse）：桌面版用内置浏览器自己的会话取下来
   * （带着网页的 Cookie），界面直接用网址加载会被有防护的网站拦住（如 DeepSeek 不带 Cookie 返回验证页面）；
   * 不用 data: 地址是因为图标可能很大（DeepSeek 的 favicon.ico 有 205 KB），标签页信息每次变化都整份推给界面。还没取到、或者网页没有图标时没有
   */
  favicon?: string;
}

export interface Tab extends TabInfo {
  view: WebContentsView;
  /** AI 最近一次操作它的时间（CdpProxy 记），browser_keep_tab 留的是这个会话里最近操作过的 */
  lastAgentUse: number;
  /** AI 最近一次经 CDP 发点击、按键（Input.*）的时间（CdpProxy 记），判断弹出窗口是不是 AI 的操作触发的 */
  lastAgentInput: number;
  /** 用户最近一次在网页里点击、按键的时间：网页收到的输入事件里，AI 刚发过输入命令的那些不算 */
  lastUserInput: number;
  /** 是谁关的（close 时记下）；没经过 close 就没了的是网页自己关的（window.close）或崩溃 */
  closeReason?: "agent" | "user" | "turn-end";
}

/**
 * 标签页的变化和是谁做的，发给网关（bridge.ts），模型下一次调用浏览器工具时告诉它：
 * - opened：agent（AI 用 newPage 开的）、user（用户点面板的「+」、右键「新标签页打开」）、
 *   agent-input / user-input（网页弹出的，弹出前 AI / 用户刚在原标签页上点击或按键）、page（网页自己弹出的，前面没有点击按键）
 * - closed：agent（AI 用 page.close）、user（用户点标签上的 ×）、turn-end（一轮结束自动关的临时标签页）、page（网页 window.close 或崩溃）
 * - navigated：user（用户在地址栏跳转、点后退、前进、刷新）
 */
export interface TabEvent {
  kind: "opened" | "closed" | "navigated";
  by: "agent" | "user" | "agent-input" | "user-input" | "page" | "turn-end";
  tabId: string;
  url: string;
  title: string;
  openerId?: string;
  /** navigated 的方式 */
  action?: "address" | "back" | "forward" | "reload";
}

/**
 * 标签页里的一次下载（setupSession 的 will-download），CDP 代理按它给 Playwright 报 Browser.downloadWillBegin / downloadProgress：
 * started 开始了（path 是要存到的位置），completed 存好了，cancelled / interrupted 取消、中断了
 */
export interface DownloadEvent {
  guid: string;
  url: string;
  suggestedFilename: string;
  path: string;
  state: "started" | "completed" | "cancelled" | "interrupted";
  /** 已收到、总共的字节数（总数不知道时是 0） */
  receivedBytes: number;
  totalBytes: number;
}

/** browser-tabs.json 里的一个标签页 */
interface SavedTab {
  key: string;
  sessionId: string;
  url: string;
  title: string;
  openedBy: "user" | "agent";
  kept: boolean;
}

/** 网页图标的协议：界面的 <img> 用 favicon://icon/<编号> 加载（main.ts 注册，faviconResponse 返回图片） */
export const FAVICON_SCHEME = "favicon";
/** 网址的域名部分（协议 + 主机 + 端口），解析不了是空串 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** 图标最大多少字节 */
const MAX_FAVICON_BYTES = 2 * 1024 * 1024;

/** 用内置浏览器的会话请求图标（带着 Cookie）：跨域的图标（GitHub 的在 githubassets.com）在网页里请求会被跨域限制挡住，所以先用这个 */
async function fetchInSession(url: string): Promise<{ type: string; bytes: Buffer } | null> {
  try {
    const res = await session.fromPartition(PARTITION).fetch(url, { signal: AbortSignal.timeout(8000) });
    const type = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!res.ok || !type.startsWith("image/")) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= MAX_FAVICON_BYTES ? { type, bytes } : null;
  } catch {
    return null;
  }
}

/**
 * 在标签页的网页里请求图标：和网页自己加载图标的条件一样（同源、带 Referer 等浏览器请求头）。
 * 有防护的网站会拦主进程发的请求（DeepSeek 返回验证页面），网页里请求能拿到
 */
async function fetchInPage(url: string, wc: WebContents): Promise<{ type: string; bytes: Buffer } | null> {
  if (wc.isDestroyed()) return null;
  const script = `fetch(${JSON.stringify(url)}, { credentials: "include" }).then(async (r) => {
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!r.ok || !type.startsWith("image/")) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    if (!b.length || b.length > ${MAX_FAVICON_BYTES}) return null;
    let s = "";
    for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
    return [type, btoa(s)];
  }).catch(() => null)`;
  try {
    const result = (await wc.executeJavaScript(script)) as [string, string] | null;
    return result ? { type: result[0], bytes: Buffer.from(result[1], "base64") } : null;
  } catch {
    return null;
  }
}

/** 弹出窗口出现前多久之内的点击、按键算触发了它 */
const POPUP_TRIGGER_MS = 2000;
/** 网页收到的输入事件，离 AI 上一次经 CDP 发输入命令不到这么久的，是 AI 的（CDP 发的输入也会触发 input-event） */
const AGENT_INPUT_ECHO_MS = 300;

export interface BrowserViewsEvents {
  created: [tab: Tab];
  closed: [tab: Tab];
  changed: [tab: Tab];
  /** AI 切到了这个标签页（CDP Target.activateTarget），面板跟着切 */
  activate: [tab: Tab];
  /** 调试接口发来的 CDP 事件；sessionId 是 iframe、Worker 等子会话，网页本身为空 */
  cdp: [tab: Tab, method: string, params: unknown, sessionId: string];
  /** 标签页的变化和是谁做的，发给网关 */
  tabEvent: [sessionId: string, event: TabEvent];
  /** 标签页里的下载开始、结束 */
  download: [tab: Tab, event: DownloadEvent];
}

const PARTITION = "persist:claude-browser";
const isMac = process.platform === "darwin";

/** 去掉 Electron 和应用名，和 Chrome 的一样（Google 等网站看到 Electron 会拒绝登录） */
const chromeUserAgent = (ua: string) => ua.replace(/ (?!Chrome\/|Safari\/|AppleWebKit\/|Mozilla\/)[\w.-]+\/[\d.]+/g, "");

export class BrowserViews extends EventEmitter<BrowserViewsEvents> {
  private readonly tabs = new Map<string, Tab>();
  /** 进行中的下载（guid 见 DownloadEvent），cancelDownload 用 */
  private readonly downloads = new Map<string, DownloadItem>();
  private park: BrowserWindow | null = null;
  private shown: Tab | null = null;
  /** 网页图标的缓存：图标网址 → favicon:// 地址（取不到是 null）；编号 → 图片 */
  private readonly favicons = new Map<string, string | null>();
  private readonly faviconData = new Map<string, { type: string; bytes: Buffer }>();
  private nextFaviconId = 1;
  /** 正在为截图保持渲染的标签页 → 计数 */
  private rendering = new Map<string, number>();
  readonly history = new BrowserHistory(path.join(app.getPath("userData"), "browser-history.json"));
  /** 开着的标签页（会话、网址、标题、是不是留下的），重启后恢复 */
  private readonly tabsFile = path.join(app.getPath("userData"), "browser-tabs.json");
  private saveTimer: NodeJS.Timeout | undefined;
  /** 正在恢复上次的标签页：恢复完再存，免得存下一半 */
  private restoring = false;
  /** 退出中：窗口关掉时视图跟着销毁，这些关闭不算，不再存 */
  private frozen = false;

  constructor(private readonly mainWindow: () => BrowserWindow | undefined) {
    super();
    for (const event of ["created", "changed", "closed"] as const) this.on(event, () => this.scheduleSave());
  }

  /** app ready 之后调用一次 */
  async init(): Promise<void> {
    app.userAgentFallback = chromeUserAgent(app.userAgentFallback);
    this.setupSession(session.fromPartition(PARTITION));
    // 后台标签页的停放窗口：Linux、Windows 放在屏幕外显示着；macOS 会把屏幕外的窗口挪回来，所以保持隐藏，截图时靠 capturePage 出画面
    this.park = new BrowserWindow({
      x: -4000,
      y: -4000,
      width: 1280,
      height: 800,
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: { backgroundThrottling: false, sandbox: true },
    });
    await this.park.loadURL("about:blank");
    if (!isMac) this.park.showInactive();
    await this.restore();
  }

  /** 退出前调用（主窗口关闭、应用退出）：先存一次，之后视图销毁引起的关闭不再改动记录 */
  freeze(): void {
    if (this.frozen) return;
    clearTimeout(this.saveTimer);
    this.save();
    this.frozen = true;
  }

  /** 恢复上次开着的标签页：同一个会话、网址，留没留下也照旧；CDP 的 id 是新的，key 不变 */
  private async restore(): Promise<void> {
    let saved: SavedTab[];
    try {
      saved = JSON.parse(fs.readFileSync(this.tabsFile, "utf8")) as SavedTab[];
    } catch {
      return;
    }
    this.restoring = true;
    try {
      for (const s of saved) {
        if (!s || typeof s.sessionId !== "string" || typeof s.key !== "string") continue;
        try {
          const view = this.newView();
          await view.webContents.loadURL("about:blank");
          const tab = await this.register(view, s.sessionId, s.openedBy === "agent" ? "agent" : "user", undefined, { key: s.key, kept: s.kept !== false });
          tab.title = s.title ?? "";
          if (s.url && s.url !== "about:blank") void this.load(tab, s.url);
        } catch {
          // 恢复不了的跳过
        }
      }
    } finally {
      this.restoring = false;
    }
    this.save();
  }

  private scheduleSave(): void {
    if (this.frozen || this.restoring) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1000);
  }

  private save(): void {
    if (this.frozen) return;
    const list: SavedTab[] = [...this.tabs.values()].map((t) => ({ key: t.key, sessionId: t.sessionId, url: t.url, title: t.title, openedBy: t.openedBy, kept: t.kept }));
    try {
      const tmp = `${this.tabsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list));
      fs.renameSync(tmp, this.tabsFile);
    } catch {
      // 写不了就算了，下次变化再写
    }
  }

  private newView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, backgroundThrottling: false, sandbox: true, contextIsolation: true },
    });
    this.park!.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    return view;
  }

  list(sessionId?: string): Tab[] {
    return [...this.tabs.values()].filter((t) => !sessionId || t.sessionId === sessionId);
  }

  get(id: string): Tab | undefined {
    return this.tabs.get(id);
  }

  /** 新建标签页；created 事件在返回之前发出（CDP 代理靠这个顺序先报标签页、再回 createTarget） */
  async create(sessionId: string, url: string | undefined, openedBy: "user" | "agent"): Promise<Tab> {
    const view = this.newView();
    await view.webContents.loadURL("about:blank");
    const tab = await this.register(view, sessionId, openedBy);
    this.emitTabEvent(tab, "opened", openedBy, url);
    if (url) void this.load(tab, url);
    return tab;
  }

  /** reason：谁关的，标签页没了时作为 closed 事件的 by 发给网关 */
  close(id: string, reason: "agent" | "user" | "turn-end"): boolean {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    tab.closeReason ??= reason;
    if (tab.view.webContents.isDevToolsOpened()) tab.view.webContents.closeDevTools();
    tab.view.webContents.close();
    return true;
  }

  /** 用户在地址栏里跳转：AI 开的临时标签页从此算用户的，一轮结束时不关 */
  async navigate(id: string, url: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.keep(tab);
    this.emitTabEvent(tab, "navigated", "user", url, "address");
    await this.load(tab, url);
  }

  private async load(tab: Tab, url: string): Promise<void> {
    await tab.view.webContents.loadURL(url).catch(() => undefined);
  }

  private keep(tab: Tab): void {
    if (tab.kept) return;
    tab.kept = true;
    this.emit("changed", tab);
  }

  /** 这个会话里 AI 最近操作过的标签页（CdpProxy 记的 lastAgentUse），browser_keep_tab 留的就是它 */
  private latestAgentTab(sessionId: string): Tab | undefined {
    return this.list(sessionId)
      .filter((t) => t.lastAgentUse > 0)
      .sort((a, b) => b.lastAgentUse - a.lastAgentUse)[0];
  }

  /** AI 的 browser_keep_tab：把这个会话里 AI 最近操作过的标签页留给用户 */
  keepLatest(sessionId: string): Tab | null {
    const latest = this.latestAgentTab(sessionId);
    if (!latest) return null;
    this.keep(latest);
    return latest;
  }

  /** 这个会话里还没留下的临时标签页（一轮结束时会关）；latest 标出 AI 最近操作过的那个（browser_keep_tab 会留下它） */
  temporaryTabs(sessionId: string): { title: string; url: string; latest: boolean }[] {
    const latest = this.latestAgentTab(sessionId);
    return this.list(sessionId)
      .filter((t) => !t.kept)
      .map((t) => ({ title: t.title, url: t.url, latest: t === latest }));
  }

  /** 会话删除了：关掉它的所有标签页（AI 留下的、用户开的不会自动关，不关会一直留在后台） */
  closeSession(sessionId: string): void {
    for (const tab of this.list(sessionId)) this.close(tab.id, "user");
  }

  /** 一轮结束：关掉这个会话里 AI 开的、没留下的临时标签页（用户正在面板里看着的不关） */
  turnEnded(sessionId: string): void {
    for (const tab of this.list(sessionId)) {
      if (tab.kept) continue;
      if (this.shown === tab) this.keep(tab);
      else this.close(tab.id, "turn-end");
    }
  }

  /** 面板被界面的菜单、对话框盖住时，先给显示中的网页拍一张快照贴在原位 */
  async snapshot(id: string): Promise<string | null> {
    const tab = this.tabs.get(id);
    if (!tab || this.shown !== tab || tab.view.webContents.isDestroyed()) return null;
    try {
      const image = await tab.view.webContents.capturePage();
      return image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`;
    } catch {
      return null;
    }
  }

  go(id: string, action: "back" | "forward" | "reload" | "stop"): void {
    const tab = this.tabs.get(id);
    const wc = tab?.view.webContents;
    if (!tab || !wc) return;
    if (action !== "stop") this.emitTabEvent(tab, "navigated", "user", undefined, action);
    if (action === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === "reload") wc.reload();
    else if (action === "stop") wc.stop();
  }

  activate(id: string): void {
    const tab = this.tabs.get(id);
    if (tab) this.emit("activate", tab);
  }

  /** 叠放到主窗口的面板位置（bounds 是界面的 CSS 像素，按界面的缩放换成窗口坐标）；原来显示的回到停放窗口 */
  show(id: string, bounds: Rectangle): void {
    const win = this.mainWindow();
    const tab = this.tabs.get(id);
    if (!win || win.isDestroyed() || !tab) return;
    if (this.shown && this.shown !== tab) this.toPark(this.shown);
    if (this.shown !== tab) {
      this.park?.contentView.removeChildView(tab.view);
      win.contentView.addChildView(tab.view);
      this.shown = tab;
    }
    const zoom = win.webContents.getZoomFactor();
    tab.view.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(1, Math.round(bounds.width * zoom)),
      height: Math.max(1, Math.round(bounds.height * zoom)),
    });
  }

  hide(): void {
    if (this.shown) this.toPark(this.shown);
  }

  /**
   * 在 work 期间让标签页照常出画面（截图用）：不在主窗口上显示的标签页不画新的帧，CDP 截图会一直等。
   * Electron 在 capturePage 期间把页面算作被捕获、照常渲染（stayHidden：页面的 visibilityState 不变），所以这段时间里接连捕获一个像素
   */
  async whileRendering<T>(id: string, work: Promise<T>): Promise<T> {
    const tab = this.tabs.get(id);
    if (!tab || this.shown === tab) return work;
    const count = this.rendering.get(id) ?? 0;
    this.rendering.set(id, count + 1);
    if (count === 0) {
      void (async () => {
        while ((this.rendering.get(id) ?? 0) > 0 && !tab.view.webContents.isDestroyed()) {
          await tab.view.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true }).catch(() => undefined);
        }
      })();
    }
    try {
      return await work;
    } finally {
      const left = (this.rendering.get(id) ?? 1) - 1;
      if (left > 0) this.rendering.set(id, left);
      else this.rendering.delete(id);
    }
  }

  private toPark(tab: Tab): void {
    const win = this.mainWindow();
    if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view);
    if (this.park && !this.park.isDestroyed()) this.park.contentView.addChildView(tab.view);
    if (this.shown === tab) this.shown = null;
  }

  /** 挂上调试接口、登记标签页、接上各种事件；restored：重启后恢复的，沿用原来的 key 和留没留下 */
  private async register(
    view: WebContentsView,
    sessionId: string,
    openedBy: "user" | "agent",
    openerId?: string,
    restored?: { key: string; kept: boolean },
  ): Promise<Tab> {
    const wc = view.webContents;
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const { targetInfo } = (await dbg.sendCommand("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
    const tab: Tab = {
      id: targetInfo.targetId,
      key: restored?.key ?? randomUUID(),
      sessionId,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: false,
      canGoForward: false,
      openedBy,
      ...(openerId ? { openerId } : {}),
      kept: restored?.kept ?? openedBy === "user",
      view,
      lastAgentUse: 0,
      lastAgentInput: 0,
      lastUserInput: 0,
    };
    this.tabs.set(tab.id, tab);
    view.setBackgroundColor("#ffffff");

    const changed = () => {
      if (wc.isDestroyed()) return;
      tab.url = wc.getURL();
      tab.title = wc.getTitle();
      tab.loading = wc.isLoading();
      tab.canGoBack = wc.navigationHistory.canGoBack();
      tab.canGoForward = wc.navigationHistory.canGoForward();
      this.emit("changed", tab);
    };
    // 网页的图标：跳到别的网站（域名不同）时先清掉，新网站的图标随后由 page-favicon-updated 给出。
    // 同一个网站里跳转不清：图标网址没变时 Electron 不会再发 page-favicon-updated（DeepSeek 打开后马上跳到 /en/，清掉就再也没有了）。
    // 取图标要一会儿，编号对不上（取回来之前又跳到别的网站、又换了图标）就不用了
    let faviconRequest = 0;
    let faviconOrigin = "";
    wc.on("did-navigate", (_e, url) => {
      const origin = originOf(url);
      if (origin === faviconOrigin) return;
      faviconOrigin = origin;
      faviconRequest++;
      tab.favicon = undefined;
    });
    wc.on("page-favicon-updated", (_e, favicons) => {
      const request = ++faviconRequest;
      const url = favicons[0];
      if (!url) return;
      void this.fetchFavicon(url, wc).then((data) => {
        if (wc.isDestroyed() || request !== faviconRequest) return;
        tab.favicon = data ?? undefined;
        changed();
      });
    });
    for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) {
      wc.on(event as "did-start-loading", changed);
    }
    // 浏览历史：主框架跳转时记一次，标题出来后补上
    wc.on("did-navigate", (_e, url) => this.history.visit(url, wc.getTitle()));
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => isMainFrame && this.history.visit(url, wc.getTitle()));
    wc.on("page-title-updated", (_e, title) => this.history.title(wc.getURL(), title));
    wc.on("context-menu", (_e, params) => this.contextMenu(tab, params));
    dbg.on("message", (_e, method, params, childSession) => this.emit("cdp", tab, method, params, childSession ?? ""));
    // 用户在网页里的点击、按键（弹出窗口算谁触发的要用）。AI 经 CDP 发的输入也会触发这个事件，刚发过的不算
    wc.on("input-event", (_e, input) => {
      if (input.type !== "mouseDown" && input.type !== "keyDown" && input.type !== "rawKeyDown") return;
      const now = Date.now();
      if (now - tab.lastAgentInput > AGENT_INPUT_ECHO_MS) tab.lastUserInput = now;
    });
    wc.once("destroyed", () => {
      this.emitTabEvent(tab, "closed", tab.closeReason ?? "page");
      this.tabs.delete(tab.id);
      this.rendering.delete(tab.id);
      const win = this.mainWindow();
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
      if (this.park && !this.park.isDestroyed()) this.park.contentView.removeChildView(view);
      if (this.shown === tab) this.shown = null;
      this.emit("closed", tab);
    });

    // target=_blank、window.open：装进新的网页视图，归到同一个会话，成为新标签页
    wc.setWindowOpenHandler((details) => ({
      action: "allow",
      outlivesOpener: true,
      // 运行时 options 带着 Chromium 建好的 webContents（类型声明里没写）
      createWindow: (options) => {
        const { webContents, webPreferences } = options as typeof options & { webContents: WebContents };
        const child = new WebContentsView({ webContents, webPreferences });
        this.park!.contentView.addChildView(child);
        child.setBounds(view.getBounds());
        void this.registerPopup(child, tab, details.url);
        return child.webContents;
      },
    }));
    // 焦点在网页里时的快捷键作用在这个标签页上（默认会作用在界面窗口上：Ctrl+R 刷新整个界面）
    wc.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown") return;
      const mod = isMac ? input.meta : input.control;
      const key = input.key.toLowerCase();
      if ((mod && key === "r") || input.key === "F5") {
        e.preventDefault();
        if (input.shift) wc.reloadIgnoringCache();
        else wc.reload();
      } else if (input.key === "F12" || (mod && input.shift && key === "i")) {
        e.preventDefault();
        if (wc.isDevToolsOpened()) wc.closeDevTools();
        else wc.openDevTools({ mode: "detach" });
      } else if (input.alt && !mod && (input.key === "ArrowLeft" || input.key === "ArrowRight")) {
        e.preventDefault();
        this.go(tab.id, input.key === "ArrowLeft" ? "back" : "forward");
      }
    });

    this.emit("created", tab);
    return tab;
  }

  /** 网页的右键菜单（系统菜单）：按点到的东西（链接、图片、选中的文字、输入框）给不同的项，最后是「检查」 */
  private contextMenu(tab: Tab, p: Electron.ContextMenuParams): void {
    const wc = tab.view.webContents;
    const openInNewTab = (url: string) => void this.create(tab.sessionId, url, "user");
    const items: MenuItemConstructorOptions[] = [];
    const group = (list: MenuItemConstructorOptions[]) => {
      if (!list.length) return;
      if (items.length) items.push({ type: "separator" });
      items.push(...list);
    };
    if (p.linkURL) {
      group([
        { label: "在新标签页中打开链接", click: () => openInNewTab(p.linkURL) },
        { label: "复制链接地址", click: () => clipboard.writeText(p.linkURL) },
      ]);
    }
    if (p.mediaType === "image" && p.srcURL) {
      group([
        { label: "在新标签页中打开图片", click: () => openInNewTab(p.srcURL) },
        { label: "复制图片", click: () => wc.copyImageAt(p.x, p.y) },
        { label: "复制图片地址", click: () => clipboard.writeText(p.srcURL) },
      ]);
    }
    if (p.isEditable) {
      group([
        { label: "撤销", role: "undo", enabled: p.editFlags.canUndo },
        { label: "重做", role: "redo", enabled: p.editFlags.canRedo },
        { type: "separator" },
        { label: "剪切", role: "cut", enabled: p.editFlags.canCut },
        { label: "复制", role: "copy", enabled: p.editFlags.canCopy },
        { label: "粘贴", role: "paste", enabled: p.editFlags.canPaste },
        { label: "全选", role: "selectAll", enabled: p.editFlags.canSelectAll },
      ]);
    } else if (p.selectionText.trim()) {
      const text = p.selectionText.trim();
      const short = text.length > 16 ? `${text.slice(0, 16)}…` : text;
      group([
        { label: "复制", role: "copy" },
        { label: `用必应搜索“${short}”`, click: () => openInNewTab(`https://www.bing.com/search?q=${encodeURIComponent(text)}`) },
      ]);
    }
    if (!p.linkURL && !p.isEditable && !p.selectionText.trim() && p.mediaType !== "image") {
      group([
        { label: "后退", enabled: wc.navigationHistory.canGoBack(), click: () => this.go(tab.id, "back") },
        { label: "前进", enabled: wc.navigationHistory.canGoForward(), click: () => this.go(tab.id, "forward") },
        { label: "重新加载", click: () => this.go(tab.id, "reload") },
      ]);
    }
    group([
      {
        label: "检查",
        click: () => {
          // 视图里放不下停靠的开发者工具，单独开一个窗口，再选中右键处的元素
          if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: "detach" });
          wc.inspectElement(p.x, p.y);
        },
      },
    ]);
    const win = this.shown === tab ? this.mainWindow() : this.park;
    if (win && !win.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: win });
  }

  /**
   * 用内置浏览器自己的会话取网页图标（带着网页的 Cookie），存在这里，给界面一个 favicon://icon/<编号> 地址：
   * 界面直接按网址加载，有防护的网站会拦（DeepSeek 不带 Cookie 返回验证页面），有的禁止别的网站引用。
   * 只要图片，最多 2 MB，按网址缓存（最多 300 个，满了丢掉最早的）
   */
  private async fetchFavicon(url: string, wc: WebContents): Promise<string | null> {
    if (url.startsWith("data:image/")) return url;
    const cached = this.favicons.get(url);
    if (cached !== undefined) return cached;
    const icon = (await fetchInSession(url)) ?? (await fetchInPage(url, wc));
    let result: string | null = null;
    if (icon) {
      const id = String(this.nextFaviconId++);
      this.faviconData.set(id, icon);
      result = `${FAVICON_SCHEME}://icon/${id}`;
    }
    if (this.favicons.size >= 300) {
      const [oldUrl, oldIcon] = this.favicons.entries().next().value!;
      this.favicons.delete(oldUrl);
      if (oldIcon) this.faviconData.delete(oldIcon.split("/").pop()!);
    }
    this.favicons.set(url, result);
    return result;
  }

  /** favicon://icon/<编号> 的请求（main.ts 注册的协议）：返回取下来的图标 */
  faviconResponse(requestUrl: string): Response {
    const id = new URL(requestUrl).pathname.replace(/^\//, "");
    const icon = this.faviconData.get(id);
    if (!icon) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(icon.bytes), { headers: { "content-type": icon.type, "cache-control": "max-age=86400" } });
  }

  /** 取消一个进行中的下载（Playwright 的 download.cancel()）；已经结束的不管 */
  cancelDownload(guid: string): void {
    this.downloads.get(guid)?.cancel();
  }

  /** 发出标签页的变化（bridge 转给网关）；url 不给时用标签页现在的网址 */
  private emitTabEvent(tab: Tab, kind: TabEvent["kind"], by: TabEvent["by"], url?: string, action?: TabEvent["action"]): void {
    this.emit("tabEvent", tab.sessionId, {
      kind,
      by,
      tabId: tab.id,
      url: url ?? tab.url,
      title: tab.title,
      ...(tab.openerId ? { openerId: tab.openerId } : {}),
      ...(action ? { action } : {}),
    });
  }

  /** 网页弹出的窗口是谁触发的：弹出前不久原标签页上最近的一次点击按键是 AI 的还是用户的，都没有就是网页自己弹的 */
  private popupCause(opener: Tab): TabEvent["by"] {
    const now = Date.now();
    const agent = now - opener.lastAgentInput <= POPUP_TRIGGER_MS ? opener.lastAgentInput : 0;
    const user = now - opener.lastUserInput <= POPUP_TRIGGER_MS ? opener.lastUserInput : 0;
    if (!agent && !user) return "page";
    return agent >= user ? "agent-input" : "user-input";
  }

  /** 网页另开的新页面：刚创建时调试接口可能还挂不上，稍等重试 */
  private async registerPopup(view: WebContentsView, opener: Tab, url: string): Promise<void> {
    // 在重试之前算：弹出窗口刚出现时离触发它的点击最近
    const cause = this.popupCause(opener);
    for (let i = 0; i < 50 && !view.webContents.isDestroyed(); i++) {
      try {
        const tab = await this.register(view, opener.sessionId, opener.openedBy, opener.id);
        // 刚登记时还没开始加载，网址是空的，用 window.open / 链接的目标网址
        this.emitTabEvent(tab, "opened", cause, tab.url || url);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  /**
   * 网页分区的设置：User-Agent 去掉 Electron；网页的权限请求（摄像头、麦克风、定位、通知……）除了写剪贴板都拒绝（Electron 默认全部允许）；下载
   */
  private setupSession(ses: Session): void {
    ses.setUserAgent(chromeUserAgent(ses.getUserAgent()));
    const allowed = new Set(["clipboard-sanitized-write"]);
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    // 下载直接存进系统的「下载」文件夹，同名时加 (1)、(2)：不指定位置会弹「另存为」，停放窗口里的标签页弹出来看不见。
    // 开始、结束都发出 download 事件，CDP 代理照 Chrome 的样子报给 Playwright（page.waitForEvent('download') 这些才能用）
    const downloading = new Set<string>();
    ses.on("will-download", (_e, item, contents) => {
      const dir = app.getPath("downloads");
      fs.mkdirSync(dir, { recursive: true });
      const name = path.basename(item.getFilename().replace(/[\\/]/g, "_")) || "download";
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let target = path.join(dir, name);
      for (let i = 1; fs.existsSync(target) || downloading.has(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
      item.setSavePath(target);
      downloading.add(target);
      const tab = [...this.tabs.values()].find((t) => t.view.webContents === contents);
      const guid = randomUUID();
      const base = { guid, url: item.getURL(), suggestedFilename: name, path: target };
      this.downloads.set(guid, item);
      if (tab) this.emit("download", tab, { ...base, state: "started", receivedBytes: 0, totalBytes: item.getTotalBytes() });
      item.once("done", (_e, state) => {
        downloading.delete(target);
        this.downloads.delete(guid);
        if (tab) this.emit("download", tab, { ...base, state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
      });
    });
  }
}

export function tabInfo(tab: Tab): TabInfo {
  const { view: _view, lastAgentUse: _use, lastAgentInput: _agentInput, lastUserInput: _userInput, closeReason: _reason, ...info } = tab;
  return info;
}
