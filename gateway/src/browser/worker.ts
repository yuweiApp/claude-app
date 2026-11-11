import { parentPort } from "node:worker_threads";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import type { CdpTransport, DownloadInfo, TabEvent } from "./host.js";
import { BrowserRepl, type RunResult } from "./repl.js";
import type { ReplCall, ToMain, ToWorker } from "./worker-protocol.js";

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

// ───────────── 到内置浏览器的 CDP 通道（经主线程转发） ─────────────

/** 等主线程回复的 cdpOpen */
const opening = new Map<number, (reply: { conn?: number; error?: string }) => void>();
let nextReq = 1;
/** 开着的通道（同一时间一般只有一条；换新的时，旧的由主线程发 cdpClosed 关掉） */
const transports = new Map<number, CdpTransport>();

function openTransport(): Promise<CdpTransport> {
  const req = nextReq++;
  return new Promise((resolve, reject) => {
    opening.set(req, ({ conn, error }) => {
      if (conn === undefined) return reject(new Error(error ?? "内置浏览器连接失败"));
      const transport: CdpTransport = {
        send: (message) => post({ type: "cdp", conn, message }),
        close: () => {
          if (transports.delete(conn)) post({ type: "cdpClose", conn });
        },
      };
      transports.set(conn, transport);
      resolve(transport);
    });
    post({ type: "cdpOpen", req });
  });
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

// ───────────── REPL 和主线程发来的调用 ─────────────

// ───────────── 下载列表（REPL 的 downloads()，经主线程问桌面版） ─────────────

const downloadReplies = new Map<number, (reply: { downloads?: DownloadInfo[]; error?: string }) => void>();

function listDownloads(): Promise<DownloadInfo[]> {
  const req = nextReq++;
  return new Promise((resolve, reject) => {
    downloadReplies.set(req, ({ downloads, error }) => (downloads ? resolve(downloads) : reject(new Error(error ?? "没有取到下载列表"))));
    post({ type: "downloads", req });
  });
}

// ───────────── 留下标签页（REPL 的 keepTab()，经主线程问桌面版） ─────────────

const keepReplies = new Map<number, (reply: { tab?: { title: string; url: string } | null; error?: string }) => void>();

function keepTab(): Promise<{ title: string; url: string } | null> {
  const req = nextReq++;
  return new Promise((resolve, reject) => {
    keepReplies.set(req, ({ tab, error }) => (error ? reject(new Error(error)) : resolve(tab ?? null)));
    post({ type: "keep", req });
  });
}

// ───────────── 写文件（REPL 的 saveFile()，主线程写进会话的工作目录） ─────────────

const saveReplies = new Map<number, (reply: { path?: string; error?: string }) => void>();

/** 同外部浏览器的 saveFile（external.ts 的 fileSaver）：vm 里建的 TypedArray 不是这边的类型，按 ArrayBuffer.isView 认，复制一份再发 */
function saveFile(name: string, data: unknown): Promise<string> {
  let payload: Uint8Array | string;
  if (typeof data === "string") payload = data;
  else if (ArrayBuffer.isView(data)) payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  else if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") payload = new Uint8Array(data as ArrayBuffer).slice();
  else return Promise.reject(new Error("saveFile 的数据要是 Buffer、Uint8Array、ArrayBuffer 或字符串"));
  const req = nextReq++;
  return new Promise((resolve, reject) => {
    saveReplies.set(req, ({ path, error }) => (path ? resolve(path) : reject(new Error(error ?? "没有写入文件"))));
    post({ type: "save", req, name, data: payload });
  });
}

const repl = new BrowserRepl(getContext, () => tabEvents.splice(0), listDownloads, saveFile, keepTab);
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
    case "cdpOpened":
      opening.get(msg.req)?.(msg);
      opening.delete(msg.req);
      break;
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
    case "downloads":
      downloadReplies.get(msg.req)?.(msg);
      downloadReplies.delete(msg.req);
      break;
    case "kept":
      keepReplies.get(msg.req)?.(msg);
      keepReplies.delete(msg.req);
      break;
    case "saved":
      saveReplies.get(msg.req)?.(msg);
      saveReplies.delete(msg.req);
      break;
  }
});
