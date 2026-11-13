import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MCP_AUTO_BACKGROUND_MS } from "../config.js";
import { ALWAYS_LOAD_META, isAlwaysLoad } from "../config-file.js";
import type { BrowserHost, TemporaryTab } from "./host.js";
import { DATA_URL_KEEP_CHARS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type Repl, type ToolOutput } from "./repl.js";
import { WorkerRepl } from "./worker-repl.js";

/**
 * MCP 服务器名：工具全名是 mcp__inapp__browser_run_code 这样。inapp 指应用内（in-app）的浏览器，
 * 和外部浏览器（用户的 Chrome、Edge，external.ts）的 mcp__chrome__、mcp__edge__ 一眼能分开。
 * 不叫 browser：工具名自带 browser_ 前缀，叫 browser 就成了 mcp__browser__browser_run_code，又长又重复
 */
export const BROWSER_SERVER = "inapp";

/**
 * 浏览器只有一个工具 browser_run_code，内置浏览器和外部浏览器（external.ts）共用。看页面结构、截图、切换标签页、留下标签页都在代码里做。
 * 不弹权限卡片（options.allowedTools，用户定的：浏览器、桌面工具默认开放）。它在网关进程里跑任意代码，等同于 Bash
 */
export const RUN_CODE_TOOL = "browser_run_code";

export const BROWSER_TOOLS = [`mcp__${BROWSER_SERVER}__${RUN_CODE_TOOL}`];

/** MCP 调用跑多久后自动转到后台（config.ts 的 agentEnv 传给子进程的 CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS） */
const BACKGROUND_SECONDS = (Number(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS) || MCP_AUTO_BACKGROUND_MS) / 1000;

/**
 * browser_run_code 的运行环境，每个浏览器的说明都带上（各自独立：外部浏览器可能没开，内置浏览器可能不在桌面版里）。
 * 原则：只交代环境、能力、限制和会发生什么，不教模型怎么做（先看什么、怎么等、什么时候用哪个工具），决策留给模型。
 * 以前写过「循环检查页面内容、没好就 waitForTimeout(5000)」这样的例子，模型照着写出等满 3 分钟的循环（判断条件是它自己补的，一直不成立）
 */
export const RUNTIME_FACTS = [
  "browser_run_code 在一个常驻的 Node REPL 中执行 JavaScript（Playwright API），支持顶层 await：",
  "- 全局变量：page 是当前标签页（Playwright Page；没有标签页时是 undefined），context 是 BrowserContext（context.pages() 是全部标签页）。",
  "- 顶层的 const / let / function 在之后的调用里保留，可以重新声明。",
  "- 返回最后一个表达式的值和 console.log 的输出；emitImage(buffer) 把图片加进结果。",
  `- 返回的文字里，数据部分超过 ${DATA_URL_KEEP_CHARS} 个字符的 data: 地址只保留类型（如 data:image/jpeg;base64,），数据换成「…（省略了 N 个字符）」；代码里拿到的值是完整的。`,
  "- 给 page 赋另一个标签页时，那个标签页切到前台。",
  `- timeout_ms 默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}；Playwright 单个动作默认 30 秒超时。`,
  `- 调用超过约 ${BACKGROUND_SECONDS} 秒会转为后台任务：先返回一条「在后台运行」的结果，代码继续跑，结束后结果作为通知送达；会话空闲时，这个通知会开始新的一轮。多次调用可以同时在跑，操作的是同一批标签页。`,
  "- 网页本身的变化不会通知你；一轮结束后，只有后台任务结束会再唤起你。",
  "- 连续同步执行（中间没有 await）超过 2 秒的代码会被中止。",
  "- page.ariaSnapshot({ mode: 'ai' }) 返回页面的无障碍树（YAML 文本），元素带 [ref=e12]；之后 page.locator('aria-ref=e12') 指向同一个元素，页面变了要重新取。",
].join("\n");

/** files：saveFile 的说明（external.ts 的 saveFileFact），会话有工作目录时才有 */
/** remote：远程会话所在主机的名称（docs/README.md「SSH 远程开发」） */
const instructions = (saveFileFact?: string, remote?: string) => [
  "内置浏览器：用户界面右侧面板里的真实网页，用户能看到，也能自己操作。这些工具只能看到这个会话自己的标签页。",
  ...(remote
    ? [
        `这个会话的工作目录在远程主机「${remote}」上（经 SSH），内置浏览器在用户的电脑上：网址里的 localhost、127.0.0.1、[::1]、*.localhost 经 SSH 连到「${remote}」上的同一个地址和端口（「${remote}」上只监听 127.0.0.1 或 ::1 的服务也能访问），其他网址从用户的电脑访问。` +
          `这个会话的标签页的 Cookie、登录状态在「${remote}」专用的一份里，和用户电脑上本机会话的标签页不共用。`,
      ]
    : []),
  RUNTIME_FACTS,
  "标签页：用 context.newPage() 开的是临时标签页，一轮结束时自动关闭（用户当时正在面板里看着的除外）；关掉后用户在面板里看不到它，下一轮它也不在 context.pages() 里，page 换成剩下的最后一个标签页，没有就是 undefined。" +
    "全局函数 await keepTab() 把你最近操作的那个标签页留下：之后不再自动关闭，用户在面板里能看到、能操作，下一轮还在 context.pages() 里，直到用户关掉或会话被删除；返回 { title, url }，没有你操作过的标签页时返回 null。用户开的不会自动关。" +
    "标签页被新开、关闭、跳转时，下一次 browser_run_code 的结果里会列出变化和是谁做的（你、用户、网页自己、一轮结束）。",
  (remote ? "下载：网页里的下载（包括脚本触发的）不弹「另存为」，存进用户电脑上系统的「下载」文件夹（不在远端的工作目录里），同名时文件名后加 (1)、(2)；" : "下载：网页里的下载（包括脚本触发的）不弹「另存为」，直接存进这个会话的工作目录，同名时文件名后加 (1)、(2)；") +
    "Playwright 的 download 事件照常触发，download.suggestedFilename() 是实际存下的文件名，download.path() 是 Playwright 临时目录里的一份。" +
    "全局函数 await downloads() 返回这个会话里的下载（进行中的和最近结束的，先开始的在前），每项有 filename、path、url（data: 地址只有类型和长度）、state（progressing / completed / cancelled / interrupted）、paused、receivedBytes、totalBytes（不知道时是 0）、bytesPerSecond、startTime（毫秒时间戳），是调用那一刻的数据。" +
      (saveFileFact ?? ""),
  "用户消息里的 @内置浏览器 指这个浏览器，@[标题](网址) 指这里的一个标签页。",
].join("\n");

/**
 * browser_run_code 打开了新标签页或当前页跳转了，并且这个会话现在有临时标签页时附上：哪些是临时的、会怎样（事实，不教怎么做）。
 * 是不是临时的问桌面版（host.temporaryTabs）：跳转的可能是用户开的、或者已经留下的标签页，不能只看「打开了网页」
 */
function temporaryNote(tabs: TemporaryTab[]): string {
  const lines = tabs.map((t) => `- ${t.title || "（无标题）"} — ${t.url || "（网址还没加载出来）"}${t.latest ? "（你最近操作的）" : ""}`);
  return [
    "（这个会话现在的临时标签页（你开的，或从它们弹出的）：",
    ...lines,
    "临时标签页在这一轮结束时自动关闭（用户那时正在面板里看着的除外），关闭后用户在面板里看不到，下一轮也不在了。keepTab() 会留下你最近操作的那个标签页，留下后用户能看到，下一轮还能接着用。）",
  ].join("\n");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const error = (t: string) => ({ ...text(t), isError: true });

/**
 * 每个会话在每个浏览器里一个 REPL，放在模块里而不是跟着 query() 走：
 * 会话空闲关掉子进程、下次发消息 resume 时，变量和当前标签页还在（网关重启才清空）。
 * 内置浏览器的是 WorkerRepl（每个会话一个 worker 线程），外部浏览器的是主线程里的 BrowserRepl（external.ts）
 */
const repls = new Map<string, Repl>();

/**
 * 会话恢复（resume）时这个会话的 REPL 却是新建的：网关重启过（会话空闲关掉子进程再恢复时 REPL 还在，不会新建），
 * 之前调用里定义的变量都没了。第一次调用浏览器工具时在结果开头说明，不然模型照旧用存着的变量，撞上 ReferenceError 才知道
 */
const RESTART_NOTICE = "（这个会话的代码运行环境是新建的（应用重启过）：之前调用里定义的变量都已不在，page 指向现在最后一个标签页；标签页本身还在。）";
const pendingNotices = new WeakMap<Repl, string>();

/** 取这个会话在这个浏览器里的 REPL，没有就用 create 建一个；resumed：会话是恢复的（新建时记下 RESTART_NOTICE） */
export function replFor(key: string, create: () => Repl, resumed = false): Repl {
  let repl = repls.get(key);
  if (!repl) {
    repl = create();
    repls.set(key, repl);
    if (resumed) pendingNotices.set(repl, RESTART_NOTICE);
  }
  return repl;
}

/** 取走还没告诉模型的提示（只给一次） */
function takeRestartNotice(repl: Repl): string | undefined {
  const notice = pendingNotices.get(repl);
  pendingNotices.delete(repl);
  return notice;
}

/** 文字前面加上提示 */
const prefixed = (notice: string | undefined, body: string) => (notice ? (body ? `${notice}\n\n${body}` : notice) : body);
const withRestartNotice = <T extends ToolOutput>(notice: string | undefined, output: T): T => (notice ? { ...output, text: prefixed(notice, output.text) } : output);

/**
 * 这个会话在内置浏览器里还有代码在跑（转到后台的 browser_run_code）：一轮结束时先不关临时标签页，
 * 不然模型先回复、这一轮结束，代码正在操作的标签页就被关了。代码跑完后结果作为通知开始新的一轮，那一轮结束时再关
 */
export function inappBusy(sessionId: string): boolean {
  return repls.get(`${BROWSER_SERVER}:${sessionId}`)?.busy ?? false;
}

/** 删会话时一起删掉它的 REPL（两个浏览器的都删） */
export function disposeRepls(sessionId: string): void {
  for (const [key, repl] of repls) {
    if (!key.endsWith(`:${sessionId}`)) continue;
    repl.dispose();
    repls.delete(key);
  }
}

/**
 * 工具调用的结果，按 tool_use_id 记：调用跑久了会被 Claude Code 转到后台，结果只交给模型，
 * 网关在 task_notification 里按 tool_use_id 取出来发给网页（task_result 事件），失败时显示原因。
 * tool_use_id 是 Claude Code 调 MCP 工具时放在 _meta["claudecode/toolUseId"] 里的。只留最近的一些
 */
const toolResults = new Map<string, { text: string; isError: boolean }>();
const MAX_TOOL_RESULTS = 50;

export function rememberResult(extra: unknown, text: string, isError: boolean): void {
  const id = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["claudecode/toolUseId"];
  if (typeof id !== "string") return;
  toolResults.set(id, { text, isError });
  if (toolResults.size > MAX_TOOL_RESULTS) toolResults.delete(toolResults.keys().next().value as string);
}

/** 取出（并删掉）一次工具调用的结果；不是记了结果的网关工具（浏览器、桌面、终端）、或者已经被挤掉了返回 undefined */
export function takeToolResult(toolUseId: string): { text: string; isError: boolean } | undefined {
  const result = toolResults.get(toolUseId);
  toolResults.delete(toolUseId);
  return result;
}

/** 工具输出转成 MCP 的结果：文字（有的话）在前，图片在后 */
function toResult(output: ToolOutput) {
  return {
    content: [
      ...(output.text ? [{ type: "text" as const, text: output.text }] : []),
      ...output.images.map((img) => ({ type: "image" as const, ...img })),
    ],
    ...(output.isError ? { isError: true } : {}),
  };
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface ServerOptions {
  name: string;
  instructions: string;
  repl: Repl;
  /** 内置浏览器：这个会话现在还没留下的临时标签页，问不到时是 null */
  temporaryTabs?: () => Promise<TemporaryTab[] | null>;
}

/**
 * 给模型用的浏览器工具，内置浏览器和外部浏览器共用：只有 browser_run_code（同 Codex 的 js 工具）。
 * 以前挂的是 playwright-core 自带的 Playwright MCP（二十多个工具），后来还留过读页面结构、截图、列出 / 切换标签页、留下标签页四个专用工具，
 * 现在都写在代码里（page.ariaSnapshot、page.screenshot + emitImage、context.pages()、keepTab()）
 */
export function browserMcpServer({ name, instructions, repl, temporaryTabs }: ServerOptions): McpSdkServerConfigWithInstance {
  const tools = [
    tool(
      RUN_CODE_TOOL,
      "在常驻的 REPL 里执行 JavaScript（Playwright API），支持顶层 await。全局有 page（当前标签页）、context（BrowserContext），顶层变量在之后的调用里保留；" +
        "返回最后一个表达式的值和 console.log 的输出，emitImage(buffer) 把图片加进结果。" +
        `timeout_ms 默认 ${DEFAULT_TIMEOUT_MS}、最大 ${MAX_TIMEOUT_MS}；超过约 ${BACKGROUND_SECONDS} 秒转为后台任务，结束后结果作为通知送达。`,
      {
        code: z.string().describe("要执行的 JavaScript"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(`这次调用最多跑多久（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}`),
      },
      async ({ code, timeout_ms }, extra) => {
        let notice: string | undefined;
        try {
          const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
          notice = takeRestartNotice(repl);
          const result = withRestartNotice(notice, await repl.run(code, timeout_ms ?? DEFAULT_TIMEOUT_MS, signal));
          rememberResult(extra, result.text, result.isError);
          const temporary = temporaryTabs && result.opened && !result.isError ? await temporaryTabs().catch(() => null) : null;
          return toResult(temporary?.length ? { ...result, text: `${result.text}\n\n${temporaryNote(temporary)}` } : result);
        } catch (err) {
          rememberResult(extra, prefixed(notice, errorMessage(err)), true);
          return error(prefixed(notice, errorMessage(err)));
        }
      },
      { annotations: { title: "Run browser code", readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    ),
  ];

  return createSdkMcpServer({
    name,
    version: "1.0.0",
    instructions,
    // config.yml 里配了常驻的：第一轮就给完整定义，其余的用到时 ToolSearch
    tools: tools.map((t) => (isAlwaysLoad(`mcp__${name}__${t.name}`) ? { ...t, _meta: { ...t._meta, [ALWAYS_LOAD_META]: true } } : t)),
  });
}

/**
 * 给模型用的内置浏览器工具，每个会话一个 MCP 服务器；REPL 和连接按会话保留（replFor），在这个会话自己的 worker 线程里。
 * externalNote：说明里补的另外还有哪些浏览器（external.ts 的 externalNote）；files：REPL 的 saveFile()（external.ts 的 fileSaver、saveFileFact，按会话的工作目录）
 */
export function browserServer(
  host: BrowserHost,
  sessionId: string,
  resumed = false,
  externalNote = "",
  files?: { save: (name: string, data: unknown) => Promise<string>; fact: string },
  /** 远程会话所在主机的名称 */
  remote?: string,
): McpSdkServerConfigWithInstance {
  return browserMcpServer({
    name: BROWSER_SERVER,
    instructions: instructions(files?.fact, remote) + externalNote,
    repl: replFor(`${BROWSER_SERVER}:${sessionId}`, () => new WorkerRepl(host, sessionId, files?.save), resumed),
    temporaryTabs: () => host.temporaryTabs(sessionId),
  });
}
