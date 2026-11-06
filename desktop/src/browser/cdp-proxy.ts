import type { BrowserViews, Tab } from "./views.js";

/**
 * 一个对话会话的 CDP 代理（做法参照 VS Code 的 browserView/common/cdp/proxy.ts）：
 * 把这个会话的标签页拼成「一个浏览器」交给网关里的 Playwright。
 * - 浏览器级的命令（没有 sessionId：列标签页、新建、关闭、自动挂接……）这里自己回答，只报这个会话的标签页，
 *   所以 Playwright 天然看不到别的会话的标签页，也看不到界面窗口
 * - 发给标签页的命令转给那个标签页的 webContents.debugger
 *
 * 标签页在 Playwright 这边的会话号是 "S" + targetId；iframe、Worker 等子会话的号由调试接口分配，原样转发
 */

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };

export class CdpProxy {
  private autoAttach = false;
  private discover = false;
  /** 已经报给 Playwright 的标签页（targetId） */
  private readonly attached = new Set<string>();
  /** 子会话号 → 所在标签页 */
  private readonly children = new Map<string, string>();
  private readonly unsubscribe: () => void;
  /** AI 上次让面板切过去的标签页：同一个标签页只切一次，用户手动切走后，AI 接着在原来的标签页上点不会把面板拉回来 */
  private lastActivated: string | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly views: BrowserViews,
    /** 发给 Playwright 的消息（回复、事件），按顺序 */
    private readonly send: (message: object) => void,
  ) {
    const mine = (tab: Tab) => tab.sessionId === this.sessionId;
    const onCreated = (tab: Tab) => {
      if (!mine(tab)) return;
      if (this.discover) this.event("Target.targetCreated", { targetInfo: this.info(tab) });
      if (this.autoAttach) this.attach(tab);
    };
    const onClosed = (tab: Tab) => {
      if (!mine(tab)) return;
      for (const [child, owner] of this.children) if (owner === tab.id) this.children.delete(child);
      if (this.attached.delete(tab.id)) this.event("Target.detachedFromTarget", { sessionId: pageSession(tab.id), targetId: tab.id });
      if (this.discover) this.event("Target.targetDestroyed", { targetId: tab.id });
    };
    const onChanged = (tab: Tab) => {
      if (!mine(tab)) return;
      if (this.discover) this.event("Target.targetInfoChanged", { targetInfo: this.info(tab) });
    };
    const onCdp = (tab: Tab, method: string, params: unknown, child: string) => {
      if (!mine(tab) || !this.attached.has(tab.id)) return;
      // 记下子会话属于哪个标签页，之后发给它的命令才知道交给谁
      if (method === "Target.attachedToTarget") this.children.set((params as { sessionId: string }).sessionId, tab.id);
      if (method === "Target.detachedFromTarget") this.children.delete((params as { sessionId: string }).sessionId);
      this.send({ method, params, sessionId: child || pageSession(tab.id) });
    };
    views.on("created", onCreated);
    views.on("closed", onClosed);
    views.on("changed", onChanged);
    views.on("cdp", onCdp);
    this.unsubscribe = () => {
      views.off("created", onCreated);
      views.off("closed", onClosed);
      views.off("changed", onChanged);
      views.off("cdp", onCdp);
    };
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Playwright 发来的一条命令 */
  handle(msg: Message): void {
    const id = msg.id ?? 0;
    const reply = (result: unknown) => this.send({ id, sessionId: msg.sessionId, result });
    const fail = (message: string) => this.send({ id, sessionId: msg.sessionId, error: { code: -32000, message } });
    const run = msg.sessionId ? this.forward(msg) : this.browserCommand(msg.method ?? "", msg.params ?? {});
    run.then(reply, (err: Error) => fail(err.message));
  }

  /** 发给标签页（或它的子会话）的命令：转给那个标签页的调试接口 */
  private async forward(msg: Message): Promise<unknown> {
    const sid = msg.sessionId!;
    const tabId = sid.startsWith("S") && this.attached.has(sid.slice(1)) ? sid.slice(1) : this.children.get(sid);
    const tab = tabId ? this.views.get(tabId) : undefined;
    if (!tab || tab.sessionId !== this.sessionId) throw new Error(`No session with given id: ${sid}`);
    const method = msg.method ?? "";
    // 视口由面板决定：Playwright 模拟设备尺寸会改掉原生视图里网页的大小
    if (method === "Emulation.setDeviceMetricsOverride" || method === "Emulation.clearDeviceMetricsOverride") return {};
    // 切到这个标签页（Playwright 的 page.bringToFront()，网关在模型给 page 换了标签页时调用）：面板跟着切。
    // 不转给网页：Electron 的网页视图收到它会去抢窗口焦点
    if (method === "Page.bringToFront") {
      tab.lastAgentUse = Date.now();
      this.activate(tab, true);
      return {};
    }
    // 记下 AI 实际在操作哪个标签页（Playwright 连上时给每个标签页发的初始化命令不算），browser_keep_tab 留的是最近这个
    if (AGENT_ACTIONS.test(method)) tab.lastAgentUse = Date.now();
    // AI 的点击、按键：判断弹出窗口是谁触发的，也用来把网页收到的输入事件里 AI 的排除掉（views.ts 的 input-event）
    if (method.startsWith("Input.")) tab.lastAgentInput = Date.now();
    // AI 在这个标签页上跳转、输入：面板切过去，用户能看到它在操作哪个（模型可能用 page 以外的变量操作别的标签页）
    if (VISIBLE_ACTIONS.test(method)) this.activate(tab);
    const child = sid === pageSession(tab.id) ? undefined : sid;
    const work = tab.view.webContents.debugger.sendCommand(method, msg.params, child);
    // 截图要等新的一帧，后台标签页要先让它出画面
    return method === "Page.captureScreenshot" ? this.views.whileRendering(tab.id, work) : work;
  }

  /** 让面板切到 AI 在操作的标签页；force 是 AI 明确要切（bringToFront、activateTarget），否则同一个标签页只切一次 */
  private activate(tab: Tab, force = false): void {
    if (!force && this.lastActivated === tab.id) return;
    this.lastActivated = tab.id;
    this.views.activate(tab.id);
  }

  private async browserCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
    const tabs = () => this.views.list(this.sessionId);
    const tabOf = (targetId: unknown) => {
      const tab = typeof targetId === "string" ? this.views.get(targetId) : undefined;
      if (!tab || tab.sessionId !== this.sessionId) throw new Error(`No target with given id found: ${String(targetId)}`);
      return tab;
    };
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: `Chrome/${process.versions.chrome}`,
          revision: "",
          userAgent: tabs()[0]?.view.webContents.getUserAgent() ?? "",
          jsVersion: process.versions.v8,
        };
      case "Target.setAutoAttach":
        this.autoAttach = !!params.autoAttach;
        if (this.autoAttach) for (const tab of tabs()) this.attach(tab);
        return {};
      case "Target.setDiscoverTargets":
        this.discover = !!params.discover;
        if (this.discover) for (const tab of tabs()) this.event("Target.targetCreated", { targetInfo: this.info(tab) });
        return {};
      case "Target.getTargets":
        return { targetInfos: tabs().map((t) => this.info(t)) };
      case "Target.getTargetInfo":
        if (params.targetId === undefined) return { targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false } };
        return { targetInfo: this.info(tabOf(params.targetId)) };
      case "Target.createTarget": {
        const url = typeof params.url === "string" && params.url !== "about:blank" ? params.url : undefined;
        // views.create 在返回前发出 created，attachedToTarget 先于这条回复送到（Playwright 要求这个顺序）
        const tab = await this.views.create(this.sessionId, url, "agent");
        return { targetId: tab.id };
      }
      case "Target.closeTarget":
        return { success: this.views.close(tabOf(params.targetId).id, "agent") };
      case "Target.activateTarget":
        tabOf(params.targetId).lastAgentUse = Date.now();
        this.activate(tabOf(params.targetId), true);
        return {};
      case "Target.attachToTarget": {
        const tab = tabOf(params.targetId);
        this.attach(tab);
        return { sessionId: pageSession(tab.id) };
      }
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Browser.getWindowForTarget":
        return { windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" } };
      case "Target.createBrowserContext":
        throw new Error("内置浏览器不支持新建浏览器上下文");
      default:
        // 下载设置、权限重置、关闭浏览器等：这里没有对应的东西，当作成功
        return {};
    }
  }

  private attach(tab: Tab): void {
    if (this.attached.has(tab.id)) return;
    this.attached.add(tab.id);
    this.event("Target.attachedToTarget", { sessionId: pageSession(tab.id), targetInfo: { ...this.info(tab), attached: true }, waitingForDebugger: false });
  }

  private info(tab: Tab) {
    return {
      targetId: tab.id,
      type: "page",
      title: tab.title,
      url: tab.url,
      attached: this.attached.has(tab.id),
      canAccessOpener: false,
      // Playwright 要求有；对不上它认识的上下文时归到默认上下文
      browserContextId: "default",
      ...(tab.openerId ? { openerId: tab.openerId } : {}),
    };
  }

  private event(method: string, params: unknown): void {
    this.send({ method, params });
  }
}

const pageSession = (targetId: string) => `S${targetId}`;
/** 算作 AI 在操作这个标签页的命令：跳转、输入、读页面、截图 */
const AGENT_ACTIONS = /^(Input\.|DOM\.|Page\.(navigate|reload|captureScreenshot)|Runtime\.(evaluate|callFunctionOn))/;
/**
 * AI 在标签页上做的、用户应该看到的操作：跳转、输入。读页面（Runtime.evaluate 等）不算：
 * Playwright 等元素、读内容时一直在发，算进去模型读别的标签页时面板会来回闪
 */
const VISIBLE_ACTIONS = /^(Input\.|Page\.(navigate|reload))/;
