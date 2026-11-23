// 灵宠窗口（desktop/assets/pet.html）的预加载脚本，见 pet.ts
import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("pet", {
  state: (): Promise<unknown> => ipcRenderer.invoke("pet:state"),
  onState: (callback: (state: unknown) => void) => {
    ipcRenderer.on("pet:state", (_event, state: unknown) => callback(state));
  },
  onDone: (callback: (notice: unknown) => void) => {
    ipcRenderer.on("pet:done", (_event, notice: unknown) => callback(notice));
  },
  /** 恢复主窗口并打开这个会话（不传是最近完成的那个） */
  open: (sessionId?: string) => ipcRenderer.send("pet:open", sessionId),
  /** 清掉完成的通知 */
  dismiss: () => ipcRenderer.send("pet:dismiss"),
  /** 拖动：按屏幕像素挪窗口 */
  move: (dx: number, dy: number) => ipcRenderer.send("pet:move", dx, dy),
  /** 弹出右键菜单 */
  menu: () => ipcRenderer.send("pet:menu"),
  /** 鼠标在不在小精灵、气泡上（不在时鼠标穿过透明的窗口） */
  hover: (over: boolean) => ipcRenderer.send("pet:hover", over),
});
