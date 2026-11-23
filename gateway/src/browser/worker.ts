import { parentPort } from "node:worker_threads";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import type { CdpTransport, DownloadInfo, TabEvent } from "./host.js";
import { BrowserRepl, type RunResult } from "./repl.js";
import type { ReplCall, ToMain, ToWorker, WorkerRequest } from "./worker-protocol.js";

/**
 * 内置浏览器的 worker 线程，一个会话一个（主线程那边是 worker-repl.ts 的 WorkerRepl）。
 * 这个会话的 Playwright 连接和 browser_run_code 的 REPL 都在这里：模型的代码卡住、出了认不出的错误，
 * 影响的只是这个会话的浏览器工具，网关和别的会话照常。
 * 只 import 浏览器要用的模块（repl.ts、playwright-core），不带进 SDK、HTTP 这些主线程的东西
 */

if (!parentPort) throw new Error("worker.ts 只能作为 worker 线程运行");
const port = parentPort;
const post = (msg: ToMain) => port.postMessage(msg);

/** 每个会话最多攒多少条没告诉模型的标签页变化（同 host.ts） */
const MAX_TAB_EVENTS = 50;
const tabEvents: TabEvent[] = [];

// ───────────── 经主线程做的事（连浏览器、问下载、留标签页、读写文件） ─────────────

const replies = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
let nextReq = 1;

/** 发 request 给主线程，等它的 reply；value 的类型见 WorkerRequest */
function request<T>(r: WorkerRequest): Promise<T> {
  const req = nextReq++;
  return new Promise<T>((resolve, reject) => {
    replies.set(req, { resolve: resolve as (value: unknown) => void, reject });
    post({ type: "request", req, ...r });
  });
}

// ───────────── 到内置浏览器的 CDP 通道（经主线程转发） ─────────────

/** 开着的通道（同一时间一般只有一条；换新的时，旧的由主线程发 cdpClosed 关掉） */
const transports = new Map<number, CdpTransport>();

async function openTransport(): Promise<CdpTransport> {
  const conn = await request<number>({ method: "cdpOpen" });
  const transport: CdpTransport = {
    send: (message) => post({ type: "cdp", conn, message }),
    close: () => {
      if (transports.delete(conn)) post({ type: "cdpClose", conn });
    },
  };
  transports.set(conn, transport);
  return transport;
}

/**
 * 到内置浏览器的连接（connectOverCDP 走桌面版里这个会话的 CDP 代理），第一次用到时才连；
 * 桌面版没开时报错，开了之后再调用就能用，断了下次用到再连
 */
let connecting: Promise<Browser> | null = null;

async function getContext(): Promise<BrowserContext> {
  if (!connecting) {
    const attempt: Promise<Browser> = openTransport()
      .then((transport) => chromium.connectOverCDP(transport))
      .then(
        (browser) => {
          browser.once("disconnected", () => {
            if (connecting === attempt) connecting = null;
          });
          return browser;
        },
        (err: unknown) => {
          if (connecting === attempt) connecting = null;
          throw err;
        },
      );
    connecting = attempt;
  }
  const context = (await connecting).contexts()[0];
  if (!context) throw new Error("内置浏览器没有可用的浏览器上下文");
  return context;
}

// ───────────── REPL 的 downloads()、keepTab()、saveFile()、readFile() ─────────────

const listDownloads = () => request<DownloadInfo[]>({ method: "downloads" });
const keepTab = () => request<{ title: string; url: string } | null>({ method: "keep" });

/** 同外部浏览器的 saveFile（external.ts 的 fileSaver）：vm 里建的 TypedArray 不是这边的类型，按 ArrayBuffer.isView 认，复制一份再发 */
function saveFile(name: string, data: unknown): Promise<string> {
  let payload: Uint8Array | string;
  if (typeof data === "string") payload = data;
  else if (ArrayBuffer.isView(data)) payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  else if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") payload = new Uint8Array(data as ArrayBuffer).slice();
  else return Promise.reject(new Error("saveFile 的数据要是 Buffer、Uint8Array、ArrayBuffer 或字符串"));
  return request<string>({ method: "save", name, data: payload });
}

/** 主线程发回来的是 Uint8Array（Buffer 过了 postMessage 就不是 Buffer 了），包回 Buffer */
async function readFile(name: string): Promise<Buffer> {
  const data = await request<Uint8Array>({ method: "read", name });
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

// ───────────── REPL 和主线程发来的调用 ─────────────

const repl = new BrowserRepl(getContext, () => tabEvents.splice(0), listDownloads, saveFile, keepTab, readFile);
/** 还在跑的调用，取消时用 */
const running = new Map<number, AbortController>();

function invoke(call: ReplCall, signal: AbortSignal): Promise<RunResult> {
  return repl.run(call.args[0], call.args[1], signal);
}

async function handleCall(id: number, call: ReplCall): Promise<void> {
  const controller = new AbortController();
  running.set(id, controller);
  try {
    post({ type: "result", id, output: await invoke(call, controller.signal) });
  } catch (err) {
    post({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    running.delete(id);
  }
}

port.on("message", (msg: ToWorker) => {
  switch (msg.type) {
    case "call": {
      const { type: _type, id, ...call } = msg;
      void handleCall(id, call as ReplCall);
      break;
    }
    case "abort":
      running.get(msg.id)?.abort();
      break;
    case "reply": {
      const reply = replies.get(msg.req);
      replies.delete(msg.req);
      if (msg.error !== undefined) reply?.reject(new Error(msg.error));
      else reply?.resolve(msg.value);
      break;
    }
    case "cdp":
      transports.get(msg.conn)?.onmessage?.(msg.message);
      break;
    case "cdpClosed": {
      const transport = transports.get(msg.conn);
      transports.delete(msg.conn);
      transport?.onclose?.(msg.reason);
      break;
    }
    case "tabEvent":
      if (tabEvents.length < MAX_TAB_EVENTS) tabEvents.push(msg.event);
      break;
  }
});
