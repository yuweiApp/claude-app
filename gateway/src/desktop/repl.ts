import { CodeRepl, transform } from "../code-repl.js";
import type { ToolOutput } from "../tool-result.js";

/**
 * run_code 的执行环境：每个会话一个常驻的 REPL（code-repl.ts 的 CodeRepl，改写、顶层 await、循环检查同 browser_run_code），
 * 代码里用 desktop(command, args, options) 执行 agent-desktop 命令，一次调用里可以连着做多步、按结果判断。
 * vm 不是安全边界，跑在网关主线程里
 */

/** 代码里 desktop() 执行一条命令：成功、失败都返回 agent-desktop 的 JSON 结果；被拦下、超时、被中断时抛错 */
export type DesktopCall = (command: string, args: string[], options: { headed?: boolean; timeoutMs?: number; signal: AbortSignal }) => Promise<unknown>;

export class DesktopRepl extends CodeRepl {
  constructor(call: DesktopCall) {
    super("desktop");
    this.sandbox.desktop = async (command: unknown, args?: unknown, options?: unknown) => {
      const run = this.runs.at(-1);
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
    };
  }

  /**
   * 跑一段代码。timeoutMs 到了先返回，代码可能还在跑（同 browser_run_code），这期间的 desktop() 照常执行、输出不再有人看；
   * signal 中断时这次调用里正在跑和之后的 desktop() 都停下
   */
  async run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolOutput> {
    let script: string;
    try {
      script = transform(code);
    } catch (err) {
      return { text: `语法错误：${(err as Error).message}`, images: [], isError: true };
    }
    const { run, outcome } = await this.execute(
      script,
      timeoutMs,
      signal,
      {
        timeout: (seconds) => `超过 timeout_ms（${seconds} 秒）还没跑完，这次调用先返回了；代码可能还在继续跑。`,
        abort: "已取消，这次调用里正在执行的 agent-desktop 命令被终止，之后的 desktop() 不再执行。",
      },
      true,
    );
    return { ...this.describe(run, outcome), images: [...run.images] };
  }
}
