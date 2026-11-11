import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { BrowserHost, CdpTransport } from "./host.js";
import type { Repl, RunResult, ToolOutput } from "./repl.js";
import type { ReplCall, ToMain, ToWorker } from "./worker-protocol.js";

/** 开发时（tsx 直接跑源码）本文件是 .ts，构建后是 .js；worker 的入口跟着用同一个扩展名 */
const EXT = extname(fileURLToPath(import.meta.url));
const WORKER_URL = new URL(`./worker${EXT}`, import.meta.url);

/**
 * 起 worker。构建后直接跑 worker.js。
 * 开发时 worker.ts 里 import 的是 ./repl.js 这样的写法，要靠 tsx 的加载钩子映射到 .ts。worker 不一定继承得到主线程的钩子：
 * Linux 上的 Node 22.23 继承得到，Windows 上的 Node 22.22 继承不到（只有 Node 自带的类型擦除，能读 .ts，但不会把 .js 映射到 .ts，
 * 报 Cannot find module …repl.js）。所以在 worker 里先用 tsx/esm/api 注册一次钩子，再加载 worker.ts
 */
function spawnWorker(name: string): Worker {
  if (EXT !== ".ts") return new Worker(WORKER_URL, { name });
  const tsxApi = import.meta.resolve("tsx/esm/api");
  const bootstrap = `import(${JSON.stringify(tsxApi)}).then((tsx) => { tsx.register(); return import(${JSON.stringify(WORKER_URL.href)}); });`;
  return new Worker(bootstrap, { eval: true, name });
}

interface PendingCall {
  resolve: (output: ToolOutput) => void;
  reject: (err: Error) => void;
  run: boolean;
}

/**
 * 内置浏览器的 REPL，放在这个会话自己的 worker 线程里跑（worker.ts）：模型的代码卡住或者出了认不出的错误，
 * 影响的只是这个会话的浏览器工具，网关主线程和别的会话不受影响。这里是主线程这边的代理：
 * - 工具调用转给 worker，结果原样带回
 * - worker 要连内置浏览器时，向 host 开这个会话的 CDP 通道，两边的消息按连接编号转发
 * - 桌面版发来的标签页变化直接转给 worker
 * worker 第一次用到时才起；退出了（认不出的错误让它退出了）下次调用再起一个新的，变量就没了，标签页还在桌面版里。
 * 不检测卡死：卡住的 worker 一直留着，直到会话被删除
 */
export class WorkerRepl implements Repl {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly calls = new Map<number, PendingCall>();
  /** 还在跑的 browser_run_code 次数（busy） */
  private runs = 0;
  private nextConn = 1;
  /** worker 开着的 CDP 通道 */
  private readonly transports = new Map<number, CdpTransport>();
  /** worker 在没有调用时退出了：下次调用的结果前面告诉模型（有调用在跑时，原因直接作为那些调用的错误） */
  private exitNotice: string | undefined;
  private disposed = false;

  /** saveFile：REPL 的 saveFile() 在主线程写文件（external.ts 的 fileSaver，按会话的工作目录） */
  constructor(
    private readonly host: BrowserHost,
    private readonly sessionId: string,
    private readonly saveFile?: (name: string, data: unknown) => Promise<string>,
  ) {}

  get busy(): boolean {
    return this.runs > 0;
  }

  run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    return this.call({ method: "run", args: [code, timeoutMs] }, signal) as Promise<RunResult>;
  }

  dispose(): void {
    this.disposed = true;
    const worker = this.worker;
    if (worker) this.stopped(worker, "会话已删除。");
    void worker?.terminate();
  }

  private async call(call: ReplCall, signal?: AbortSignal): Promise<ToolOutput> {
    if (this.disposed) throw new Error("会话已删除。");
    const worker = this.start();
    const id = this.nextId++;
    const run = call.method === "run";
    if (run) this.runs++;
    const onAbort = () => this.send(worker, { type: "abort", id });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const output = await new Promise<ToolOutput>((resolve, reject) => {
        this.calls.set(id, { resolve, reject, run });
        this.send(worker, { type: "call", id, ...call });
        if (signal?.aborted) onAbort();
      });
      const notice = this.exitNotice;
      this.exitNotice = undefined;
      return notice ? { ...output, text: output.text ? `${notice}\n\n${output.text}` : notice } : output;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = spawnWorker(`inapp-browser-${this.sessionId}`);
    let error: Error | undefined;
    worker.on("message", (msg: ToMain) => this.onMessage(worker, msg));
    worker.on("error", (err: unknown) => {
      error = err instanceof Error ? err : new Error(String(err));
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      const reason = error ? `：${error.message}` : `（退出码 ${code}）`;
      this.stopped(worker, `内置浏览器的代码运行环境退出了${reason}。之前的变量都已清空，标签页还在。`);
    });
    this.worker = worker;
    this.host.listenTabEvents(this.sessionId, (event) => this.send(worker, { type: "tabEvent", event }));
    return worker;
  }

  /** worker 退出了或会话被删了：还在等的调用都以 reason 出错，关掉它开的 CDP 通道 */
  private stopped(worker: Worker, reason: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.host.listenTabEvents(this.sessionId, null);
    for (const transport of this.transports.values()) transport.close();
    this.transports.clear();
    if (this.calls.size === 0 && !this.disposed) this.exitNotice = reason;
    for (const call of this.calls.values()) call.reject(new Error(reason));
    this.calls.clear();
    this.runs = 0;
  }

  private send(worker: Worker, msg: ToWorker): void {
    if (this.worker === worker) worker.postMessage(msg);
  }

  private settle(id: number, settle: (call: PendingCall) => void): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    if (call.run) this.runs--;
    settle(call);
  }

  private onMessage(worker: Worker, msg: ToMain): void {
    switch (msg.type) {
      case "result":
        this.settle(msg.id, (call) => call.resolve(msg.output));
        break;
      case "error":
        this.settle(msg.id, (call) => call.reject(new Error(msg.message)));
        break;
      case "cdpOpen": {
        let transport: CdpTransport;
        try {
          transport = this.host.transport(this.sessionId);
        } catch (err) {
          this.send(worker, { type: "cdpOpened", req: msg.req, error: err instanceof Error ? err.message : String(err) });
          break;
        }
        const conn = this.nextConn++;
        transport.onmessage = (message) => this.send(worker, { type: "cdp", conn, message });
        transport.onclose = (reason) => {
          if (this.transports.delete(conn)) this.send(worker, { type: "cdpClosed", conn, reason });
        };
        this.transports.set(conn, transport);
        this.send(worker, { type: "cdpOpened", req: msg.req, conn });
        break;
      }
      case "cdp":
        this.transports.get(msg.conn)?.send(msg.message);
        break;
      case "downloads":
        this.host.downloads(this.sessionId).then(
          (downloads) => this.send(worker, { type: "downloads", req: msg.req, downloads }),
          (err: unknown) => this.send(worker, { type: "downloads", req: msg.req, error: err instanceof Error ? err.message : String(err) }),
        );
        break;
      case "save":
        if (!this.saveFile) {
          this.send(worker, { type: "saved", req: msg.req, error: "这个会话没有工作目录，saveFile 写不了文件" });
          break;
        }
        this.saveFile(msg.name, msg.data).then(
          (path) => this.send(worker, { type: "saved", req: msg.req, path }),
          (err: unknown) => this.send(worker, { type: "saved", req: msg.req, error: err instanceof Error ? err.message : String(err) }),
        );
        break;
      case "keep":
        this.host.keep(this.sessionId).then(
          (tab) => this.send(worker, { type: "kept", req: msg.req, tab }),
          (err: unknown) => this.send(worker, { type: "kept", req: msg.req, error: err instanceof Error ? err.message : String(err) }),
        );
        break;
      case "cdpClose": {
        const transport = this.transports.get(msg.conn);
        this.transports.delete(msg.conn);
        transport?.close();
        break;
      }
    }
  }
}
