import { EventEmitter } from "node:events";
import { BrowserWindow, screen, type NativeImage, type WebContents } from "electron";
import { AGENT_INPUT_ECHO_MS, type BrowserViews, type Tab } from "./views.js";

/**
 * 内置浏览器的「选择元素」，做法同 Claude 桌面版：悬停的高亮框用 CDP 自带的元素检查器画（Overlay.setInspectMode 的 searchForNode），
 * 不往网页里注入脚本。用户的鼠标按下、松开在外壳里拦下（before-mouse-event），网页收不到：检查器只管主框架所在的进程，
 * 跨进程的 iframe（别的网站嵌进来的）里的点击它拦不住，会直接点到网页上。点中的元素由 DOM.getNodeForLocation 判断
 * （同进程的 iframe 会找到里面的元素，跨进程的 iframe 是 <iframe> 本身），再执行界面传来的取元素函数
 * （gateway/src/shared/element-context.ts），拍一张元素的截图。AI 经 CDP 发的点击（刚发过 Input.* 命令的）照常交给网页。
 * 用的是标签页一直挂着的调试接口（和 AI 的 Playwright 同一个），只在主会话上收发。
 * 选完一个检查模式还开着，可以接着选；按 Esc、界面关掉时退出
 */

/** 截图在元素四周多拍的范围（CSS 像素）和最长边，同 Claude 桌面版 */
const SCREENSHOT_PADDING = 80;
const SCREENSHOT_MAX = 1200;
const OBJECT_GROUP = "claude-app-inspect";
/** 元素在顶层视口里的位置：在同进程的 iframe 里时一层层加上 iframe 内容区的位置；视口是顶层的 */
const RECT_FUNCTION = `function () {
  var r = this.getBoundingClientRect();
  var x = r.left, y = r.top;
  var w = this.ownerDocument.defaultView;
  try {
    while (w.frameElement) {
      var f = w.frameElement, fr = f.getBoundingClientRect(), cs = w.parent.getComputedStyle(f);
      x += fr.left + f.clientLeft + parseFloat(cs.paddingLeft);
      y += fr.top + f.clientTop + parseFloat(cs.paddingTop);
      w = w.parent;
    }
  } catch (e) {}
  return { x: x, y: y, width: r.width, height: r.height, vw: w.innerWidth, vh: w.innerHeight };
}`;

export interface PickedElement {
  tabId: string;
  sessionId: string;
  /** 选的时候网页的网址 */
  url: string;
  /** 取元素函数的返回值（SelectedElement） */
  element: unknown;
  /** 元素在网页视口里的位置和视口大小（CSS 像素） */
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  /** 元素截图（四周多拍 80px，最长边不超过 1200px），PNG 的 base64；拍不到时没有 */
  screenshot?: string;
}

interface Inspecting {
  /** 取元素的函数（Runtime.callFunctionOn 的 functionDeclaration） */
  fn: string;
  stop: () => void;
}

export class ElementInspector extends EventEmitter<{ picked: [PickedElement]; ended: [string] }> {
  private readonly active = new Map<string, Inspecting>();

  constructor(private readonly views: BrowserViews) {
    super();
  }

  /** 打开检查模式；标签页不存在时返回 false */
  async start(id: string, fn: string): Promise<boolean> {
    const tab = this.views.get(id);
    const wc = tab?.view.webContents;
    if (!tab || !wc || wc.isDestroyed()) return false;
    const current = this.active.get(id);
    if (current) {
      current.fn = fn;
      return true;
    }
    const onMouse = (e: Electron.Event, mouse: Electron.MouseInputEvent) => {
      if (mouse.type !== "mouseDown" && mouse.type !== "mouseUp") return;
      if (Date.now() - tab.lastAgentInput < AGENT_INPUT_ECHO_MS) return;
      e.preventDefault();
      if (mouse.type === "mouseDown" && mouse.button === "left") void this.pickAt(tab, mouse);
    };
    const onKey = (e: Electron.Event, input: Electron.Input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return;
      e.preventDefault();
      this.stop(id);
      this.emit("ended", id);
    };
    // 跳到别的网页后检查模式不一定还在，加载好了再开一次
    const onLoad = () => void enable(wc).catch(() => undefined);
    const onDestroyed = () => this.active.delete(id);
    wc.on("before-mouse-event", onMouse);
    wc.on("before-input-event", onKey);
    wc.on("dom-ready", onLoad);
    wc.once("destroyed", onDestroyed);
    this.active.set(id, {
      fn,
      stop: () => {
        wc.off("before-mouse-event", onMouse);
        wc.off("before-input-event", onKey);
        wc.off("dom-ready", onLoad);
        wc.off("destroyed", onDestroyed);
      },
    });
    try {
      await enable(wc);
      return true;
    } catch {
      this.stop(id);
      return false;
    }
  }

  stop(id: string): void {
    const current = this.active.get(id);
    if (!current) return;
    this.active.delete(id);
    current.stop();
    const wc = this.views.get(id)?.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    void (async () => {
      for (const method of ["Overlay.setInspectMode", "Overlay.hideHighlight", "Overlay.disable", "DOM.disable"]) {
        const params = method === "Overlay.setInspectMode" ? { mode: "none", highlightConfig: {} } : undefined;
        await wc.debugger.sendCommand(method, params).catch(() => undefined);
      }
    })();
  }

  /**
   * 鼠标按下的位置找元素。主框架里的点击用事件的 x、y（相对网页视图，DIP）。
   * 点在跨进程的 iframe 上时事件的 x、y 是相对那个 iframe 的，找到的是主框架里不相干的元素，
   * 所以再用鼠标的屏幕位置（screen.getCursorScreenPoint() 减去窗口内容区和网页视图的位置）找一次，那里是 <iframe> 时选它。
   * 不直接用屏幕位置：事件里的 globalX、globalY 在 Windows 上和 getContentBounds() 对不上（实测选中的元素偏了几百像素），
   * 屏幕坐标换算在多显示器、缩放下都不可靠
   */
  private async pickAt(tab: Tab, mouse: Electron.MouseInputEvent): Promise<void> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const zoom = wc.getZoomFactor();
    const dbg = wc.debugger;
    const nodeAt = async (x: number, y: number) =>
      (
        (await dbg.sendCommand("DOM.getNodeForLocation", {
          x: Math.round(x / zoom),
          y: Math.round(y / zoom),
          includeUserAgentShadowDOM: false,
          ignorePointerEventsNone: true,
        })) as { backendNodeId?: number }
      ).backendNodeId;
    // 点在滚动条等没有元素的地方时 getNodeForLocation 报错
    let node = await nodeAt(mouse.x, mouse.y).catch(() => undefined);
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.contentView.children.includes(tab.view));
    const view = tab.view.getBounds();
    if (win) {
      const content = win.getContentBounds();
      const cursor = screen.getCursorScreenPoint();
      const cx = cursor.x - content.x - view.x;
      const cy = cursor.y - content.y - view.y;
      const inside = cx >= 0 && cy >= 0 && cx < view.width && cy < view.height;
      if (inside && (Math.abs(cx - mouse.x) > 2 || Math.abs(cy - mouse.y) > 2)) {
        const other = await nodeAt(cx, cy).catch(() => undefined);
        if (other && other !== node && (await isFrame(wc, other))) node = other;
      }
    }
    if (node) await this.pick(tab, node);
  }

  private async pick(tab: Tab, backendNodeId: number): Promise<void> {
    const current = this.active.get(tab.id);
    const wc = tab.view.webContents;
    if (!current || wc.isDestroyed()) return;
    const dbg = wc.debugger;
    try {
      const { object } = (await dbg.sendCommand("DOM.resolveNode", { backendNodeId, objectGroup: OBJECT_GROUP })) as { object: { objectId?: string } };
      if (!object.objectId) return;
      const call = async <T>(functionDeclaration: string) =>
        ((await dbg.sendCommand("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration, returnByValue: true })) as { result: { value?: T } }).result.value;
      const element = await call<unknown>(current.fn);
      const box = await call<{ x: number; y: number; width: number; height: number; vw: number; vh: number }>(RECT_FUNCTION);
      if (!element || !box) {
        console.warn(`[inspect] ${tab.id}: 取元素信息没有结果`);
        return;
      }
      // 检查器的高亮框和提示会被拍进去：拍的时候先关掉检查模式，拍完再打开
      await dbg.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }).catch(() => undefined);
      await dbg.sendCommand("Overlay.hideHighlight").catch(() => undefined);
      const screenshot = await shoot(wc, box);
      if (this.active.get(tab.id) === current) await enable(wc).catch(() => undefined);
      this.emit("picked", {
        tabId: tab.id,
        sessionId: tab.sessionId,
        url: wc.getURL(),
        element,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
        viewport: { width: box.vw, height: box.vh },
        ...(screenshot ? { screenshot } : {}),
      });
    } catch (err) {
      // 元素在点完之后没了、网页跳走了
      console.warn(`[inspect] ${tab.id}: 取元素失败：${(err as Error).message}`);
    } finally {
      await dbg.sendCommand("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => undefined);
    }
  }
}

/** 是不是 <iframe>、<frame> 元素 */
async function isFrame(wc: WebContents, backendNodeId: number): Promise<boolean> {
  try {
    const { node } = (await wc.debugger.sendCommand("DOM.describeNode", { backendNodeId })) as { node: { nodeName: string } };
    return node.nodeName === "IFRAME" || node.nodeName === "FRAME";
  } catch {
    return false;
  }
}

async function enable(wc: WebContents): Promise<void> {
  const dbg = wc.debugger;
  await dbg.sendCommand("DOM.enable");
  await dbg.sendCommand("Overlay.enable");
  await dbg.sendCommand("Overlay.setInspectMode", {
    mode: "searchForNode",
    highlightConfig: {
      showInfo: true,
      contentColor: { r: 59, g: 130, b: 246, a: 0.15 },
      borderColor: { r: 37, g: 99, b: 235, a: 0.9 },
    },
  });
}

/** 元素四周多拍一圈，限在视口里；元素不在视口里时拍整个视口 */
async function shoot(wc: WebContents, box: { x: number; y: number; width: number; height: number; vw: number; vh: number }): Promise<string | undefined> {
  const zoom = wc.getZoomFactor();
  const left = Math.max(0, box.x - SCREENSHOT_PADDING);
  const top = Math.max(0, box.y - SCREENSHOT_PADDING);
  const right = Math.min(box.vw, box.x + box.width + SCREENSHOT_PADDING);
  const bottom = Math.min(box.vh, box.y + box.height + SCREENSHOT_PADDING);
  const visible = right - left >= 1 && bottom - top >= 1;
  try {
    const image = visible
      ? await wc.capturePage({ x: Math.round(left * zoom), y: Math.round(top * zoom), width: Math.round((right - left) * zoom), height: Math.round((bottom - top) * zoom) })
      : await wc.capturePage();
    return pngBase64(image);
  } catch {
    return undefined;
  }
}

/** 最长边缩到 1200px 以内，转成 PNG 的 base64；空图返回 undefined */
export function pngBase64(image: NativeImage): string | undefined {
  if (image.isEmpty()) return undefined;
  const { width, height } = image.getSize();
  const scale = Math.min(1, SCREENSHOT_MAX / Math.max(width, height));
  const sized = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : image;
  return sized.toPNG().toString("base64");
}
