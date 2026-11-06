import { format, inspect } from "node:util";
import vm from "node:vm";
import { parse, type Pattern } from "acorn";
import type { BrowserContext, Page } from "playwright-core";
import type { TabEvent } from "./host.js";

/**
 * browser_run_code 的执行环境（参照 Codex 的 node_repl）：每个会话一个常驻的 vm 上下文，
 * 顶层的 const / let / function / class 在多次调用之间保留、可以重新声明，支持顶层 await，最后一个表达式的值作为结果。
 *
 * vm 不是安全边界（一行 this.constructor.constructor('return process')() 就能拿到网关的 process），
 * 所以 browser_run_code 等同于 Bash，不放进 allowedTools，非「完全访问权限」时走权限卡片
 */

/** 不指定 timeout_ms 时等多久；上限见 MAX_TIMEOUT_MS */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 单次调用最长等多久：网页里的 AI 生成、查询这类要几分钟的，一次调用就能等完 */
export const MAX_TIMEOUT_MS = 15 * 60_000;
/** 返回给模型的文字上限，超过只留开头 */
const MAX_OUTPUT_CHARS = 40_000;

/** 给 vm 上下文的全局对象（和 Playwright 自带 browser_run_code_unsafe 的 exposedGlobals 基本一致） */
const EXPOSED_GLOBALS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "structuredClone",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "AbortSignal",
  "fetch",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "Blob",
  "Buffer",
  "atob",
  "btoa",
] as const;

/** 收集解构里声明的变量名：const { a, b: [c, ...d] } = x → a、c、d */
function patternNames(pattern: Pattern, out: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      break;
    case "ArrayPattern":
      for (const el of pattern.elements) if (el) patternNames(el, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    default:
      break;
  }
}

/**
 * 防止模型的代码卡死网关：代码和网关在同一个进程里，同步的死循环（while (Date.now() < t) {} 这种忙等）会占住事件循环，
 * 所有会话、接口都没反应，超时的计时器也触发不了。Codex 的 node_repl 是单独的进程，没有这个问题；
 * 我们的浏览器连接（内置浏览器的 CDP、Chrome 扩展共用的那条）都在网关进程里，挪不出去，所以在代码里插检查：
 * - 每个循环体开头调用 LOOP_GUARD，事件循环超过 MAX_BLOCK_MS 没转过来就抛错（await 之后、定时器回调里的循环也管得到）。
 *   LOOP_GUARD 定义在 vm 里面，只数次数，每 1024 次才调一次网关这边的 loopGuard 看时间：
 *   每次都跨 vm 调用加读时间太慢，1e7 次的普通计算循环会被拖到 2 秒以上、被误杀
 * - 一开始同步跑的那一段（第一个 await 之前）另外用 vm 的 timeout 兜底，管不是循环的同步卡顿（比如回溯爆炸的正则）
 * 不在循环里、又在 await 之后的同步卡顿管不到；递归死循环会栈溢出报错，不会卡住
 */
const LOOP_GUARD = "__browserRunCodeLoopGuard__";
/** 事件循环最多被占住多久 */
export const MAX_BLOCK_MS = 2000;
let lastTick = Date.now();
// 事件循环每转一圈都会更新；循环里看到它太久没更新，就是事件循环被同步代码占住了
setInterval(() => {
  lastTick = Date.now();
}, 100).unref();

function loopGuard(): void {
  if (Date.now() - lastTick > MAX_BLOCK_MS) {
    lastTick = Date.now();
    throw new Error(`循环连续占用网关超过 ${MAX_BLOCK_MS / 1000} 秒，已中止（会卡住整个网关）。要等待请用 await，比如 await page.waitForTimeout(1000) 或 locator.waitFor()，不要用同步的忙等。`);
  }
}

type AnyNode = { type: string; start: number; end: number; [key: string]: unknown };
const LOOPS = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"]);

/** 在每个循环体开头插入 LOOP_GUARD()；循环体不是代码块时补上花括号。返回插好的代码 */
function guardLoops(code: string, program: AnyNode): string {
  const inserts: { pos: number; text: string }[] = [];
  const visit = (node: AnyNode) => {
    if (LOOPS.has(node.type)) {
      const body = node.body as AnyNode;
      if (body.type === "BlockStatement") inserts.push({ pos: body.start + 1, text: `${LOOP_GUARD}();` });
      else inserts.push({ pos: body.start, text: `{${LOOP_GUARD}();` }, { pos: body.end, text: "}" });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) if (child && typeof child === "object" && typeof child.type === "string") visit(child as AnyNode);
      if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as AnyNode).type === "string") visit(value as AnyNode);
    }
  };
  visit(program);
  // 从后往前插，前面的位置不受影响（同一位置只会有几个「}」，嵌套的非代码块循环体在同一处结束，先后无所谓）
  inserts.sort((a, b) => b.pos - a.pos);
  let out = code;
  for (const { pos, text } of inserts) out = out.slice(0, pos) + text + out.slice(pos);
  return out;
}

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "script",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
} as const;

/**
 * 把模型的代码改写成能在同一个 vm 上下文里反复跑的脚本（同 Node REPL 处理顶层 await 的办法）：
 * - 顶层的 const / let / var / class 改成给全局变量赋值，function 声明提到最前面赋值，变量名在外面用 var 声明，
 *   所以下一次调用还能用，再写一遍 const 同名变量也不会报「已声明」
 * - 整段包进 async 函数，顶层可以 await；最后一条是表达式时 return 它的值
 * - 循环体开头插入 LOOP_GUARD（见上面）
 * 语法错误时抛 SyntaxError（acorn 的，行列号对应模型写的原文）
 */
export function transform(original: string): string {
  const code = guardLoops(original, parse(original, PARSE_OPTIONS) as unknown as AnyNode);
  const program = parse(code, PARSE_OPTIONS);
  const src = (node: { start: number; end: number }) => code.slice(node.start, node.end);
  const declared = new Set<string>();
  const hoisted: string[] = [];
  const body: string[] = [];
  const statements = program.body;

  statements.forEach((stmt, i) => {
    const isLast = i === statements.length - 1;
    switch (stmt.type) {
      case "VariableDeclaration": {
        const assigns: string[] = [];
        for (const decl of stmt.declarations) {
          const names: string[] = [];
          patternNames(decl.id, names);
          names.forEach((n) => declared.add(n));
          if (decl.init) assigns.push(`(${src(decl.id)} = ${src(decl.init)})`);
          // let x; 重新声明时清空；var x; 保留原来的值（和 var 的语义一致）
          else if (stmt.kind !== "var") assigns.push(`(${src(decl.id)} = undefined)`);
        }
        if (assigns.length) body.push(`void (${assigns.join(", ")});`);
        return;
      }
      case "FunctionDeclaration":
        if (stmt.id) {
          declared.add(stmt.id.name);
          hoisted.push(`${stmt.id.name} = ${src(stmt)};`);
          return;
        }
        break;
      case "ClassDeclaration":
        if (stmt.id) {
          declared.add(stmt.id.name);
          body.push(`${stmt.id.name} = ${src(stmt)};`);
          return;
        }
        break;
      case "ExpressionStatement":
        if (isLast) {
          body.push(`return (${src(stmt.expression)});`);
          return;
        }
        break;
      default:
        break;
    }
    // 每条后面补分号：原文靠自动插入分号断开的两条，拼起来后不能连成一条（a\n(b) 会变成调用）
    body.push(`${src(stmt)};`);
  });

  const vars = declared.size ? `var ${[...declared].join(", ")};\n` : "";
  return `${vars}(async () => {\n${[...hoisted, ...body].join("\n")}\n})()`;
}

/** 值转成给模型看的文字：字符串原样，其他用 util.inspect */
function show(value: unknown): string {
  if (typeof value === "string") return value;
  return inspect(value, { depth: 3, maxArrayLength: 100, maxStringLength: 10_000, breakLength: 120 });
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（输出太长，只留了前 ${MAX_OUTPUT_CHARS} 个字符，共 ${text.length} 个）`;
}

/**
 * 错误转文字：vm 里抛的错误不是网关这边的 Error（另一个 realm），按形状取 message。
 * 不带调用栈：行号对应的是改写后的代码，其余是网关内部的帧，对模型没用；Playwright 的 Call log 在 message 里，留着。
 * 去掉终端颜色码（Playwright 的 Call log 带）
 */
function errorText(err: unknown): string {
  let message: string;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    const e = err as { message: string; name?: unknown };
    message = `${typeof e.name === "string" ? e.name : "Error"}: ${e.message}`;
  } else {
    message = show(err);
  }
  // eslint-disable-next-line no-control-regex
  return message.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
}

export interface RunResult {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
  /** 这次调用前后的标签页和当前页网址，判断有没有打开新网页（内置浏览器用它提醒 browser_keep_tab） */
  opened: boolean;
}

/**
 * 模型代码里没人接住的错误：定时器回调、page.on 的回调里抛的，没有 await 的调用被拒绝的。
 * 网关没有全局的异常处理，这些错误按 Node 的默认做法会让整个网关退出（以前挂着 Playwright MCP 时，
 * 它注册的 unhandledRejection 监听碰巧兜住了一部分）。这里挂上全局处理：调用栈里有某个 REPL 的文件名
 * （browser_run_code_<编号>.js），或者被拒绝的 Promise 是那个 REPL 里建的，就记到它那里、下次调用时告诉模型；
 * 认不出的照 Node 默认的做法打印出来、退出进程，网关别处的错误不受影响
 */
const registry = new Map<number, BrowserRepl>();
let nextId = 1;
const FILE_PATTERN = /browser_run_code_(\d+)\.js/;

function stackOf(err: unknown): string {
  const stack = err && typeof err === "object" ? (err as { stack?: unknown }).stack : undefined;
  return typeof stack === "string" ? stack : "";
}

function ownerOf(err: unknown, promise?: Promise<unknown>): BrowserRepl | undefined {
  const match = FILE_PATTERN.exec(stackOf(err));
  if (match) return registry.get(Number(match[1]));
  if (promise) for (const repl of registry.values()) if (repl.owns(promise)) return repl;
  return undefined;
}

process.on("unhandledRejection", (reason, promise) => {
  const repl = ownerOf(reason, promise);
  if (repl) return repl.backgroundError(reason);
  // 和 Node 默认（--unhandled-rejections=throw）一样转成未捕获异常，交给下面的处理
  throw reason;
});
process.on("uncaughtException", (err) => {
  const repl = ownerOf(err);
  if (repl) return repl.backgroundError(err);
  console.error(err);
  process.exit(1);
});

/**
 * 一次调用收集输出的地方。调用转到后台后（见 config.ts 的 agentEnv）模型可以接着发下一次，几次调用可能同时在跑：
 * console 的输出记到最近开始、还没结束的那次；没有调用在跑时（比如之前留下的定时器）丢掉
 */
interface Sink {
  lines: string[];
  images: { data: string; mimeType: string }[];
}

/**
 * 一个会话在一个浏览器（内置浏览器或用户的 Chrome）里的 REPL。getContext 每次调用前取一次：
 * 断开重连后 context 换成新的，page 指向已关闭或旧连接里的标签页时换成当前最后一个标签页
 */
export class BrowserRepl {
  private readonly sandbox: Record<string, unknown>;
  private readonly vmContext: vm.Context;
  private readonly sinks: Sink[] = [];
  private readonly id = nextId++;
  /** 这个 REPL 的 vm 里的 Promise 构造函数：认被拒绝的 Promise 是不是它建的 */
  private readonly vmPromise: PromiseConstructor;
  /** 后台出的错（见 registry 上面的说明），下次调用的结果里带上 */
  private background: string[] = [];
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
   * 调用 bringToFront，内置浏览器的面板跟着切过去。网关这边换 page（标签页被关、browser_tabs select）直接改这个字段，不经访问器
   */
  private currentPage: unknown;
  /** 已经挂上关闭事件的浏览器上下文（断开重连后是新的） */
  private watched: BrowserContext | null = null;

  /**
   * @param tabEvents 内置浏览器：取走桌面版发来的标签页变化（带着是谁做的，见 host.ts 的 TabEvent）；
   *   Chrome 没有，在这里自己记（Playwright 的事件里看不出是用户还是网页，只能分出是不是 AI）
   */
  constructor(
    private readonly getContext: () => Promise<BrowserContext>,
    private readonly tabEvents?: () => TabEvent[],
  ) {
    const capture =
      (prefix: string) =>
      (...args: unknown[]) => {
        this.sinks.at(-1)?.lines.push(prefix + format(...args));
      };
    const consoleLike = {
      log: capture(""),
      info: capture(""),
      debug: capture(""),
      warn: capture("[warn] "),
      error: capture("[error] "),
      dir: (value: unknown) => this.sinks.at(-1)?.lines.push(show(value)),
      table: (value: unknown) => this.sinks.at(-1)?.lines.push(show(value)),
    };
    // 用 DONT_CONTEXTIFY（Node 22.8 起）：全局对象是 vm 里一个普通的全局对象，不经拦截器。
    // 普通的 vm 上下文访问全局变量很慢（顶层的 const / let 都改成了全局变量），1e7 次的循环读写一个全局变量要 9 秒，
    // 这样只要 0.2 秒；外面照样能读写它的属性（page、context）。老版本 Node 没有这个常量时退回普通的上下文
    const dontContextify: typeof vm.constants.DONT_CONTEXTIFY | undefined = vm.constants?.DONT_CONTEXTIFY;
    this.vmContext = dontContextify !== undefined ? vm.createContext(dontContextify, { name: "browser_run_code" }) : vm.createContext({}, { name: "browser_run_code" });
    this.sandbox = this.vmContext as Record<string, unknown>;
    for (const name of EXPOSED_GLOBALS) this.sandbox[name] = (globalThis as Record<string, unknown>)[name];
    Object.assign(this.sandbox, {
      __browserRunCodeCheckBlocked__: loopGuard,
      console: consoleLike,
      /** 把图片（page.screenshot() 的 Buffer）作为结果的一部分返回给模型 */
      emitImage: (data: Uint8Array | string, mimeType = "image/png") => {
        const sink = this.sinks.at(-1);
        if (!sink) return;
        const base64 = typeof data === "string" ? data : Buffer.from(data).toString("base64");
        sink.images.push({ data: base64, mimeType });
      },
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
    this.vmPromise = vm.runInContext("Promise", this.vmContext) as PromiseConstructor;
    vm.runInContext(
      `var ${LOOP_GUARD} = (() => { const check = __browserRunCodeCheckBlocked__; let n = 0; return () => { if ((++n & 1023) === 0) check(); }; })();`,
      this.vmContext,
    );
    registry.set(this.id, this);
  }

  /** 有调用还在跑（包括转到后台的）：一轮结束时先不关内置浏览器的临时标签页，代码可能还在用 */
  get busy(): boolean {
    return this.sinks.length > 0;
  }

  /** 删会话时调用：不再认领它的错误 */
  dispose(): void {
    registry.delete(this.id);
  }

  owns(promise: Promise<unknown>): boolean {
    return promise instanceof this.vmPromise;
  }

  backgroundError(err: unknown): void {
    if (this.background.length < 20) this.background.push(errorText(err));
  }

  /** 准备好 context 和 page（browser_snapshot 等工具也走这里，和代码里的 page 是同一个） */
  async current(): Promise<{ context: BrowserContext; page: Page | undefined }> {
    return this.sync(true);
  }

  /**
   * 取 context，page 指向已关闭或旧连接里的标签页时换成最后一个标签页；记下现在开着的标签页（seen）。
   * note：page 被换掉要不要告诉模型（调用开头要；调用结束时是代码自己关的，不用）
   */
  private async sync(note: boolean): Promise<{ context: BrowserContext; page: Page | undefined }> {
    const context = await this.getContext();
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
        if (agentClosed.has(page)) return;
        push({ who: "不是你关的标签页被关闭了（用户在 Chrome 里关的，或网页自己关的）", url: page.url(), title: titles.get(page) ?? "" });
      });
    };
    context.pages().forEach(onClose);
    context.on("page", (page) => {
      trackPage(page);
      onClose(page);
      // newPage 返回之前就会发 page 事件：正在 newPage 的是 AI 开的
      if ((creating.get(context) ?? 0) > 0) return;
      const running = this.sinks.length > 0;
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
  takeNotice(): Promise<string | undefined> {
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
      const target = change.page ? `${(await titleOf(change.page)) || "（无标题）"} — ${change.page.url()}` : `${change.title ? `${change.title} — ` : ""}${change.url}`;
      lines.push(`- ${change.who}：${target}`);
    }
    this.localChanges = [];
    if (this.pageReplaced) {
      lines.push(`- page 原来指向的标签页已经关闭，${page ? `现在 page 指向 ${page.url()}` : "现在没有标签页，page 是 undefined，要用就 page = await context.newPage() 重新打开"}`);
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
      const list = await Promise.all(fresh.map(async (p) => `[${pages.indexOf(p)}] ${(await titleOf(p)) || "（无标题）"} — ${p.url()}`));
      out.push(`不是你开的新标签页：${list.join("；")}。page 没有跟过去，要操作就 page = context.pages()[序号]。`);
    }
    if (turnEnd) out.push("你开的标签页在一轮结束时会自动关闭，要在之后的轮次接着用，就在一轮结束前调用 browser_keep_tab。");
    return `（${out.join("\n")}）`;
  }

  /** 切换当前标签页（browser_tabs select） */
  setPage(page: Page): void {
    this.currentPage = page;
  }

  async run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    let script: string;
    try {
      script = transform(code);
    } catch (err) {
      return { text: `语法错误：${(err as Error).message}`, images: [], isError: true, opened: false };
    }
    const { context } = await this.current();
    // 上次调用以来被关掉的标签页：放在这次结果的最前面（在跑代码之前取，代码自己关的不算）
    const notice = await this.takeNotice();
    const before = snapshotPages(context, this.currentPage as Page | undefined);
    const sink: Sink = { lines: [], images: [] };
    this.sinks.push(sink);

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<{ stop: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ stop: `超过 ${timeoutMs / 1000} 秒还没跑完，不再等它（代码可能还在后台继续跑，比如还在等某个元素）。需要等更久就调大 timeout_ms。` }),
        timeoutMs,
      );
      if (signal) {
        onAbort = () => resolve({ stop: "已取消。" });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    let outcome: { value: unknown } | { error: unknown } | { stop: string };
    try {
      const promise = Promise.resolve(vm.runInContext(script, this.vmContext, { filename: `browser_run_code_${this.id}.js`, timeout: MAX_BLOCK_MS })).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
      outcome = await Promise.race([promise, stopped]);
    } catch (error) {
      // 同步阶段就出错：第一个 await 之前同步跑超过 MAX_BLOCK_MS（vm 的 timeout），或者顶层的 var 和不可写的全局重名
      outcome = { error };
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      this.sinks.splice(this.sinks.indexOf(sink), 1);
    }

    const parts = [...sink.lines];
    // 这次和之前留下的后台错误（定时器回调里抛的、没有 await 的调用失败的）
    if (this.background.length) {
      parts.unshift(`后台代码出错（定时器或事件回调里抛的错、没有 await 的调用失败等）：\n${this.background.join("\n")}\n`);
      this.background = [];
    }
    if (notice) parts.unshift(notice);
    let isError = false;
    if ("value" in outcome) {
      if (outcome.value !== undefined) parts.push(show(outcome.value));
    } else if ("error" in outcome) {
      isError = true;
      parts.push(errorText(outcome.error));
      // 模型常以为 page 一直在，没有标签页时直接 page.goto(...) 报「reading 'goto'」，提示它先开一个
      if (this.currentPage === undefined) parts.push("（现在没有标签页，page 是 undefined：先 page = await context.newPage() 开一个。）");
    } else {
      isError = true;
      parts.push(outcome.stop);
    }
    // 跑完后 page 可能被代码换掉或关掉了，按新的状态比较
    const after = snapshotPages(context, (await this.sync(false).catch(() => null))?.page);
    const opened = after.pages.some((p) => !before.pages.includes(p)) || (after.current !== undefined && after.current === before.current && after.url !== before.url);
    this.lastRunEnd = Date.now();
    // 这次调用期间标签页的变化（网页弹出的、用户这时关掉的……；AI 自己开、关的不说）
    const changes = await this.describeChanges("这次调用期间，标签页有这些变化：");
    if (changes) parts.push(changes);
    return { text: truncate(parts.join("\n") || "（没有输出）"), images: sink.images, isError, opened };
  }
}

/** 标题：后台冻结的标签页 title() 可能迟迟不回，最多等 1 秒 */
function titleOf(page: Page): Promise<string> {
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
 * 网关里调用这两个方法的只有模型的代码（浏览器工具自己不开不关标签页），所以记下的就是 AI 做的
 */
const agentCreated = new WeakSet<Page>();
const agentClosed = new WeakSet<Page>();
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
}

/** 内置浏览器桌面版发来的一条变化，写成给模型看的一句；AI 自己开、关的返回 null（它知道） */
function describeEvent(e: TabEvent): string | null {
  // 还没加载出来时标题是空的或 about:blank，不显示
  const title = e.title && e.title !== e.url && e.title !== "about:blank" ? e.title : "";
  const target = `${title ? `${title} — ` : ""}${e.url || "（网址还没加载出来）"}`;
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
  const name = `「${e.title && e.title !== "about:blank" ? e.title : e.url || "新标签页"}」`;
  if (e.action === "back" || e.action === "forward" || e.action === "reload") {
    return `用户在标签页${name}上点了${e.action === "back" ? "后退" : e.action === "forward" ? "前进" : "刷新"}`;
  }
  return `用户在标签页${name}的地址栏里跳转到了 ${e.url}`;
}

function snapshotPages(context: BrowserContext, page: Page | undefined) {
  return { pages: context.pages(), current: page, url: page && !page.isClosed() ? page.url() : undefined };
}
