/** 桌面版（Electron）预加载脚本注入的窗口接口，见 desktop/src/preload.cts；普通浏览器里没有 */
export interface DesktopApi {
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  /** 弹系统的文件夹对话框，取消时返回 null */
  pickFolder(defaultPath?: string): Promise<string | null>;
  /** 返回取消订阅的函数 */
  onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  /** 内置浏览器（右侧面板的「浏览器」），见 desktop/src/browser/views.ts */
  browser: DesktopBrowserApi;
}

/** 内置浏览器的一个标签页，和 desktop/src/browser/views.ts 的 TabInfo 一致 */
export interface BrowserTabInfo {
  /** CDP 的 targetId */
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
  /** 一轮结束时留着（AI 开的临时标签页在一轮结束时关掉） */
  kept: boolean;
}

/** 地址栏的建议（浏览历史） */
export interface BrowserSuggestion {
  url: string;
  title: string;
}

export interface DesktopBrowserApi {
  list(): Promise<BrowserTabInfo[]>;
  /** 给会话新建一个标签页（url 不传是空白页） */
  create(sessionId: string, url?: string): Promise<BrowserTabInfo | null>;
  close(id: string): void;
  navigate(id: string, url: string): void;
  go(id: string, action: "back" | "forward" | "reload" | "stop"): void;
  /** 把标签页叠放到这个位置（界面的 CSS 像素，相对窗口左上角）；同时只显示一个 */
  show(id: string, bounds: { x: number; y: number; width: number; height: number }): void;
  hide(): void;
  /** 新会话页（草稿名下）开的标签页转给建好的会话 */
  reassign(from: string, to: string): void;
  /** 显示中的网页拍一张快照（data URL），界面盖住面板时贴在原位 */
  snapshot(id: string): Promise<string | null>;
  /** 地址栏的建议：浏览历史里网址或标题包含输入的 */
  suggest(query: string): Promise<BrowserSuggestion[]>;
  /** 标签页有变化时推来全部标签页；返回取消订阅的函数 */
  onTabs(callback: (tabs: BrowserTabInfo[]) => void): () => void;
  /** AI 切到了某个标签页 */
  onActivate(callback: (id: string) => void): () => void;
}

export const desktop: DesktopApi | undefined = (window as Window & { desktop?: DesktopApi }).desktop;
