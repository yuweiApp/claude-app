import { format } from "node:util";
import vm from "node:vm";
import { errorText, EXPOSED_GLOBALS, LOOP_GUARD, loopGuard, MAX_BLOCK_MS, registerRepl, show, transform, truncate, unregisterRepl } from "../browser/repl.js";

/**
 * run_code 的执行环境：每个会话一个常驻的 vm 上下文（同 browser_run_code，改写、顶层 await、循环检查都用 browser/repl.ts 的），
 * 代码里用 desktop(command, args, options) 执行 agent-desktop 命令，一次调用里可以连着做多步、按结果判断。
 * vm 不是安全边界，跑在网关主线程里
 */

/** 代码里 desktop() 执行一条命令：成功、失败都返回 agent-desktop 的 JSON 结果；被拦下、超时、被中断时抛错 */
export type DesktopCall = (command: string, args: string[], options: { headed?: boolean; timeoutMs?: number; signal: AbortSignal }) => Promise<unknown>;

export interface CodeOutput {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
}

interface Run {
  lines: string[];
  images: { data: string; mimeType: string }[];
  abort: AbortController;
}

export class DesktopRepl {
  private readonly vmContext: vm.Context;
  private readonly sandbox: Record<string, unknown>;
  private readonly id: number;
  private readonly vmPromise: PromiseConstructor;
  /** 正在跑的调用（转到后台后可能有几个）：console 输出、图片、desktop() 记到最近开始、还没结束的那次 */
  private readonly runs: Run[] = [];
  private background: string[] = [];

  constructor(call: DesktopCall) {
    const current = () => this.runs.at(-1);
    const capture =
      (prefix: string) =>
      (...args: unknown[]) => {
        current()?.lines.push(prefix + format(...args));
      };
    const dontContextify: typeof vm.constants.DONT_CONTEXTIFY | undefined = vm.constants?.DONT_CONTEXTIFY;
    this.vmContext = dontContextify !== undefined ? vm.createContext(dontContextify, { name: "desktop_run_code" }) : vm.createContext({}, { name: "desktop_run_code" });
    this.sandbox = this.vmContext as Record<string, unknown>;
    for (const name of EXPOSED_GLOBALS) this.sandbox[name] = (globalThis as Record<string, unknown>)[name];
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
      desktop: async (command: unknown, args?: unknown, options?: unknown) => {
        const run = current();
        if (!run) throw new Error("这次 run_code 调用已经结束，desktop() 不再执行");
        if (typeof command !== "string") throw new TypeError("desktop() 的第一个参数是命令名（字符串）");
        if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string"))) throw new TypeError("desktop() 的第二个参数是字符串数组");
        const opts = (options ?? {}) as { headed?: unknown; timeout_ms?: unknown };
        if (run.abort.signal.aborted) throw new Error("这次 run_code 调用已经被中断，desktop() 不再执行");
        return call(command, (args as string[] | undefined) ?? [], {
          headed: opts.headed === true,
          timeoutMs: typeof opts.timeout_ms === "number" ? opts.timeout_ms : undefined,
          signal: run.abort.signal,
        });
      },
      emitImage: (data: Uint8Array | string, mimeType = "image/png") => {
        const run = current();
        if (!run) return;
        run.images.push({ data: typeof data === "string" ? data : Buffer.from(data).toString("base64"), mimeType });
      },
    });
    this.vmPromise = vm.runInContext("Promise", this.vmContext) as PromiseConstructor;
    vm.runInContext(
      `var ${LOOP_GUARD} = (() => { const check = __browserRunCodeCheckBlocked__; let n = 0; return () => { if ((++n & 1023) === 0) check(); }; })();`,
      this.vmContext,
    );
    this.id = registerRepl(this);
  }

  get busy(): boolean {
    return this.runs.length > 0;
  }

  owns(promise: Promise<unknown>): boolean {
    return promise instanceof this.vmPromise;
  }

  backgroundError(err: unknown): void {
    if (this.background.length < 20) this.background.push(errorText(err));
  }

  dispose(): void {
    unregisterRepl(this.id);
    for (const run of this.runs) run.abort.abort();
  }

  /**
   * 跑一段代码。timeoutMs 到了先返回，代码可能还在跑（同 browser_run_code）；signal 中断时这次调用里正在跑和之后的 desktop() 都停下
   */
  async run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<CodeOutput> {
    let script: string;
    try {
      script = transform(code);
    } catch (err) {
      return { text: `语法错误：${(err as Error).message}`, images: [], isError: true };
    }
    const run: Run = { lines: [], images: [], abort: new AbortController() };
    this.runs.push(run);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<{ stop: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ stop: `超过 timeout_ms（${timeoutMs / 1000} 秒）还没跑完，这次调用先返回了；代码可能还在继续跑。` }),
        timeoutMs,
      );
      if (signal) {
        onAbort = () => {
          run.abort.abort();
          resolve({ stop: "已取消，这次调用里正在执行的 agent-desktop 命令被终止，之后的 desktop() 不再执行。" });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    let outcome: { value: unknown } | { error: unknown } | { stop: string };
    try {
      const promise = Promise.resolve(vm.runInContext(script, this.vmContext, { filename: `desktop_run_code_${this.id}.js`, timeout: MAX_BLOCK_MS })).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
      outcome = await Promise.race([promise, stopped]);
      // 超时先返回时代码还在跑：desktop() 的输出记到这次（已经返回了，没人看）不如丢掉，留着 run 直到代码真的结束
      if ("stop" in outcome) void promise.finally(() => this.runs.splice(this.runs.indexOf(run), 1));
    } catch (error) {
      const timedOut = /^Script execution timed out/.test(String((error as { message?: unknown })?.message ?? ""));
      outcome = { error: timedOut ? new Error(`代码连续同步执行超过 ${MAX_BLOCK_MS / 1000} 秒（中间没有 await），已中止。`) : error };
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
    if (!("stop" in outcome)) this.runs.splice(this.runs.indexOf(run), 1);

    const parts = [...run.lines];
    if (this.background.length) {
      parts.unshift(`后台代码出错（定时器或事件回调里抛的错、没有 await 的调用失败等）：\n${this.background.join("\n")}\n`);
      this.background = [];
    }
    let isError = false;
    if ("value" in outcome) {
      if (outcome.value !== undefined) parts.push(show(outcome.value));
    } else if ("error" in outcome) {
      isError = true;
      parts.push(errorText(outcome.error));
    } else {
      isError = true;
      parts.push(outcome.stop);
    }
    return { text: truncate(parts.join("\n") || "（没有输出）"), images: [...run.images], isError };
  }
}
