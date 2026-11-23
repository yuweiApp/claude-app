import { format, inspect } from "node:util";
import vm from "node:vm";
import { parse, type Pattern } from "acorn";

/**
 * 模型代码的运行环境（浏览器的 browser_run_code、桌面的 run_code，参照 Codex 的 node_repl）：每个 REPL 一个常驻的 vm 上下文，
 * 顶层的 const / let / function / class 在多次调用之间保留、可以重新声明，支持顶层 await，最后一个表达式的值作为结果。
 * vm 不是安全边界（一行 this.constructor.constructor('return process')() 就能拿到网关的 process）
 */

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
 * 防止模型的代码卡住它所在的线程：同步的死循环（while (Date.now() < t) {} 这种忙等）会占住事件循环，
 * 这个线程上的一切都没反应，超时的计时器也触发不了。Chrome 的 REPL 在网关主线程里，卡住的是整个网关（所有会话、接口）；
 * 内置浏览器的在这个会话自己的 worker 里（worker.ts），卡住的只是这个会话的浏览器工具。所以在代码里插检查，
 * 中止的只是这次调用，变量和连接都还在：
 * - 每个循环体开头调用 LOOP_GUARD，事件循环超过 MAX_BLOCK_MS 没转过来就抛错（await 之后、定时器回调里的循环也管得到）。
 *   LOOP_GUARD 定义在 vm 里面，只数次数，每 1024 次才调一次网关这边的 loopGuard 看时间：
 *   每次都跨 vm 调用加读时间太慢，1e7 次的普通计算循环会被拖到 2 秒以上、被误杀
 * - 一开始同步跑的那一段（第一个 await 之前）另外用 vm 的 timeout 兜底，管不是循环的同步卡顿（比如回溯爆炸的正则）
 * 不在循环里、又在 await 之后的同步卡顿管不到；递归死循环会栈溢出报错，不会卡住
 */
const LOOP_GUARD = "__browserRunCodeLoopGuard__";
/** 事件循环最多被占住多久 */
const MAX_BLOCK_MS = 2000;
let lastTick = Date.now();
// 事件循环每转一圈都会更新；循环里看到它太久没更新，就是事件循环被同步代码占住了
setInterval(() => {
  lastTick = Date.now();
}, 100).unref();

function loopGuard(): void {
  if (Date.now() - lastTick > MAX_BLOCK_MS) {
    lastTick = Date.now();
    throw new Error(`代码连续同步执行超过 ${MAX_BLOCK_MS / 1000} 秒（中间没有 await），已中止。`);
  }
}

type AnyNode = { type: string; start: number; end: number; [key: string]: unknown };
const LOOPS = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"]);

/**
 * 插在循环体开头的检查。先看 LOOP_GUARD 有没有定义：传给 evaluate、evaluateAll、waitForFunction 这些的函数
 * 会被 Playwright 转成字符串放到网页里跑，网页里没有 LOOP_GUARD，直接调用会报 ReferenceError；
 * 用 typeof 判断，在网页里什么都不做（网页卡住不影响网关，也不需要检查）
 */
const GUARD_CALL = `typeof ${LOOP_GUARD} === "function" && ${LOOP_GUARD}();`;

/** 在每个循环体开头插入 GUARD_CALL；循环体不是代码块时补上花括号。返回插好的代码 */
function guardLoops(code: string, program: AnyNode): string {
  const inserts: { pos: number; text: string }[] = [];
  const visit = (node: AnyNode) => {
    if (LOOPS.has(node.type)) {
      const body = node.body as AnyNode;
      if (body.type === "BlockStatement") inserts.push({ pos: body.start + 1, text: GUARD_CALL });
      else inserts.push({ pos: body.start, text: `{${GUARD_CALL}` }, { pos: body.end, text: "}" });
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
 * - 循环体开头插入 LOOP_GUARD 检查（见上面）
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
export function show(value: unknown): string {
  if (typeof value === "string") return value;
  return inspect(value, { depth: 3, maxArrayLength: 100, maxStringLength: 10_000, breakLength: 120 });
}

/** 数据部分超过这么多字符的 data: 地址在结果里省略掉（见 elideDataUrls） */
export const DATA_URL_KEEP_CHARS = 256;

/**
 * data: 地址：类型、参数（;base64、;charset=…），逗号后面的数据部分到引号、空白、括号为止。
 * inspect 截断过的字符串后面跟着 `'... N more characters`（maxStringLength），一起匹配，省略的字数要算上它
 */
const DATA_URL = new RegExp(String.raw`data:([\w.+-]+\/[\w.+-]+)?((?:;[\w.+-]+(?:=[\w.+-]+)?)*),([^\s'"\x60<>)\]]{${DATA_URL_KEEP_CHARS},})('\.\.\. (\d+) more characters?)?`, "g");

/**
 * 长的 data: 地址只留类型，数据部分换成省略的字数：网页里内嵌的图片（搜索结果的缩略图都是这样）一张就是几千到几万个字符的 base64，
 * 模型看不懂、还占上下文，以前取一页图片的 src 就是 4 万字符。要用图片有 emitImage、saveFile
 */
function elideDataUrls(text: string): string {
  return text.replace(DATA_URL, (_m, mime: string | undefined, params: string, data: string, more: string | undefined, moreCount: string | undefined) => {
    const omitted = data.length + (moreCount ? Number(moreCount) : 0);
    return `data:${mime ?? ""}${params},…（省略了 ${omitted} 个字符）${more ? "'" : ""}`;
  });
}

export function truncate(raw: string): string {
  const text = elideDataUrls(raw);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（输出太长，只留了前 ${MAX_OUTPUT_CHARS} 个字符，共 ${text.length} 个）`;
}

/**
 * 错误转文字：vm 里抛的错误不是网关这边的 Error（另一个 realm），按形状取 message。
 * 不带调用栈：行号对应的是改写后的代码，其余是网关内部的帧，对模型没用；Playwright 的 Call log 在 message 里，留着。
 * 去掉终端颜色码（Playwright 的 Call log 带）
 */
export function errorText(err: unknown): string {
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

/**
 * 模型代码里没人接住的错误：定时器回调、page.on 的回调里抛的，没有 await 的调用被拒绝的。
 * 网关没有全局的异常处理，这些错误按 Node 的默认做法会让整个网关退出（以前挂着 Playwright MCP 时，
 * 它注册的 unhandledRejection 监听碰巧兜住了一部分）。这里挂上全局处理：调用栈里有某个 REPL 的文件名
 * （browser_run_code_<编号>.js），或者被拒绝的 Promise 是那个 REPL 里建的，就记到它那里、下次调用时告诉模型；
 * 认不出的照 Node 默认的做法打印出来、退出进程，网关别处的错误不受影响。
 * 在内置浏览器的 worker 里（worker.ts）这些监听挂在 worker 自己的 process 上，退出的只是这个 worker。
 * 认领的是 CodeRepl（浏览器的 BrowserRepl、桌面的 DesktopRepl），vm 的文件名是 <种类>_run_code_<编号>.js
 */
interface ErrorOwner {
  owns(promise: Promise<unknown>): boolean;
  backgroundError(err: unknown): void;
}
const registry = new Map<number, ErrorOwner>();
let nextId = 1;
const FILE_PATTERN = /(?:browser|desktop)_run_code_(\d+)\.js/;

/** 登记一个 REPL，返回它的编号（vm 文件名里用）；删掉时调 unregisterRepl */
function registerRepl(owner: ErrorOwner): number {
  const id = nextId++;
  registry.set(id, owner);
  return id;
}

function unregisterRepl(id: number): void {
  registry.delete(id);
}

function stackOf(err: unknown): string {
  const stack = err && typeof err === "object" ? (err as { stack?: unknown }).stack : undefined;
  return typeof stack === "string" ? stack : "";
}

function ownerOf(err: unknown, promise?: Promise<unknown>): ErrorOwner | undefined {
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
 * console 的输出、图片记到最近开始、还没结束的那次；没有调用在跑时（比如之前留下的定时器）丢掉
 */
export interface Run {
  lines: string[];
  images: { data: string; mimeType: string }[];
  /** 这次调用被取消、REPL 被删掉时中止（桌面的 desktop() 按它停下） */
  abort: AbortController;
}

export type Outcome = { value: unknown } | { error: unknown } | { stop: string };

/** 先返回时的说明：到了 timeout_ms、调用被取消 */
export interface StopMessages {
  timeout: (seconds: number) => string;
  abort: string;
}

const BLOCKED = `代码连续同步执行超过 ${MAX_BLOCK_MS / 1000} 秒（中间没有 await），已中止。`;

/**
 * 浏览器的 BrowserRepl、桌面的 DesktopRepl 共用的底座：vm 上下文里放 EXPOSED_GLOBALS、console、emitImage 和循环检查，
 * 子类在 sandbox 上加自己的全局（page、context、desktop() 等）；execute 跑改写好的代码，describe 拼给模型看的结果
 */
export abstract class CodeRepl implements ErrorOwner {
  protected readonly sandbox: Record<string, unknown>;
  private readonly vmContext: vm.Context;
  /** 这个 REPL 的 vm 里的 Promise 构造函数：认被拒绝的 Promise 是不是它建的 */
  private readonly vmPromise: PromiseConstructor;
  protected readonly id = registerRepl(this);
  /** 正在跑的调用（转到后台后可能有几个） */
  protected readonly runs: Run[] = [];
  /** 后台出的错（见 registry 上面的说明），下次调用的结果里带上 */
  private background: string[] = [];

  constructor(private readonly kind: "browser" | "desktop") {
    const current = () => this.runs.at(-1);
    const capture =
      (prefix: string) =>
      (...args: unknown[]) => {
        current()?.lines.push(prefix + format(...args));
      };
    // 用 DONT_CONTEXTIFY（Node 22.8 起）：全局对象是 vm 里一个普通的全局对象，不经拦截器。
    // 普通的 vm 上下文访问全局变量很慢（顶层的 const / let 都改成了全局变量），1e7 次的循环读写一个全局变量要 9 秒，
    // 这样只要 0.2 秒；外面照样能读写它的属性。老版本 Node 没有这个常量时退回普通的上下文
    const dontContextify: typeof vm.constants.DONT_CONTEXTIFY | undefined = vm.constants?.DONT_CONTEXTIFY;
    const name = `${kind}_run_code`;
    this.vmContext = dontContextify !== undefined ? vm.createContext(dontContextify, { name }) : vm.createContext({}, { name });
    this.sandbox = this.vmContext as Record<string, unknown>;
    for (const g of EXPOSED_GLOBALS) this.sandbox[g] = (globalThis as Record<string, unknown>)[g];
    Object.assign(this.sandbox, {
      __browserRunCodeCheckBlocked__: loopGuard,
      console: {
        log: capture(""),
        info: capture(""),
        debug: capture(""),
        warn: capture("[warn] "),
        error: capture("[error] "),
        dir: (value: unknown) => current()?.lines.push(show(value)),
        table: (value: unknown) => current()?.lines.push(show(value)),
      },
      /** 把图片（截图的 Buffer）作为结果的一部分返回给模型 */
      emitImage: (data: Uint8Array | string, mimeType = "image/png") => {
        current()?.images.push({ data: typeof data === "string" ? data : Buffer.from(data).toString("base64"), mimeType });
      },
    });
    this.vmPromise = vm.runInContext("Promise", this.vmContext) as PromiseConstructor;
    vm.runInContext(
      `var ${LOOP_GUARD} = (() => { const check = __browserRunCodeCheckBlocked__; let n = 0; return () => { if ((++n & 1023) === 0) check(); }; })();`,
      this.vmContext,
    );
  }

  /** 有调用还在跑（包括转到后台的） */
  get busy(): boolean {
    return this.runs.length > 0;
  }

  owns(promise: Promise<unknown>): boolean {
    return promise instanceof this.vmPromise;
  }

  backgroundError(err: unknown): void {
    if (this.background.length < 20) this.background.push(errorText(err));
  }

  /** 删会话时调用：不再认领它的错误，还在跑的调用中止 */
  dispose(): void {
    unregisterRepl(this.id);
    for (const run of this.runs) run.abort.abort();
  }

  /**
   * 跑一段 transform 改写过的代码。timeoutMs 到了、signal 取消了先返回（stop），代码可能还在跑；取消时同时中止 run.abort。
   * keepRunning：先返回之后、代码真正结束之前，这次调用还算在跑（之后的 console 输出记到它，不记到下一次）
   */
  protected async execute(script: string, timeoutMs: number, signal: AbortSignal | undefined, stops: StopMessages, keepRunning = false): Promise<{ run: Run; outcome: Outcome }> {
    const run: Run = { lines: [], images: [], abort: new AbortController() };
    this.runs.push(run);
    const remove = () => this.runs.splice(this.runs.indexOf(run), 1);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<{ stop: string }>((resolve) => {
      timer = setTimeout(() => resolve({ stop: stops.timeout(timeoutMs / 1000) }), timeoutMs);
      if (signal) {
        onAbort = () => {
          run.abort.abort();
          resolve({ stop: stops.abort });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    let outcome: Outcome;
    try {
      const promise = Promise.resolve(vm.runInContext(script, this.vmContext, { filename: `${this.kind}_run_code_${this.id}.js`, timeout: MAX_BLOCK_MS })).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
      outcome = await Promise.race([promise, stopped]);
      if ("stop" in outcome && keepRunning) void promise.finally(remove);
      else remove();
    } catch (error) {
      // 同步阶段就出错：第一个 await 之前同步跑超过 MAX_BLOCK_MS（vm 的 timeout，报 Node 的原话，换成和循环检查一样的说法），
      // 或者顶层的 var 和不可写的全局重名
      remove();
      const timedOut = /^Script execution timed out/.test(String((error as { message?: unknown })?.message ?? ""));
      outcome = { error: timedOut ? new Error(BLOCKED) : error };
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
    return { run, outcome };
  }

  /**
   * 给模型看的结果：head（标签页变化之类的说明）、这次和之前留下的后台错误、console 输出、结果或错误、tail。
   * showValue：结果怎么显示（默认 show）；errorNote：出错时补的一句事实
   */
  protected describe(run: Run, outcome: Outcome, opts: { head?: string; tail?: string; showValue?: (value: unknown) => string; errorNote?: () => string | undefined } = {}): { text: string; isError: boolean } {
    const parts = [...run.lines];
    if (this.background.length) {
      parts.unshift(`后台代码出错（定时器或事件回调里抛的错、没有 await 的调用失败等）：\n${this.background.join("\n")}\n`);
      this.background = [];
    }
    if (opts.head) parts.unshift(opts.head);
    let isError = false;
    if ("value" in outcome) {
      if (outcome.value !== undefined) parts.push((opts.showValue ?? show)(outcome.value));
    } else if ("error" in outcome) {
      isError = true;
      parts.push(errorText(outcome.error));
      const note = opts.errorNote?.();
      if (note) parts.push(note);
    } else {
      isError = true;
      parts.push(outcome.stop);
    }
    if (opts.tail) parts.push(opts.tail);
    return { text: truncate(parts.join("\n") || "（没有输出）"), isError };
  }
}
