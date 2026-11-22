import type { BrowserContext, Frame, Locator, Page } from "playwright-core";

/**
 * 外部浏览器（经扩展连接的用户的 Chrome）：Playwright 的动作执行前，标签页不在前台就先切到前台。
 *
 * 浏览器窗口里不是当前显示的标签页，document.visibilityState 是 hidden，Chrome 不再给它出帧，requestAnimationFrame 不执行；
 * Playwright 判断元素「稳定」要等连续两帧位置不变，click 这类动作就停在「waiting for element to be visible, enabled and stable」直到超时。
 * 2026-11-22 在 home（Windows，Chrome 157）上经扩展实测：切到别的标签页后 click 5 秒超时，bringToFront 之后 41ms 点到。
 * 内置浏览器的停放窗口照常渲染，没有这个问题，所以只用在外部浏览器上（它的 Playwright 在网关主线程，内置浏览器的在各会话的 worker 里，
 * 原型互不相干）。用户在浏览器里正看着的标签页会被切走，这是用户定的：AI 操作时切到前台，不分是不是用户选的标签页。
 */

/** 要等元素可见、稳定的动作（Playwright 文档的 Actionability 表里要求 Stable 的），加上截图（后台的标签页不出画面） */
const POINTER = ["click", "dblclick", "hover", "tap", "check", "uncheck", "setChecked"];
const METHODS = {
  page: [...POINTER, "dragAndDrop", "screenshot"],
  // Page 的这些方法转给主框架的同名方法，Locator 的转给它所在框架的同名方法（playwright-core 1.65），再查一次只是多一次很快的 evaluate
  frame: [...POINTER, "dragAndDrop"],
  locator: [...POINTER, "dragTo", "screenshot", "scrollIntoViewIfNeeded"],
};
/** 读可见状态最多等这么久：网页弹着 alert 这类对话框时 evaluate 不返回，这时不切，照原样执行动作 */
const CHECK_MS = 1000;
const PATCHED = Symbol.for("claude-app.foreground");

/** 同一个标签页正在查的那一次：Page 的方法转给 Frame 的同名方法时不重复查 */
const checking = new WeakMap<Page, Promise<void>>();

function bringForward(page: Page): Promise<void> {
  let pending = checking.get(page);
  if (!pending) {
    pending = (async () => {
      const state = await Promise.race([
        page.evaluate("document.visibilityState").catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CHECK_MS)),
      ]);
      if (state === "hidden") await page.bringToFront().catch(() => undefined);
    })().finally(() => checking.delete(page));
    checking.set(page, pending);
  }
  return pending;
}

function wrap<T>(proto: object, names: string[], pageOf: (self: T) => Page): void {
  const target = proto as Record<string | symbol, unknown>;
  if (target[PATCHED]) return;
  target[PATCHED] = true;
  for (const name of names) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = async function (this: T, ...args: unknown[]) {
      await bringForward(pageOf(this));
      return original.apply(this, args);
    };
  }
}

/** 改的是原型，所有会话共用，只改一次；连上时还没有标签页就等第一个 */
export function bringToFrontBeforeActions(context: BrowserContext): void {
  const page = context.pages()[0];
  if (!page) {
    context.once("page", () => bringToFrontBeforeActions(context));
    return;
  }
  wrap<Page>(Object.getPrototypeOf(page), METHODS.page, (self) => self);
  wrap<Frame>(Object.getPrototypeOf(page.mainFrame()), METHODS.frame, (self) => self.page());
  wrap<Locator>(Object.getPrototypeOf(page.locator("html")), METHODS.locator, (self) => self.page());
}
