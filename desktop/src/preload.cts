// 预加载脚本：给网页提供窗口按钮（窗口没有系统边框，见 main.ts）、系统的文件夹对话框和文件管理器、内置浏览器和窗口采集。
// 沙箱里的预加载脚本只能是 CommonJS，所以是 .cts；接口类型和 client/src/desktop.ts 的 DesktopApi 一致
import electron = require("electron");

const { contextBridge, ipcRenderer, webUtils } = electron;

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
  pickFolder: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke("dialog:pick-folder", defaultPath),
  showItemInFolder: (target: string): Promise<boolean> => ipcRenderer.invoke("shell:show-item", target),
  openFolder: (target: string): Promise<boolean> => ipcRenderer.invoke("shell:open-folder", target),
  onMaximizedChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: electron.IpcRendererEvent, maximized: boolean) => callback(maximized);
    ipcRenderer.on("window:maximized", listener);
    return () => void ipcRenderer.removeListener("window:maximized", listener);
  },
  // 桌面工具正在操作的窗口：按标题找采集源（见 capture.ts），网页拿 id 调 getUserMedia
  findCaptureSource: (title: string): Promise<unknown> => ipcRenderer.invoke("capture:find", title),
  // 界面上一块区域的截图（PNG base64），右侧面板 HTML 预览里选中的元素用
  captureRect: (rect: { x: number; y: number; width: number; height: number }): Promise<string | null> => ipcRenderer.invoke("window:capture", rect),
  // 文件树的上传、下载：文件在这台机器上的路径，网关在这台机器上时直接按路径复制（见 main.ts 的 files:*）
  files: {
    localGateway: (): Promise<boolean> => ipcRenderer.invoke("files:local-gateway"),
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    pickFiles: (): Promise<string[] | null> => ipcRenderer.invoke("files:pick"),
    pickSavePath: (name: string): Promise<string | null> => ipcRenderer.invoke("files:pick-save", name),
  },
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
    // 选择元素：传取元素的函数打开检查模式，传 null 关掉
    inspect: (id: string, fn: string | null): Promise<boolean> => ipcRenderer.invoke("browser:inspect", id, fn),
    onPicked: (callback: (picked: unknown) => void) => {
      const listener = (_event: electron.IpcRendererEvent, picked: unknown) => callback(picked);
      ipcRenderer.on("browser:picked", listener);
      return () => void ipcRenderer.removeListener("browser:picked", listener);
    },
    onInspectEnded: (callback: (id: string) => void) => {
      const listener = (_event: electron.IpcRendererEvent, id: string) => callback(id);
      ipcRenderer.on("browser:inspect-ended", listener);
      return () => void ipcRenderer.removeListener("browser:inspect-ended", listener);
    },
    onTabs: (callback: (tabs: unknown[]) => void) => {
      const listener = (_event: electron.IpcRendererEvent, tabs: unknown[]) => callback(tabs);
      ipcRenderer.on("browser:tabs", listener);
      return () => void ipcRenderer.removeListener("browser:tabs", listener);
    },
    downloads: (): Promise<unknown[]> => ipcRenderer.invoke("browser:downloads"),
    downloadAction: (guid: string, action: string): Promise<boolean> => ipcRenderer.invoke("browser:download-action", guid, action),
    onDownload: (callback: (download: unknown) => void) => {
      const listener = (_event: electron.IpcRendererEvent, download: unknown) => callback(download);
      ipcRenderer.on("browser:download", listener);
      return () => void ipcRenderer.removeListener("browser:download", listener);
    },
    onActivate: (callback: (id: string) => void) => {
      const listener = (_event: electron.IpcRendererEvent, id: string) => callback(id);
      ipcRenderer.on("browser:activate", listener);
      return () => void ipcRenderer.removeListener("browser:activate", listener);
    },
  },
});
