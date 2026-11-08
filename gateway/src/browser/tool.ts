import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MCP_AUTO_BACKGROUND_MS } from "../config.js";
import { ALWAYS_LOAD_META, externalBrowserEnabled, isAlwaysLoad } from "../config-file.js";
import type { BrowserHost, TemporaryTab } from "./host.js";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type Repl, type ToolOutput } from "./repl.js";
import { WorkerRepl } from "./worker-repl.js";

/**
 * MCP 服务器名：工具全名是 mcp__inapp__browser_run_code 这样。inapp 指应用内（in-app）的浏览器，
 * 和外部浏览器（用户的 Chrome，chrome.ts）的 mcp__chrome__ 一眼能分开。
 * 不叫 browser：工具名自带 browser_ 前缀，叫 browser 就成了 mcp__browser__browser_snapshot，又长又重复
 */
export const BROWSER_SERVER = "inapp";

/**
 * 只读的工具，内置浏览器和外部 Chrome（chrome.ts）共用，不用确认（options.allowedTools）。
 * browser_run_code 不在里面：它在网关进程里跑任意代码，等同于 Bash，非「完全访问权限」时走权限卡片
 */
export const READ_TOOL_NAMES = ["browser_snapshot", "browser_take_screenshot", "browser_tabs"];

export const BROWSER_READ_TOOLS = ["browser_keep_tab", ...READ_TOOL_NAMES].map((name) => `mcp__${BROWSER_SERVER}__${name}`);

/** MCP 调用跑多久后自动转到后台（config.ts 的 agentEnv 传给子进程的 CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS） */
const BACKGROUND_SECONDS = (Number(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS) || MCP_AUTO_BACKGROUND_MS) / 1000;

/**
 * browser_run_code 的运行环境，两个浏览器的说明都带上（各自独立：Chrome 可能没开，内置浏览器可能不在桌面版里）。
 * 原则：只交代环境、能力、限制和会发生什么，不教模型怎么做（先看什么、怎么等、什么时候用哪个工具），决策留给模型。
 * 以前写过「循环检查页面内容、没好就 waitForTimeout(5000)」这样的例子，模型照着写出等满 3 分钟的循环（判断条件是它自己补的，一直不成立）
 */
export const RUNTIME_FACTS = [
  "browser_run_code 在一个常驻的 Node REPL 中执行 JavaScript（Playwright API），支持顶层 await：",
  "- 全局变量：page 是当前标签页（Playwright Page；没有标签页时是 undefined），context 是 BrowserContext（context.pages() 是全部标签页）。",
  "- 顶层的 const / let / function 在之后的调用里保留，可以重新声明。",
  "- 返回最后一个表达式的值和 console.log 的输出；emitImage(buffer) 把图片加进结果。",
  "- 给 page 赋另一个标签页时，那个标签页切到前台；browser_snapshot、browser_take_screenshot 读的是 page 指向的标签页。",
  `- timeout_ms 默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}；Playwright 单个动作默认 30 秒超时。`,
  `- 调用超过约 ${BACKGROUND_SECONDS} 秒会转为后台任务：先返回一条「在后台运行」的结果，代码继续跑，结束后结果作为通知送达；会话空闲时，这个通知会开始新的一轮。多次调用可以同时在跑，操作的是同一批标签页。`,
  "- 网页本身的变化不会通知你；一轮结束后，只有后台任务结束会再唤起你。",
  "- 连续同步执行（中间没有 await）超过 2 秒的代码会被中止。",
  "browser_snapshot 返回的结构里元素带 [ref=e12]，代码里 page.locator('aria-ref=e12') 指向同一个元素。",
].join("\n");

const INSTRUCTIONS = [
  "内置浏览器：用户界面右侧面板里的真实网页，用户能看到，也能自己操作。这些工具只能看到这个会话自己的标签页。",
  RUNTIME_FACTS,
  "标签页：用 context.newPage() 开的是临时标签页，一轮结束时自动关闭（用户当时正在面板里看着的除外）；关掉后用户在面板里看不到它，下一轮它也不在 context.pages() 里，page 换成剩下的最后一个标签页，没有就是 undefined。" +
    "browser_keep_tab 把你最近操作的那个标签页留下：之后不再自动关闭，用户在面板里能看到、能操作，下一轮还在 context.pages() 里，直到用户关掉或会话被删除。用户开的不会自动关。" +
    "标签页被新开、关闭、跳转时，下一次工具结果里会列出变化和是谁做的（你、用户、网页自己、一轮结束）。",
  "下载：网页里的下载（包括脚本触发的）不弹「另存为」，直接存进系统的「下载」文件夹，同名时文件名后加 (1)、(2)；Playwright 的 download 事件不会触发。下载结束（存好、取消或中断）时，工具结果里会写上存到的完整路径和大小。",
  "用户消息里的 @内置浏览器 指这个浏览器，@[标题](网址) 指这里的一个标签页。",
].join("\n");

/** 开了外部浏览器（config.yml 的 externalBrowser.enabled）时补一句：另一个浏览器是什么 */
const CHROME_NOTE = "\n另有 mcp__chrome__ 开头的工具，操作的是用户自己的 Chrome，带着用户的登录状态。";

/**
 * browser_run_code 打开了新标签页或当前页跳转了，并且这个会话现在有临时标签页时附上：哪些是临时的、会怎样（事实，不教怎么做）。
 * 是不是临时的问桌面版（host.temporaryTabs）：跳转的可能是用户开的、或者已经留下的标签页，不能只看「打开了网页」
 */
function temporaryNote(tabs: TemporaryTab[]): string {
  const lines = tabs.map((t) => `- ${t.title || "（无标题）"} — ${t.url || "（网址还没加载出来）"}${t.latest ? "（你最近操作的）" : ""}`);
  return [
    "（这个会话现在的临时标签页（你开的，或从它们弹出的）：",
    ...lines,
    "临时标签页在这一轮结束时自动关闭（用户那时正在面板里看着的除外），关闭后用户在面板里看不到，下一轮也不在了。browser_keep_tab 会留下你最近操作的那个标签页，留下后用户能看到，下一轮还能接着用。）",
  ].join("\n");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const error = (t: string) => ({ ...text(t), isError: true });

/**
 * 每个会话在每个浏览器里一个 REPL，放在模块里而不是跟着 query() 走：
 * 会话空闲关掉子进程、下次发消息 resume 时，变量和当前标签页还在（网关重启才清空）。
 * 内置浏览器的是 WorkerRepl（每个会话一个 worker 线程），Chrome 的是主线程里的 BrowserRepl（chrome.ts）
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

/** 取出（并删掉）一次工具调用的结果；不是网关的浏览器工具、或者已经被挤掉了返回 undefined */
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
  /** 内置浏览器的 browser_keep_tab：返回结果文字，null 表示没有可以留下的标签页 */
  keep?: () => Promise<string | null>;
  /** 内置浏览器：这个会话现在还没留下的临时标签页，问不到时是 null */
  temporaryTabs?: () => Promise<TemporaryTab[] | null>;
}

/**
 * 给模型用的浏览器工具，内置浏览器和外部 Chrome 共用：browser_run_code 为主（同 Codex 的 js 工具），
 * 加上读页面结构、截图、列出 / 切换标签页三个只读的，和内置浏览器的 browser_keep_tab。
 * 以前挂的是 playwright-core 自带的 Playwright MCP（二十多个工具），点击、输入、等待这些现在都写在代码里
 */
export function browserMcpServer({ name, instructions, repl, keep, temporaryTabs }: ServerOptions): McpSdkServerConfigWithInstance {
  const tools = [
    tool(
      "browser_run_code",
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
    tool(
      "browser_snapshot",
      "当前标签页（page）的无障碍树，元素带 [ref=e12]（代码里 page.locator('aria-ref=e12') 指向同一个元素），前面列出所有标签页。不改动页面。",
      {},
      async () => {
        const notice = takeRestartNotice(repl);
        try {
          return toResult(withRestartNotice(notice, await repl.snapshot()));
        } catch (err) {
          return error(prefixed(notice, errorMessage(err)));
        }
      },
      { annotations: { title: "Page snapshot", readOnlyHint: true, openWorldHint: false } },
    ),
    tool(
      "browser_take_screenshot",
      "当前标签页（page）的截图：默认可见区域，full_page 截整页。",
      { full_page: z.boolean().optional().describe("截整个页面，默认只截可见区域") },
      async ({ full_page }) => {
        const notice = takeRestartNotice(repl);
        try {
          return toResult(withRestartNotice(notice, await repl.screenshot(full_page ?? false)));
        } catch (err) {
          return error(prefixed(notice, errorMessage(err)));
        }
      },
      { annotations: { title: "Screenshot", readOnlyHint: true, openWorldHint: false } },
    ),
    tool(
      "browser_tabs",
      "action: list 列出标签页；action: select 把第 index 个设为 page，并切到前台。",
      {
        action: z.enum(["list", "select"]),
        index: z.number().int().min(0).optional().describe("action 为 select 时：标签页序号（list 结果里的 [序号]）"),
      },
      async ({ action, index }) => {
        const notice = takeRestartNotice(repl);
        try {
          return toResult(withRestartNotice(notice, await repl.tabs(action, index)));
        } catch (err) {
          return error(prefixed(notice, errorMessage(err)));
        }
      },
      { annotations: { title: "Tabs", readOnlyHint: true, openWorldHint: false } },
    ),
    ...(keep
      ? [
          tool(
            "browser_keep_tab",
            "把你最近操作的那个标签页标记为保留：这一轮结束时不关闭，之后也不再自动关闭。留下的标签页用户在右侧面板里能看到、能操作，下一轮还在，直到用户关掉或会话被删除。",
            {},
            async () => {
              try {
                const result = await keep();
                return result === null ? error("没有你操作过的标签页可以留下。") : text(result);
              } catch (err) {
                return error(errorMessage(err));
              }
            },
            { annotations: { title: "Keep tab for the user", readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
          ),
        ]
      : []),
  ];

  return createSdkMcpServer({
    name,
    version: "1.0.0",
    instructions,
    // config.yml 里配了常驻的：第一轮就给完整定义，其余的用到时 ToolSearch
    tools: tools.map((t) => (isAlwaysLoad(`mcp__${name}__${t.name}`) ? { ...t, _meta: { ...t._meta, [ALWAYS_LOAD_META]: true } } : t)),
  });
}

/** 给模型用的内置浏览器工具，每个会话一个 MCP 服务器；REPL 和连接按会话保留（replFor），在这个会话自己的 worker 线程里 */
export function browserServer(host: BrowserHost, sessionId: string, resumed = false): McpSdkServerConfigWithInstance {
  return browserMcpServer({
    name: BROWSER_SERVER,
    instructions: INSTRUCTIONS + (externalBrowserEnabled ? CHROME_NOTE : ""),
    repl: replFor(`${BROWSER_SERVER}:${sessionId}`, () => new WorkerRepl(host, sessionId), resumed),
    keep: async () => {
      const tab = await host.keep(sessionId);
      return tab ? `已留下标签页「${tab.title || tab.url}」（${tab.url}），这一轮结束后不会关闭。` : null;
    },
    temporaryTabs: () => host.temporaryTabs(sessionId),
  });
}
