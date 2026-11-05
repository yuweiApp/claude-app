import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, Menu, session, WebContentsView, type MenuItemConstructorOptions, type Rectangle, type Session, type WebContents } from "electron";
import { BrowserHistory } from "./history.js";

/**
 * 内置浏览器的标签页：每个标签页一个原生网页视图（WebContentsView），属于一个对话会话。
 * 显示中的那个叠放在主窗口右侧面板的位置上，其他的放在屏幕外的停放窗口里继续渲染
 * （从窗口里拿走的视图不出画面，AI 截图会一直等到超时）。
 * 每个视图一直挂着自己的调试接口（webContents.debugger），AI 经 cdp-proxy 用它操作页面，不开调试端口
 */

export interface TabInfo {
  /** 就是 CDP 的 targetId */
  id: string;
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
}

export interface Tab extends TabInfo {
  view: WebContentsView;
  /** AI 最近一次操作它的时间（CdpProxy 记），browser_keep_tab 留的是这个会话里最近操作过的 */
  lastAgentUse: number;
}

export interface BrowserViewsEvents {
  created: [tab: Tab];
  closed: [tab: Tab];
  changed: [tab: Tab];
  /** AI 切到了这个标签页（CDP Target.activateTarget），面板跟着切 */
  activate: [tab: Tab];
  /** 调试接口发来的 CDP 事件；sessionId 是 iframe、Worker 等子会话，网页本身为空 */
  cdp: [tab: Tab, method: string, params: unknown, sessionId: string];
}

const PARTITION = "persist:claude-browser";
const isMac = process.platform === "darwin";

/** 去掉 Electron 和应用名，和 Chrome 的一样（Google 等网站看到 Electron 会拒绝登录） */
const chromeUserAgent = (ua: string) => ua.replace(/ (?!Chrome\/|Safari\/|AppleWebKit\/|Mozilla\/)[\w.-]+\/[\d.]+/g, "");

export class BrowserViews extends EventEmitter<BrowserViewsEvents> {
  private readonly tabs = new Map<string, Tab>();
  private park: BrowserWindow | null = null;
  private shown: Tab | null = null;
  /** 正在为截图保持渲染的标签页 → 计数 */
  private rendering = new Map<string, number>();
  readonly history = new BrowserHistory(path.join(app.getPath("userData"), "browser-history.json"));

  constructor(private readonly mainWindow: () => BrowserWindow | undefined) {
    super();
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
  }

  list(sessionId?: string): Tab[] {
    return [...this.tabs.values()].filter((t) => !sessionId || t.sessionId === sessionId);
  }

  get(id: string): Tab | undefined {
    return this.tabs.get(id);
  }

  /** 新建标签页；created 事件在返回之前发出（CDP 代理靠这个顺序先报标签页、再回 createTarget） */
  async create(sessionId: string, url: string | undefined, openedBy: "user" | "agent"): Promise<Tab> {
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, backgroundThrottling: false, sandbox: true, contextIsolation: true },
    });
    this.park!.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    await view.webContents.loadURL("about:blank");
    const tab = await this.register(view, sessionId, openedBy);
    if (url) void this.load(tab, url);
    return tab;
  }

  close(id: string): boolean {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    if (tab.view.webContents.isDevToolsOpened()) tab.view.webContents.closeDevTools();
    tab.view.webContents.close();
    return true;
  }

  /** 用户在地址栏里跳转：AI 开的临时标签页从此算用户的，一轮结束时不关 */
  async navigate(id: string, url: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.keep(tab);
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

  /** 新会话页（草稿名下）开的标签页，会话建好后转给它 */
  reassign(from: string, to: string): void {
    for (const tab of this.list(from)) {
      tab.sessionId = to;
      this.emit("changed", tab);
    }
  }

  /** AI 的 browser_keep_tab：把这个会话里 AI 最近操作过的标签页留给用户 */
  keepLatest(sessionId: string): Tab | null {
    const latest = this.list(sessionId)
      .filter((t) => t.lastAgentUse > 0)
      .sort((a, b) => b.lastAgentUse - a.lastAgentUse)[0];
    if (!latest) return null;
    this.keep(latest);
    return latest;
  }

  /** 一轮结束：关掉这个会话里 AI 开的、没留下的临时标签页（用户正在面板里看着的不关） */
  turnEnded(sessionId: string): void {
    for (const tab of this.list(sessionId)) {
      if (tab.kept) continue;
      if (this.shown === tab) this.keep(tab);
      else this.close(tab.id);
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
    const wc = this.tabs.get(id)?.view.webContents;
    if (!wc) return;
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

  /** 挂上调试接口、登记标签页、接上各种事件 */
  private async register(view: WebContentsView, sessionId: string, openedBy: "user" | "agent", openerId?: string): Promise<Tab> {
    const wc = view.webContents;
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const { targetInfo } = (await dbg.sendCommand("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
    const tab: Tab = {
      id: targetInfo.targetId,
      sessionId,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: false,
      canGoForward: false,
      openedBy,
      ...(openerId ? { openerId } : {}),
      kept: openedBy === "user",
      view,
      lastAgentUse: 0,
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
    for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) {
      wc.on(event as "did-start-loading", changed);
    }
    // 浏览历史：主框架跳转时记一次，标题出来后补上
    wc.on("did-navigate", (_e, url) => this.history.visit(url, wc.getTitle()));
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => isMainFrame && this.history.visit(url, wc.getTitle()));
    wc.on("page-title-updated", (_e, title) => this.history.title(wc.getURL(), title));
    wc.on("context-menu", (_e, params) => this.contextMenu(tab, params));
    dbg.on("message", (_e, method, params, childSession) => this.emit("cdp", tab, method, params, childSession ?? ""));
    wc.once("destroyed", () => {
      this.tabs.delete(tab.id);
      this.rendering.delete(tab.id);
      const win = this.mainWindow();
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
      if (this.park && !this.park.isDestroyed()) this.park.contentView.removeChildView(view);
      if (this.shown === tab) this.shown = null;
      this.emit("closed", tab);
    });

    // target=_blank、window.open：装进新的网页视图，归到同一个会话，成为新标签页
    wc.setWindowOpenHandler(() => ({
      action: "allow",
      outlivesOpener: true,
      // 运行时 options 带着 Chromium 建好的 webContents（类型声明里没写）
      createWindow: (options) => {
        const { webContents, webPreferences } = options as typeof options & { webContents: WebContents };
        const child = new WebContentsView({ webContents, webPreferences });
        this.park!.contentView.addChildView(child);
        child.setBounds(view.getBounds());
        void this.registerPopup(child, tab);
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

  /** 网页另开的新页面：刚创建时调试接口可能还挂不上，稍等重试 */
  private async registerPopup(view: WebContentsView, opener: Tab): Promise<void> {
    for (let i = 0; i < 50 && !view.webContents.isDestroyed(); i++) {
      try {
        await this.register(view, opener.sessionId, opener.openedBy, opener.id);
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
    // 下载直接存进系统的「下载」文件夹，同名时加 (1)、(2)：不指定位置会弹「另存为」，停放窗口里的标签页弹出来看不见
    const downloading = new Set<string>();
    ses.on("will-download", (_e, item) => {
      const dir = app.getPath("downloads");
      fs.mkdirSync(dir, { recursive: true });
      const name = path.basename(item.getFilename().replace(/[\\/]/g, "_")) || "download";
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let target = path.join(dir, name);
      for (let i = 1; fs.existsSync(target) || downloading.has(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
      item.setSavePath(target);
      downloading.add(target);
      item.once("done", () => downloading.delete(target));
    });
  }
}

export function tabInfo(tab: Tab): TabInfo {
  const { view: _view, lastAgentUse: _use, ...info } = tab;
  return info;
}
