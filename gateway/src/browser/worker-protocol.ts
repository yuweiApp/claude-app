import type { TabEvent } from "./host.js";
import type { RunResult } from "./repl.js";

/**
 * 网关主线程和内置浏览器 worker（worker.ts）之间的消息。只有类型，两边都 import type，不会把主线程的模块带进 worker。
 *
 * 一个会话一个 worker，里面有这个会话的 BrowserRepl 和 Playwright 连接。CDP 消息还是经桌面版连到网关的那条 WebSocket
 * 收发（host.ts），worker 没法直接用它，由主线程转：worker 要连接时发 cdpOpen，主线程向 host 开一条这个会话的通道，
 * 之后两边的 CDP 消息按连接编号（conn）原样转发
 */

/** 浏览器工具调用的方法，和 Repl 接口的方法一一对应 */
export type ReplCall = { method: "run"; args: [code: string, timeoutMs: number] };

/** 主线程发给 worker 的 */
export type ToWorker =
  | ({ type: "call"; id: number } & ReplCall)
  /** 取消这次调用（模型那边取消了工具调用） */
  | { type: "abort"; id: number }
  /** 回复 request：做成了给 value（见 WorkerRequest），没做成给原因 */
  | { type: "reply"; req: number; value?: unknown; error?: string }
  /** 桌面版发来的 CDP 消息 */
  | { type: "cdp"; conn: number; message: object }
  /** 这条通道断了（桌面版断开、同一个会话又开了新的） */
  | { type: "cdpClosed"; conn: number; reason?: string }
  /** 桌面版发来的标签页变化 */
  | { type: "tabEvent"; event: TabEvent };

/** worker 要主线程做的事，主线程做完回 reply，value 是注释里写的 */
export type WorkerRequest =
  /** 开一条到内置浏览器的 CDP 通道：value 是连接编号（没开成的原因比如桌面版没在运行） */
  | { method: "cdpOpen" }
  /** REPL 的 downloads()：value 是这个会话的下载和进度（DownloadInfo[]） */
  | { method: "downloads" }
  /** REPL 的 keepTab()：把这个会话里 AI 最近操作的标签页留给用户，value 是它（没有 AI 操作过的标签页时是 null） */
  | { method: "keep" }
  /** REPL 的 saveFile(name, data)：写进会话的工作目录（data 已在 worker 里转成 Uint8Array 或字符串），value 是写入的路径 */
  | { method: "save"; name: string; data: Uint8Array | string }
  /** REPL 的 readFile(name)：读会话工作目录里的文件，value 是内容（Uint8Array） */
  | { method: "read"; name: string };

/** worker 发给主线程的 */
export type ToMain =
  | { type: "result"; id: number; output: RunResult }
  | { type: "error"; id: number; message: string }
  | ({ type: "request"; req: number } & WorkerRequest)
  /** 发给桌面版的 CDP 消息 */
  | { type: "cdp"; conn: number; message: object }
  /** 关掉这条通道 */
  | { type: "cdpClose"; conn: number };
