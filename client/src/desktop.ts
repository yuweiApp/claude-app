/** 桌面版（Electron）预加载脚本注入的窗口接口，见 desktop/src/preload.cts；普通浏览器里没有 */
export interface DesktopApi {
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  /** 返回取消订阅的函数 */
  onMaximizedChange(callback: (maximized: boolean) => void): () => void;
}

export const desktop: DesktopApi | undefined = (window as Window & { desktop?: DesktopApi }).desktop;
