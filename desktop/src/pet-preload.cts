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
  /** 拖动：把窗口挪到这个位置（屏幕坐标，窗口左上角），外壳会限制在小精灵眼睛还露着的范围里 */
  move: (x: number, y: number) => ipcRenderer.send("pet:move", x, y),
  /** 拖动开始（true）、结束（false）：开始时外壳停下正在跳的舞、取别的窗口的边，松手时站在线上就跳一段舞 */
  drag: (active: boolean) => ipcRenderer.send("pet:drag", active),
  /** 跳舞时外壳让换的姿势：facing 是侧面朝哪边（null 是正面），motion 是 walk（蹦着走）、flip（原地翻跟头）、stand */
  onPose: (callback: (pose: unknown) => void) => {
    ipcRenderer.on("pet:pose", (_event, pose: unknown) => callback(pose));
  },
  /** 弹出右键菜单 */
  menu: () => ipcRenderer.send("pet:menu"),
  /** 鼠标在不在小精灵、气泡上（不在时鼠标穿过透明的窗口） */
  hover: (over: boolean) => ipcRenderer.send("pet:hover", over),
  /** 鼠标在不在灵宠或实时回复卡片上：卡片开着时都移出了就收起 */
  peek: (source: "pet" | "card", over: boolean) => ipcRenderer.send("pet:peek-hover", source, over),
  /** 双击灵宠：有会话在跑时弹出（开着时收起）实时回复卡片，否则恢复主窗口并打开这个会话（不传是最近完成的那个） */
  activate: (sessionId?: string) => ipcRenderer.send("pet:activate", sessionId),
  /** 实时回复卡片当前显示的状态 */
  live: (): Promise<unknown> => ipcRenderer.invoke("pet:live-state"),
  onLive: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("pet:live", (_event, payload: unknown) => callback(payload));
  },
  /** 实时回复卡片有没有打开（打开时灵宠窗口暂时藏起「N 个会话在跑」的小胶囊） */
  onPeeking: (callback: (active: boolean) => void) => {
    ipcRenderer.on("pet:peeking", (_event, active: boolean) => callback(active));
  },
});
