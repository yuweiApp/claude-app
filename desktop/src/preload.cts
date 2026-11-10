// 预加载脚本：给网页提供窗口按钮（窗口没有系统边框，见 main.ts）、系统的文件夹对话框和文件管理器、内置浏览器和窗口采集。
// 沙箱里的预加载脚本只能是 CommonJS，所以是 .cts；接口类型和 client/src/desktop.ts 的 DesktopApi 一致
import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
  pickFolder: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke("dialog:pick-folder", defaultPath),
  showItemInFolder: (target: string): Promise<boolean> => ipcRenderer.invoke("shell:show-item", target),
  onMaximizedChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: electron.IpcRendererEvent, maximized: boolean) => callback(maximized);
    ipcRenderer.on("window:maximized", listener);
    return () => void ipcRenderer.removeListener("window:maximized", listener);
  },
  // 桌面工具正在操作的窗口：按标题找采集源（见 capture.ts），网页拿 id 调 getUserMedia
  findCaptureSource: (title: string): Promise<unknown> => ipcRenderer.invoke("capture:find", title),
  // 内置浏览器（右侧面板的「浏览器」），见 main.ts 和 browser/views.ts
  browser: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke("browser:list"),
    create: (sessionId: string, url?: string): Promise<unknown> => ipcRenderer.invoke("browser:create", sessionId, url),
    close: (id: string) => ipcRenderer.send("browser:close", id),
    navigate: (id: string, url: string) => ipcRenderer.send("browser:navigate", id, url),
    go: (id: string, action: string) => ipcRenderer.send("browser:go", id, action),
    show: (id: string, bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.send("browser:show", id, bounds),
    hide: () => ipcRenderer.send("browser:hide"),
    snapshot: (id: string): Promise<string | null> => ipcRenderer.invoke("browser:snapshot", id),
    suggest: (query: string): Promise<unknown[]> => ipcRenderer.invoke("browser:suggest", query),
    onTabs: (callback: (tabs: unknown[]) => void) => {
      const listener = (_event: electron.IpcRendererEvent, tabs: unknown[]) => callback(tabs);
      ipcRenderer.on("browser:tabs", listener);
      return () => void ipcRenderer.removeListener("browser:tabs", listener);
    },
    onActivate: (callback: (id: string) => void) => {
      const listener = (_event: electron.IpcRendererEvent, id: string) => callback(id);
      ipcRenderer.on("browser:activate", listener);
      return () => void ipcRenderer.removeListener("browser:activate", listener);
    },
  },
});
