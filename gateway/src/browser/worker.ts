import { parentPort } from "node:worker_threads";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import type { CdpTransport, TabEvent } from "./host.js";
import { BrowserRepl, type ToolOutput } from "./repl.js";
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

const repl = new BrowserRepl(getContext, () => tabEvents.splice(0));
/** 还在跑的调用，取消时用 */
const running = new Map<number, AbortController>();

function invoke(call: ReplCall, signal: AbortSignal): Promise<ToolOutput> {
  switch (call.method) {
    case "run":
      return repl.run(call.args[0], call.args[1], signal);
    case "snapshot":
      return repl.snapshot();
    case "screenshot":
      return repl.screenshot(call.args[0]);
    case "tabs":
      return repl.tabs(call.args[0], call.args[1]);
  }
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
  }
});
