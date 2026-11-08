import type { DownloadInfo, TabEvent } from "./host.js";
import type { RunResult, ToolOutput } from "./repl.js";

/**
 * 网关主线程和内置浏览器 worker（worker.ts）之间的消息。只有类型，两边都 import type，不会把主线程的模块带进 worker。
 *
 * 一个会话一个 worker，里面有这个会话的 BrowserRepl 和 Playwright 连接。CDP 消息还是经桌面版连到网关的那条 WebSocket
 * 收发（host.ts），worker 没法直接用它，由主线程转：worker 要连接时发 cdpOpen，主线程向 host 开一条这个会话的通道，
 * 之后两边的 CDP 消息按连接编号（conn）原样转发
 */

/** 浏览器工具调用的方法，和 Repl 接口的方法一一对应 */
export type ReplCall =
  | { method: "run"; args: [code: string, timeoutMs: number] }
  | { method: "snapshot"; args: [] }
  | { method: "screenshot"; args: [fullPage: boolean] }
  | { method: "tabs"; args: [action: "list" | "select", index?: number] };

/** 主线程发给 worker 的 */
export type ToWorker =
  | ({ type: "call"; id: number } & ReplCall)
  /** 取消这次调用（模型那边取消了工具调用） */
  | { type: "abort"; id: number }
  /** 回复 cdpOpen：开好了给连接编号，没开成给原因（比如桌面版没在运行） */
  | { type: "cdpOpened"; req: number; conn?: number; error?: string }
  /** 桌面版发来的 CDP 消息 */
  | { type: "cdp"; conn: number; message: object }
  /** 这条通道断了（桌面版断开、同一个会话又开了新的） */
  | { type: "cdpClosed"; conn: number; reason?: string }
  /** 桌面版发来的标签页变化 */
  | { type: "tabEvent"; event: TabEvent }
  /** 回复 downloads：这个会话的下载，或者没取到的原因 */
  | { type: "downloads"; req: number; downloads?: DownloadInfo[]; error?: string };

/** worker 发给主线程的 */
export type ToMain =
  | { type: "result"; id: number; output: ToolOutput | RunResult }
  | { type: "error"; id: number; message: string }
  /** 要开一条到内置浏览器的 CDP 通道 */
  | { type: "cdpOpen"; req: number }
  /** 发给桌面版的 CDP 消息 */
  | { type: "cdp"; conn: number; message: object }
  /** 关掉这条通道 */
  | { type: "cdpClose"; conn: number }
  /** REPL 的 downloads()：问这个会话的下载和进度 */
  | { type: "downloads"; req: number };
