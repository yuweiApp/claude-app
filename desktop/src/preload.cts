// 预加载脚本：给网页提供窗口按钮（窗口没有系统边框，见 main.ts）和系统的文件夹对话框。
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
  onMaximizedChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: electron.IpcRendererEvent, maximized: boolean) => callback(maximized);
    ipcRenderer.on("window:maximized", listener);
    return () => void ipcRenderer.removeListener("window:maximized", listener);
  },
});
