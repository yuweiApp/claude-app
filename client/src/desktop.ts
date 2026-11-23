import { useEffect, useState } from "react";
import type { SelectedElement } from "@gateway/shared/types";
/** 桌面版（Electron）预加载脚本注入的窗口接口，见 desktop/src/preload.cts；普通浏览器里没有 */
export interface DesktopApi {
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  /** 弹系统的文件夹对话框，取消时返回 null */
  pickFolder(defaultPath?: string): Promise<string | null>;
  /** 用系统的文件管理器打开所在的文件夹并选中它；文件不在这台机器上时返回 false */
  showItemInFolder(path: string): Promise<boolean>;
  /** 用系统的文件管理器打开这个文件夹本身；不在这台机器上时返回 false */
  openFolder(path: string): Promise<boolean>;
  /** 返回取消订阅的函数 */
  onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  /** 按标题找桌面上的窗口（桌面工具正在操作的那个），返回采集源，getUserMedia 用它的 id 取实时画面；找不到时 null。见 desktop/src/capture.ts */
  findCaptureSource(title: string): Promise<CaptureSource | null>;
  /** 界面上一块区域（界面的 CSS 像素）的截图，PNG 的 base64，最长边不超过 1200px；拍不到时 null */
  captureRect(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>;
  /** 文件树的上传、下载：本机路径，见 desktop/src/main.ts 的 files:* */
  files: DesktopFilesApi;
  /** 内置浏览器（右侧面板的「浏览器」），见 desktop/src/browser/views.ts */
  browser: DesktopBrowserApi;
  /** 灵宠：在屏幕角落待着，主窗口不在前台时提醒会话完成，见 desktop/src/pet.ts；旧版外壳没有 */
  pet?: DesktopPetApi;
}

export interface DesktopPetApi {
  /** 设置里的开关和正在运行的会话数；关着时灵宠不出现 */
  update(state: { enabled: boolean; working: number }): void;
  /** 一个会话一轮结束了；用户正在主窗口里时外壳不理会 */
  notify(notice: { sessionId: string; title: string }): void;
  /** 主窗口最小化期间外壳定时发来（这时网页自己的定时器会被节流）；返回取消订阅的函数 */
  onTick(callback: () => void): () => void;
  /** 用户点了灵宠，主窗口已经恢复，要打开这个会话；返回取消订阅的函数 */
  onOpen(callback: (sessionId: string) => void): () => void;
  /** 用户在灵宠的右键菜单里关掉了灵宠；返回取消订阅的函数 */
  onDisabled(callback: () => void): () => void;
}

export interface DesktopFilesApi {
  /** 桌面版连的网关在这台机器上（这时网关能直接按本机路径读写文件） */
  localGateway(): Promise<boolean>;
  /** 拖进来的文件在这台机器上的路径 */
  pathForFile(file: File): string;
  /** 系统的打开文件对话框（可以多选），取消时 null */
  pickFiles(): Promise<string[] | null>;
  /** 系统的保存对话框，默认在「下载」文件夹、文件名是 name；取消时 null */
  pickSavePath(name: string): Promise<string | null>;
  /** 把这台机器上的一个文件放进系统剪贴板（同在文件管理器里复制）；文件不在这台机器上、没复制成时返回 false */
  copyFile(path: string): Promise<boolean>;
}

/** 窗口的采集源，和 desktop/src/capture.ts 的 CaptureSource 一致 */
export interface CaptureSource {
  /** desktopCapturer 的 id（window:…） */
  id: string;
  name: string;
  /** 应用图标（data URL） */
  icon?: string;
}

/** 内置浏览器的一个标签页，和 desktop/src/browser/views.ts 的 TabInfo 一致 */
export interface BrowserTabInfo {
  /** CDP 的 targetId（桌面版重启后恢复的标签页是新的） */
  id: string;
  /** 不随重启变的编号，重启后按它把面板里的标签对回恢复的标签页 */
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
  /** 一轮结束时留着（AI 开的临时标签页在一轮结束时关掉） */
  kept: boolean;
  /** 网页的图标（favicon）地址 */
  favicon?: string;
  /** 主框架没加载出来（Chromium 的错误码和名字，如 -105 ERR_NAME_NOT_RESOLVED），下一次跳转时清掉 */
  error?: { code: number; description: string; url: string };
  /** 正在打开、还没显示出来的网址（新建标签页时 url 还是 about:blank），加载期间地址栏和标签名显示这个 */
  pendingUrl?: string;
}

/** 内置浏览器标签页里的一次下载，和 desktop/src/browser/views.ts 的 UiDownload 一致 */
export interface BrowserDownload {
  guid: string;
  /** 在哪个标签页里下载的 */
  tabId: string | null;
  sessionId: string | null;
  /** 存下的文件名（同名时带 (1)）和本机上的位置 */
  filename: string;
  path: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  paused: boolean;
  receivedBytes: number;
  /** 不知道时是 0 */
  totalBytes: number;
  bytesPerSecond: number;
  /** 毫秒时间戳 */
  startTime: number;
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
  /** 这个标签页正显示着就收起来；显示的已经是别的标签页时什么也不做 */
  hide(id: string): void;
  /** 给网页拍一张快照（data URL），不在显示的标签页也能拍；界面盖住面板、切换标签页时贴在画面区域里垫着 */
  snapshot(id: string): Promise<string | null>;
  /** 地址栏的建议：浏览历史里网址或标题包含输入的 */
  suggest(query: string): Promise<BrowserSuggestion[]>;
  /** 标签页有变化时推来全部标签页；返回取消订阅的函数 */
  onTabs(callback: (tabs: BrowserTabInfo[]) => void): () => void;
  /** AI 切到了某个标签页 */
  onActivate(callback: (id: string) => void): () => void;
  /** 全部下载（进行中的和结束了的，每个会话只留最近 20 个） */
  downloads(): Promise<BrowserDownload[]>;
  /** 下载开始、有进度、结束时推来这一个的现状；返回取消订阅的函数 */
  onDownload(callback: (download: BrowserDownload) => void): () => void;
  /** 用系统默认程序打开存好的文件、在文件管理器里显示它、取消进行中的下载；文件不在了、还没存好时返回 false */
  downloadAction(guid: string, action: "open" | "show" | "cancel"): Promise<boolean>;
  /** 选择元素：传取元素的函数（gateway/src/shared/element-context.ts）打开检查模式，传 null 关掉；打不开时返回 false */
  inspect(id: string, fn: string | null): Promise<boolean>;
  /** 检查模式下选中了一个元素，见 desktop/src/browser/inspect.ts */
  onPicked(callback: (picked: BrowserPickedElement) => void): () => void;
  /** 在网页里按 Esc 退出了检查模式 */
  onInspectEnded(callback: (id: string) => void): () => void;
}

/** 内置浏览器里选中的元素，和 desktop/src/browser/inspect.ts 的 PickedElement 一致 */
export interface BrowserPickedElement {
  tabId: string;
  sessionId: string;
  url: string;
  element: SelectedElement;
  /** 元素在网页视口里的位置和视口大小（CSS 像素） */
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  /** 元素截图，PNG 的 base64 */
  screenshot?: string;
}

export const desktop: DesktopApi | undefined = (window as Window & { desktop?: DesktopApi }).desktop;

/** 系统文件管理器的叫法 */
export const fileManagerName = desktop?.platform === "darwin" ? "访达" : desktop?.platform === "win32" ? "资源管理器" : "文件管理器";

let localGatewayCheck: Promise<boolean> | undefined;
/** 同 useLocalGateway，给不在组件里的地方用（回复里文件链接的下载）；网页版是 false */
export function localGateway(): Promise<boolean> {
  if (!desktop?.files) return Promise.resolve(false);
  localGatewayCheck ??= desktop.files.localGateway().catch(() => false);
  return localGatewayCheck;
}
/**
 * 桌面版连的网关在这台机器上（网关存的文件、上传的附件就在本机，能按路径直接读写）；网页版是 false，还不知道时 null。
 * 只问一次外壳，各处共用结果
 */
export function useLocalGateway(): boolean | null {
  const [local, setLocal] = useState<boolean | null>(desktop?.files ? null : false);
  useEffect(() => {
    if (!desktop?.files) return;
    let alive = true;
    void localGateway().then((d) => alive && setLocal(d));
    return () => {
      alive = false;
    };
  }, []);
  return local;
}
