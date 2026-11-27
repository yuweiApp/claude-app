import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import type { BrowserContext, Page } from "playwright-core";
import { CodeRepl, errorText, show, transform } from "../code-repl.js";
import type { ToolOutput } from "../tool-result.js";
import type { DownloadInfo, TabEvent } from "./host.js";

/**
 * browser_run_code 的执行环境：每个会话在每个浏览器里一个常驻的 REPL（code-repl.ts 的 CodeRepl），全局有 page、context 等。
 * vm 不是安全边界，所以 browser_run_code 等同于 Bash，不放进 allowedTools，非「完全访问权限」时走权限卡片
 */

/**
 * 不指定 timeout_ms 时等多久；上限见 MAX_TIMEOUT_MS。
 * 比 Playwright 单个动作的默认超时（30 秒）长：一样长时两者几乎同时到点，先返回的是笼统的「超过 timeout_ms」，
 * Playwright 报的具体原因（哪个元素、不可见还是被挡住）就丢了
 */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Playwright 报超时（动作超时时 Call log 里会写元素被什么挡住）：结果里附上 page 此刻的截图 */
const PLAYWRIGHT_TIMEOUT = /Timeout \d+ms exceeded/;
/** 自动截图最多等多久：截不到就不附 */
const AUTO_SCREENSHOT_MS = 3000;
/** 单次调用最长等多久：网页里的 AI 生成、查询这类要几分钟的，一次调用就能等完 */
export const MAX_TIMEOUT_MS = 15 * 60_000;
/** 工具自己附的说明（标签页的变化、临时标签页的提醒）里，网址最多显示这么多个字符 */
export const MAX_URL_CHARS = 100;

/**
 * 工具自己附的说明里的网址：太长的只留开头，说明总共多长。登录跳转这类网址能有上千个字符（redirectURL 里再套一层编码过的网址），
 * 模型要的是「哪个标签页」，完整的它能用 page.url() 取。代码自己打印的输出不动
 */
export function shortUrl(url: string): string {
  return url.length <= MAX_URL_CHARS ? url : `${url.slice(0, MAX_URL_CHARS)}…（共 ${url.length} 个字符）`;
}

/** 浏览器工具的输出：文字（可以是空的）和图片，只有普通数据，能在 worker 和主线程之间传；加上标签页的情况 */
export interface RunResult extends ToolOutput {
  /** 这次调用前后的标签页和当前页网址，判断有没有打开新网页（内置浏览器用它提醒 keepTab()） */
  opened: boolean;
  /** 调用结束时 context.pages() 里每个标签页的完整网址，按序号；临时标签页的提醒里按它标出序号 */
  tabs: string[];
}

/**
 * 浏览器工具用到的 REPL。两种实现：BrowserRepl 在当前线程里跑（Chrome 用，在网关主线程），
 * WorkerRepl 把调用转给这个会话自己的 worker 线程、worker 里再用 BrowserRepl（内置浏览器用，见 worker-repl.ts）
 */
export interface Repl {
  /** 有 browser_run_code 还在跑（包括转到后台的）：一轮结束时先不关内置浏览器的临时标签页，代码可能还在用 */
  readonly busy: boolean;
  run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult>;
  /** 删会话时调用 */
  dispose(): void;
}


/**
 * 一个会话在一个浏览器（内置浏览器或用户的 Chrome）里的 REPL。getContext 每次调用前取一次：
 * 断开重连后 context 换成新的，page 指向已关闭或旧连接里的标签页时换成当前最后一个标签页。
 * 在哪个线程建就在哪个线程跑：Chrome 的建在网关主线程，内置浏览器的建在这个会话的 worker 里（worker.ts）
 */
export class BrowserRepl extends CodeRepl implements Repl {
  /**
   * Chrome 那边标签页的变化（内置浏览器的由桌面版发来，见 tabEvents）：不是 AI 开的、不是 AI 关的。
   * 模型下一次调用浏览器工具时告诉它（describeChanges），免得它照旧用存着的 page、出错了才知道
   */
  private localChanges: LocalChange[] = [];
  /** 上一次 browser_run_code 结束的时间：结束后不久网页才弹出的，是那次调用里的点击按键触发的（同桌面版的 POPUP_TRIGGER_MS） */
  private lastRunEnd = 0;
  /** page 原来指向的标签页被关了，已经换成了别的（最后一个标签页，或者 undefined） */
  private pageReplaced = false;
  /** 模型已经知道的标签页：上次告诉它变化时开着的，和它自己开的。不在里面的是新出现、它还不知道的 */
  private readonly known = new WeakSet<Page>();
  /**
   * 代码里的 page（当前标签页）。vm 里的 page 是全局对象上的访问器（见构造函数）：模型给它赋了另一个标签页时
   * 调用 bringToFront，内置浏览器的面板跟着切过去。网关这边换 page（标签页被关）直接改这个字段，不经访问器
   */
  private currentPage: unknown;
  /** 已经挂上关闭事件的浏览器上下文（断开重连后是新的） */
  private watched: BrowserContext | null = null;
  /**
   * keepTab() 返回过的对象。模型多半只写一句 `await keepTab();`，返回值就成了这次的结果，登录跳转这类网址一千多个字符全印出来；
   * 结果就是这个对象时网址按 shortUrl 显示，代码里拿到的值不变（t.url 还是完整的）。模型自己 console.log 的不动
   */
  private readonly keptResults = new WeakSet<object>();

  /**
   * @param tabEvents 内置浏览器：取走桌面版发来的标签页变化（带着是谁做的，见 host.ts 的 TabEvent）；
   *   Chrome 没有，在这里自己记（Playwright 的事件里看不出是用户还是网页，只能分出是不是 AI）
   * @param downloads 内置浏览器：这个会话的下载和进度，代码里的全局函数 downloads() 就是它；外部浏览器没有
   * @param keepTab 内置浏览器：把 AI 最近操作的标签页留给用户（经主线程问桌面版）；代码里的全局函数 keepTab(标签页?) 在它外面包了一层
   * @param saveFile 外部浏览器：把数据写进这个会话的工作目录，代码里的全局函数 saveFile() 就是它（external.ts）。
   *   扩展连接的浏览器上 Playwright 的 download 事件不会触发，下载的文件在哪也不知道，代码拿到数据后自己存
   * @param readFile 读这个会话工作目录里的文件，代码里的全局函数 readFile(name, encoding?) 就是它加上解码（external.ts 的 fileReader）
   */
  constructor(
    private readonly getContext: (signal?: AbortSignal) => Promise<BrowserContext>,
    private readonly tabEvents?: () => TabEvent[],
    downloads?: () => Promise<DownloadInfo[]>,
    saveFile?: (name: string, data: unknown) => Promise<string>,
    keepTab?: () => Promise<{ title: string; url: string } | null>,
    readFile?: (name: string) => Promise<Buffer>,
  ) {
    super("browser");
    Object.assign(this.sandbox, {
      ...(downloads ? { downloads } : {}),
      ...(saveFile ? { saveFile } : {}),
      ...(keepTab
        ? {
            /**
             * 不传参数留下 AI 最近操作的标签页；传一个标签页（page、context.pages() 里的）留下它。
             * 指定的那个靠 bringToFront 告诉桌面版：桌面版把它算作对这个标签页的一次操作（cdp-proxy.ts 的 Page.bringToFront，
             * 面板也切过去），它就成了「最近操作的」，接着的 keep 留下的就是它。不用另加消息，旧版本的桌面版也能用
             */
            keepTab: async (target?: unknown) => {
              if (target !== undefined) {
                const tabPage = target as Partial<Page> | null;
                if (!tabPage || typeof tabPage !== "object" || typeof tabPage.bringToFront !== "function" || typeof tabPage.isClosed !== "function") {
                  throw new Error("keepTab 的参数是要留下的标签页（page，或 context.pages() 里的一个）；不传参数时留下你最近操作的那个");
                }
                if (tabPage.isClosed()) throw new Error("keepTab：这个标签页已经关闭了");
                await tabPage.bringToFront();
              }
              const tab = await keepTab();
              if (tab) this.keptResults.add(tab);
              return tab;
            },
          }
        : {}),
      ...(readFile
        ? {
            /** 同 Node 的 fs.readFile：不传编码返回 Buffer，传了返回字符串 */
            readFile: async (name: string, encoding?: unknown) => {
              if (encoding !== undefined && encoding !== null && !(typeof encoding === "string" && Buffer.isEncoding(encoding))) {
                throw new Error('readFile 的第二个参数是编码（如 "utf8"、"base64"），不传时返回 Buffer');
              }
              const bytes = await readFile(name);
              return typeof encoding === "string" ? bytes.toString(encoding as BufferEncoding) : bytes;
            },
          }
        : {}),
    });
    Object.defineProperty(this.sandbox, "page", {
      enumerable: true,
      get: () => this.currentPage,
      set: (value: unknown) => {
        const previous = this.currentPage;
        this.currentPage = value;
        // 换成了另一个还开着的标签页：切到前台（内置浏览器的面板跟着切；不等它，失败也不影响代码）
        const next = value as Partial<Page> | null | undefined;
        if (value !== previous && typeof next?.bringToFront === "function" && !next.isClosed?.()) next.bringToFront().catch(() => undefined);
      },
    });
  }

  /**
   * 取 context，page 指向已关闭或旧连接里的标签页时换成最后一个标签页；记下现在开着的标签页（seen）。
   * note：page 被换掉要不要告诉模型（调用开头要；调用结束时是代码自己关的，不用）。
   * signal：这次调用被取消时不再等连接（外部浏览器第一次连要等用户在连接页上点允许，不限时）
   */
  private async sync(note: boolean, signal?: AbortSignal): Promise<{ context: BrowserContext; page: Page | undefined }> {
    const context = await this.getContext(signal);
    this.watch(context);
    this.sandbox.context = context;
    const page = this.currentPage as Page | undefined;
    const usable = page && typeof page.isClosed === "function" && !page.isClosed() && page.context() === context;
    if (!usable) {
      if (note && page && typeof page.isClosed === "function" && page.isClosed()) this.pageReplaced = true;
      this.currentPage = context.pages().at(-1);
    }
    return { context, page: this.currentPage as Page | undefined };
  }

  /**
   * 记下 AI 自己开、关的标签页（trackAgent），Chrome 再挂上新开、关闭的事件，记下不是 AI 做的那些。
   * 内置浏览器不挂：桌面版知道每一次是谁做的，发来的事件更准
   */
  private watch(context: BrowserContext): void {
    if (this.watched === context) return;
    this.watched = context;
    trackAgent(context);
    if (this.tabEvents) return;
    const push = (change: LocalChange) => {
      if (this.localChanges.length < 30) this.localChanges.push(change);
    };
    const onClose = (page: Page) => {
      // 关掉之后取不到标题，先记着
      void titleOf(page).then((title) => titles.set(page, title));
      page.once("close", () => {
        const auto = autoClosed.get(page);
        // 网址不带查询参数：连接页的参数里可能有 token
        if (auto) return push({ who: auto, url: page.url().split("?")[0] ?? "", title: titles.get(page) ?? "" });
        if (agentClosed.has(page)) return;
        push({ who: "不是你关的标签页被关闭了（用户在浏览器里关的，或网页自己关的）", url: page.url(), title: titles.get(page) ?? "" });
      });
    };
    context.pages().forEach(onClose);
    context.on("page", (page) => {
      trackPage(page);
      onClose(page);
      // newPage 返回之前就会发 page 事件：正在 newPage 的是 AI 开的
      if ((creating.get(context) ?? 0) > 0) return;
      const running = this.busy;
      const sinceRun = Date.now() - this.lastRunEnd;
      void page.opener().then(
        (opener) =>
          push({
            who: !opener
              ? "用户新开了标签页"
              : running
                ? "在你的代码运行期间，网页弹出了新标签页"
                : sinceRun <= POPUP_TRIGGER_MS
                  ? `你上一次调用里的操作让网页弹出了新标签页（在调用结束 ${(sinceRun / 1000).toFixed(1)} 秒后才弹出）`
                  : "在你的代码没有运行时，网页弹出了新标签页（是用户在网页里点击，或网页自己弹出的）",
            page,
          }),
        () => undefined,
      );
    });
  }

  /** 自上次调用以来标签页的变化，放在这次结果的开头（浏览器工具调用开头都取一次）；说过就清掉 */
  private takeNotice(): Promise<string | undefined> {
    return this.describeChanges("自上次调用以来，标签页有这些变化：");
  }

  /**
   * 标签页的变化和是谁做的（AI 自己开、关的不说），说过就清掉；没有返回 undefined。
   * 内置浏览器用桌面版发来的事件（tabEvents），Chrome 用这里记的（localChanges）；
   * 再加上 page 是不是被换掉了、新出现的（不是 AI 开的）标签页在 context.pages() 里的序号
   */
  private async describeChanges(header: string): Promise<string | undefined> {
    const lines: string[] = [];
    let turnEnd = false;
    const page = this.currentPage as Page | undefined;
    // 代码自己等到弹出的标签页、赋给了 page 的，它知道，不说（内置浏览器的事件里没有 Page 对象，按「page 是新出现的、网址一样」认）
    const isOwnPopup = (url: string) => !!page && !page.isClosed() && !this.known.has(page) && page.url() === url;
    for (const event of this.tabEvents?.() ?? []) {
      if (event.kind === "opened" && isOwnPopup(event.url)) continue;
      const line = describeEvent(event);
      if (line) lines.push(`- ${line}`);
      if (event.kind === "closed" && event.by === "turn-end") turnEnd = true;
    }
    for (const change of this.localChanges) {
      if (change.page && change.page === page) continue;
      const target = change.page
        ? `${(await titleOf(change.page)) || "（无标题）"} — ${shortUrl(change.page.url())}`
        : `${change.title ? `${change.title} — ` : ""}${shortUrl(change.url ?? "")}`;
      lines.push(`- ${change.who}：${target}`);
    }
    this.localChanges = [];
    if (this.pageReplaced) {
      lines.push(`- page 原来指向的标签页已经关闭，${page ? `现在 page 指向 ${shortUrl(page.url())}` : "现在没有标签页，page 是 undefined"}`);
      this.pageReplaced = false;
    }
    const pages = this.watched?.pages() ?? [];
    // 刷新记着的标题（关掉之后取不到）：标签页刚出现时多半还没加载，那时记的是空的
    if (!this.tabEvents) for (const p of pages) void titleOf(p).then((t) => t && titles.set(p, t));
    const fresh = pages.filter((p) => !this.known.has(p) && !agentCreated.has(p) && p !== page && !p.isClosed());
    pages.forEach((p) => this.known.add(p));
    if (!lines.length && !fresh.length) return undefined;
    const out = [header, ...lines];
    if (fresh.length) {
      const list = await Promise.all(fresh.map(async (p) => `[${pages.indexOf(p)}] ${(await titleOf(p)) || "（无标题）"} — ${shortUrl(p.url())}`));
      out.push(`不是你开的新标签页（序号是在 context.pages() 里的位置）：${list.join("；")}。page 仍指向 ${page && !page.isClosed() ? shortUrl(page.url()) : "undefined"}。`);
    }
    if (turnEnd) out.push("你开的标签页在一轮结束时会自动关闭，除非调用过 keepTab()；留下的会一直在用户的面板里，下一轮也还在。");
    return `（${out.join("\n")}）`;
  }

  async run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    let script: string;
    try {
      script = transform(code);
    } catch (err) {
      return { text: `语法错误：${(err as Error).message}`, images: [], isError: true, opened: false, tabs: [] };
    }
    const { context } = await this.sync(true, signal);
    // 上次调用以来被关掉的标签页：放在这次结果的最前面（在跑代码之前取，代码自己关的不算）
    const notice = await this.takeNotice();
    const before = snapshotPages(context, this.currentPage as Page | undefined);
    const { run, outcome } = await this.execute(script, timeoutMs, signal, {
      timeout: (seconds) => `超过 timeout_ms（${seconds} 秒）还没跑完，这次调用先返回了；代码可能还在继续跑（比如还在等某个元素）。`,
      abort: "已取消。",
    });
    // 跑完后 page 可能被代码换掉或关掉了，按新的状态比较
    const after = snapshotPages(context, (await this.sync(false).catch(() => null))?.page);
    const opened = after.pages.some((p) => !before.pages.includes(p)) || (after.current !== undefined && after.current === before.current && after.url !== before.url);
    this.lastRunEnd = Date.now();
    // 这次调用期间标签页的变化（网页弹出的、用户这时关掉的……；AI 自己开、关的不说）
    const changes = await this.describeChanges("这次调用期间，标签页有这些变化：");
    const { text, isError } = this.describe(run, outcome, {
      head: notice,
      tail: changes,
      showValue: (value) => {
        const kept = typeof value === "object" && value !== null && this.keptResults.has(value) ? (value as { title: string; url: string }) : null;
        return show(kept && typeof kept.url === "string" ? { ...kept, url: shortUrl(kept.url) } : value);
      },
      // 没有标签页时 page.goto(...) 报「reading 'goto'」，看不出是 page 没有，补上这个事实
      errorNote: () => (this.currentPage === undefined ? "（现在没有标签页，page 是 undefined。）" : undefined),
    });
    const shot = "error" in outcome && run.images.length === 0 ? await this.timeoutScreenshot(outcome.error, after.current) : null;
    const tabs = after.pages.map((p) => (p.isClosed() ? "" : p.url()));
    if (!shot) return { text, images: run.images, isError, opened, tabs };
    return { text: `${text}\n${shot.note}`, images: [shot.image], isError, opened, tabs };
  }

  /**
   * 这次调用抛的错是 Playwright 的超时（只看这次的错误，不看 console 输出和之前的后台错误）：截超时的那个标签页此刻的画面。
   * 认得出是哪个标签页（见 tagFailures）就截它，认不出截 page；说明里写清截的是哪个
   */
  private async timeoutScreenshot(error: unknown, page: Page | undefined): Promise<{ image: { data: string; mimeType: string }; note: string } | null> {
    if (!PLAYWRIGHT_TIMEOUT.test(errorText(error))) return null;
    const failed = error && typeof error === "object" ? await failedOn.get(error) : undefined;
    const target = failed ?? page;
    if (!target || target.isClosed()) return null;
    const shot = await target.screenshot({ type: "jpeg", quality: 75, scale: "css", timeout: AUTO_SCREENSHOT_MS }).catch(() => null);
    if (!shot) return null;
    const url = shortUrl(target.url());
    const index = target.context().pages().indexOf(target);
    const which = !failed ? ` page（${url}）` : target === page ? `超时的标签页，即 page（${url}）` : `超时的标签页（${index >= 0 ? `context.pages()[${index}]，` : ""}${url}）`;
    return { image: { data: shot.toString("base64"), mimeType: "image/jpeg" }, note: `（出错后附上了${which}此刻的截图。）` };
  }
}

/** 标题：后台冻结的标签页 title() 可能迟迟不回，最多等 1 秒 */
export function titleOf(page: Page): Promise<string> {
  return Promise.race([page.title().catch(() => ""), new Promise<string>((resolve) => setTimeout(() => resolve(""), 1000))]);
}

/** 弹出窗口出现前多久之内结束的调用，算是那次调用里的操作触发了它（同桌面版 views.ts 的 POPUP_TRIGGER_MS） */
const POPUP_TRIGGER_MS = 2000;

/** Chrome 那边记下的一条标签页变化：新开的记标签页本身（说的时候取最新的标题、网址），关掉的记当时的网址、标题 */
interface LocalChange {
  who: string;
  page?: Page;
  url?: string;
  title?: string;
}

/**
 * AI 自己开、关的标签页：给 Playwright 的 BrowserContext.newPage、Page.close 加一层记录（改的是原型，所有会话共用，只改一次）。
 * 网关里调用这两个方法的除了模型的代码（浏览器工具自己不开不关标签页），只有导入登录状态时临时开、马上关掉的空白页
 * （external.ts 的 externalCookies），它也按 AI 自己开关的算，不告诉模型
 */
const agentCreated = new WeakSet<Page>();
const agentClosed = new WeakSet<Page>();
/** 网关自己关的标签页（不是 AI，也不是用户）和给模型看的说法，见 closeAutomatically */
const autoClosed = new WeakMap<Page, string>();
/**
 * 网关自己关一个标签页（外部浏览器的连接页，external.ts）：各会话下一次工具结果里按 who 说明是谁关的，
 * 不说成「不是你关的（用户或网页关的）」
 */
export function closeAutomatically(page: Page, who: string): Promise<void> {
  autoClosed.set(page, who);
  return page.close();
}
/** 正在 newPage 的次数：newPage 返回之前就会发 page 事件，这时出现的标签页是 AI 开的 */
const creating = new WeakMap<BrowserContext, number>();
/** 标签页的标题，关掉之后取不到，先记着 */
const titles = new WeakMap<Page, string>();
const TRACKED = Symbol.for("claude-app.trackAgent");

function trackAgent(context: BrowserContext): void {
  const proto = Object.getPrototypeOf(context) as BrowserContext & { [TRACKED]?: boolean };
  if (!proto[TRACKED]) {
    proto[TRACKED] = true;
    const newPage = proto.newPage;
    proto.newPage = async function (this: BrowserContext, ...args: Parameters<BrowserContext["newPage"]>) {
      creating.set(this, (creating.get(this) ?? 0) + 1);
      try {
        const page = await newPage.apply(this, args);
        agentCreated.add(page);
        trackPage(page);
        return page;
      } finally {
        creating.set(this, (creating.get(this) ?? 1) - 1);
      }
    };
  }
  context.pages().forEach(trackPage);
}

function trackPage(page: Page): void {
  const proto = Object.getPrototypeOf(page) as Page & { [TRACKED]?: boolean };
  if (proto[TRACKED]) return;
  proto[TRACKED] = true;
  const close = proto.close;
  proto.close = function (this: Page, ...args: Parameters<Page["close"]>) {
    agentClosed.add(this);
    return close.apply(this, args);
  };
  tagFailures(proto);
}

/**
 * 出错的 Playwright 调用是在哪个标签页上：模型常把别的标签页存进自己的变量（const aws = context.pages()[1]），
 * 超时后截全局 page 截到的是另一个标签页（timeoutScreenshot）。Playwright 的错误里没有标签页，这里记下错误和标签页
 * （ElementHandle 的要再问一次它在哪个 frame，所以可能是 Promise）
 */
const failedOn = new WeakMap<object, Page | Promise<Page | undefined>>();
const TAGGED = Symbol.for("claude-app.failedOn");

/**
 * 在 Playwright 客户端所有对象的基类（ChannelOwner）的 _wrapApiCall 上包一层：Page、Frame、ElementHandle、Locator（转给 Frame）、
 * Keyboard、Mouse（转给 Page）的每个调用都经过它，this 是发出调用的对象，调用失败时由它找出标签页记下（最里层先记，外层不覆盖）。
 * 包的这层要用 vm 编译、文件名放在 playwright-core 目录里：Playwright 按调用栈里哪些帧在它自己的目录下，
 * 认出用户调的是哪个 API（报错开头的 locator.isDisabled: 这类名字），夹进一个网关的帧，名字就成了 frame._wrapApiCall。
 * 直接给 Page、Frame 的公开方法包一层也不行：page.click 在内部调 frame.click，报错会变成 frame.click:。
 * _wrapApiCall 是 Playwright 的内部方法，以后改了名就不包，超时只截 page
 */
function tagFailures(pageProto: object): void {
  let owner: object | null = pageProto;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, "_wrapApiCall")) owner = Object.getPrototypeOf(owner) as object | null;
  const target = owner as { _wrapApiCall?: unknown } | null;
  // 标记用自己的、只看自身属性：这是 Page、BrowserContext 共同的基类，用 TRACKED 的话它们的原型会继承到，trackAgent 就以为包过了
  if (!target || Object.prototype.hasOwnProperty.call(target, TAGGED) || typeof target._wrapApiCall !== "function") return;
  Object.defineProperty(target, TAGGED, { value: true });
  const coreDir = path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"));
  const wrap = vm.runInThisContext(
    `(function (original, onFailure) {
      return function _wrapApiCall(...args) {
        const result = original.apply(this, args);
        return result instanceof Promise ? result.catch((err) => { onFailure(this, err); throw err; }) : result;
      };
    })`,
    { filename: path.join(coreDir, "claude-app-failed-on.js") },
  ) as (original: unknown, onFailure: (self: unknown, err: unknown) => void) => unknown;
  target._wrapApiCall = wrap(target._wrapApiCall, (self, err) => {
    if (!err || typeof err !== "object" || failedOn.has(err)) return;
    try {
      const page = pageOfOwner(self);
      if (page) failedOn.set(err, page);
    } catch {
      // 取不到标签页就不记
    }
  });
}

/** 发出调用的对象在哪个标签页：Page 自己、Frame 的 page()、ElementHandle 问 ownerFrame()；别的（BrowserContext 等）没有 */
function pageOfOwner(self: unknown): Page | Promise<Page | undefined> | undefined {
  const o = self as Partial<{ ownerFrame(): Promise<{ page(): Page } | null>; page(): Page; mainFrame(): unknown }> | null;
  if (!o || typeof o !== "object") return undefined;
  if (typeof o.ownerFrame === "function") return o.ownerFrame().then((f) => f?.page(), () => undefined);
  if (typeof o.page === "function") return o.page();
  if (typeof o.mainFrame === "function") return o as Page;
  return undefined;
}

/** 内置浏览器桌面版发来的一条变化，写成给模型看的一句；AI 自己开、关的返回 null（它知道） */
function describeEvent(e: TabEvent): string | null {
  // 还没加载出来时标题是空的或 about:blank，不显示
  const title = e.title && e.title !== e.url && e.title !== "about:blank" ? e.title : "";
  const target = `${title ? `${title} — ` : ""}${e.url ? shortUrl(e.url) : "（网址还没加载出来）"}`;
  if (e.kind === "opened") {
    if (e.by === "agent") return null;
    if (e.by === "user") return `用户在面板里新开了标签页：${target}`;
    if (e.by === "agent-input") return `你的点击或按键让网页弹出了新标签页：${target}`;
    if (e.by === "user-input") return `用户在网页里点击或按键，网页弹出了新标签页：${target}`;
    return `网页自己弹出了新标签页（之前没有点击或按键）：${target}`;
  }
  if (e.kind === "closed") {
    if (e.by === "agent") return null;
    if (e.by === "user") return `用户关闭了标签页：${target}`;
    if (e.by === "turn-end") return `上一轮结束时自动关闭了你开的临时标签页：${target}`;
    return `网页自己关闭了标签页（window.close 或崩溃）：${target}`;
  }
  const name = `「${e.title && e.title !== "about:blank" ? e.title : e.url ? shortUrl(e.url) : "新标签页"}」`;
  if (e.action === "back" || e.action === "forward" || e.action === "reload") {
    return `用户在标签页${name}上点了${e.action === "back" ? "后退" : e.action === "forward" ? "前进" : "刷新"}`;
  }
  return `用户在标签页${name}的地址栏里跳转到了 ${shortUrl(e.url)}`;
}

function snapshotPages(context: BrowserContext, page: Page | undefined) {
  return { pages: context.pages(), current: page, url: page && !page.isClosed() ? page.url() : undefined };
}
