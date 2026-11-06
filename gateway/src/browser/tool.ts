import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { z } from "zod";
import { MCP_AUTO_BACKGROUND_MS } from "../config.js";
import { ALWAYS_LOAD_META, externalBrowserEnabled, isAlwaysLoad } from "../config-file.js";
import type { BrowserHost } from "./host.js";
import { BrowserRepl, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./repl.js";

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

/**
 * 怎么用 browser_run_code（参照 Codex 的 js 工具），两个浏览器的说明都带上。
 * 后半段是等结果：网页要等一会儿才出结果时，模型常回一句「等结果出来再告诉你」就结束这一轮，
 * 但网页的变化不会叫醒它，所以要它把等待写在代码里。调用跑久了 Claude Code 会把它转到后台（config.ts 的 agentEnv），
 * 模型可以先回复，代码跑完后结果以 task_notification 送回来、开始新的一轮
 */
/** MCP 调用跑多久后自动转到后台（config.ts 的 agentEnv 传给子进程的 CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS） */
const BACKGROUND_SECONDS = (Number(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS) || MCP_AUTO_BACKGROUND_MS) / 1000;

export const CODE_GUIDE =
  "操作网页用 browser_run_code：写 JavaScript（Playwright 的 API），在一个常驻的 REPL 里跑，支持顶层 await，" +
  "最后一个表达式的值和 console.log 的输出会返回给你。可以直接用的变量：page（当前标签页，Playwright 的 Page）、context（BrowserContext，context.pages() 是所有标签页）。" +
  "顶层的 const / let / function 在之后的调用里还在（可以重新声明），常用的 locator、辅助函数可以存下来接着用。" +
  "给 page 赋值就是切换当前标签页（browser_snapshot、browser_take_screenshot 跟着它走）：新开标签页 page = await context.newPage()；" +
  "点链接弹出的新标签页不会自动切过去，用 const [p] = await Promise.all([context.waitForEvent('page'), locator.click()]); page = p。" +
  "先用 browser_snapshot 读页面结构（带 [ref=e12] 的无障碍树），代码里用 page.locator('aria-ref=e12') 引用其中的元素，也可以用 getByRole、getByText 等；" +
  "截图（browser_take_screenshot，或代码里 emitImage(await page.screenshot())）只在要看样式、图片时用。" +
  "多步操作（填表、点击、等待、读结果）尽量写在一次调用里。" +
  `一次调用默认最多跑 ${DEFAULT_TIMEOUT_MS / 1000} 秒，timeout_ms 最大 ${MAX_TIMEOUT_MS}（${MAX_TIMEOUT_MS / 60_000} 分钟）；Playwright 单个动作默认 30 秒超时，等更久要自己传 timeout。` +
  "提交查询、让网页里的 AI 回答或生成之后，结果要一段时间才出来：在同一次调用里等到它再读出来" +
  "（比如 await page.getByText('结果里会出现的字').waitFor({ timeout: 600000 })，或者循环检查页面内容、没好就 await page.waitForTimeout(5000)），" +
  "timeout_ms 设得比要等的时间长一些。" +
  `调用跑超过约 ${BACKGROUND_SECONDS} 秒会自动转到后台：你会先收到「在后台运行」的结果，这时可以先告诉用户在等什么、结束这一轮或做别的事，` +
  "代码跑完后结果会以通知送回来，到时再读结果回复用户。不要因为转到了后台就重新提交同一个操作；后台的代码还在操作页面时，别的调用不要动同一个标签页。" +
  "网页自己的变化不会通知你：没写在代码里等的结果，这一轮结束后就没人告诉你了，所以要等的东西一定写在代码里等。";

const INSTRUCTIONS =
  "这些工具操作的是用户界面右侧面板里的内置浏览器（桌面版里的真实网页，用户能看到、也能自己操作），" +
  "只能看到和操作这个会话自己的标签页。用户说「浏览器」「内置浏览器」「打开网页」时指的就是它。" +
  CODE_GUIDE +
  "你新开的标签页是临时的，这一轮结束时会自动关掉；用户要看的页面（比如让你打开、找到某个网页），在结束前对它调用 browser_keep_tab 留下。" +
  "用户消息里的 @[标题](网址) 指内置浏览器里的一个标签页：用 browser_tabs 列出标签页，按网址找到它再切过去。";

/** 开了外部浏览器（config.yml 的 externalBrowser.enabled）时补一句，区分两个浏览器 */
const CHROME_NOTE =
  "用户说「我的 Chrome」「外部浏览器」，或者要用到用户自己的登录状态时，用 mcp__chrome__ 开头的工具（用户自己的 Chrome），不是这里的工具。";

/** 告诉模型标签页为什么被关（REPL 在下一次调用时说明哪些标签页被关了，见 BrowserRepl.takeNotice） */
const INAPP_CLOSED_HINT =
  "内置浏览器里你开的标签页在一轮结束时会自动关掉（用户也可能自己关），要在之后的轮次接着用，就在一轮结束前调用 browser_keep_tab。";

/** browser_run_code 打开了网页后提醒模型：临时标签页这一轮结束会关，要留给用户就 browser_keep_tab（模型常忘） */
const KEEP_HINT = "（这是你开的临时标签页，这一轮结束会自动关闭；如果是给用户看的页面，结束前调用 browser_keep_tab 留下。）";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const error = (t: string) => ({ ...text(t), isError: true });

/**
 * 每个会话在每个浏览器里一个 REPL，放在模块里而不是跟着 query() 走：
 * 会话空闲关掉子进程、下次发消息 resume 时，变量和当前标签页还在（网关重启才清空）
 */
const repls = new Map<string, BrowserRepl>();

export function replFor(key: string, getContext: () => Promise<BrowserContext>, closedHint = ""): BrowserRepl {
  let repl = repls.get(key);
  if (!repl) {
    repl = new BrowserRepl(getContext, closedHint);
    repls.set(key, repl);
  }
  return repl;
}

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

function rememberResult(extra: unknown, text: string, isError: boolean): void {
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

/** 标签页的一行描述：[序号] 标题 — 网址；后台冻结的标签页 title() 可能迟迟不回，最多等 1 秒 */
async function describe(pages: Page[], current: Page | undefined): Promise<string> {
  const title = (page: Page) =>
    Promise.race([page.title().catch(() => ""), new Promise<string>((resolve) => setTimeout(() => resolve(""), 1000))]);
  const lines = await Promise.all(pages.map(async (p, i) => `[${i}]${p === current ? "（当前）" : ""} ${(await title(p)) || "（无标题）"} — ${p.url()}`));
  return lines.join("\n");
}

/** 结果前面加上「上次调用以来被关掉的标签页」的说明 */
const withNotice = (notice: string | undefined, body: string) => (notice ? `${notice}\n\n${body}` : body);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface ServerOptions {
  name: string;
  instructions: string;
  repl: BrowserRepl;
  /** 内置浏览器的 browser_keep_tab：返回结果文字，null 表示没有可以留下的标签页 */
  keep?: () => Promise<string | null>;
}

/**
 * 给模型用的浏览器工具，内置浏览器和外部 Chrome 共用：browser_run_code 为主（同 Codex 的 js 工具），
 * 加上读页面结构、截图、列出 / 切换标签页三个只读的，和内置浏览器的 browser_keep_tab。
 * 以前挂的是 playwright-core 自带的 Playwright MCP（二十多个工具），点击、输入、等待这些现在都写在代码里
 */
export function browserMcpServer({ name, instructions, repl, keep }: ServerOptions): McpSdkServerConfigWithInstance {
  const noPage = "现在没有标签页：用 browser_run_code 执行 page = await context.newPage(); await page.goto('网址') 打开一个。";

  const tools = [
    tool(
      "browser_run_code",
      "在常驻的 REPL 里跑一段 JavaScript 操作浏览器（Playwright API），支持顶层 await。可以直接用 page（当前标签页）、context（所有标签页），" +
        "顶层的 const / let / function 在之后的调用里还在；最后一个表达式的值和 console.log 的输出作为结果返回，emitImage(buffer) 返回图片。" +
        `默认最多跑 ${DEFAULT_TIMEOUT_MS / 1000} 秒，要等网页里的长任务时调大 timeout_ms。`,
      {
        code: z.string().describe("要执行的 JavaScript，例如 await page.goto('https://example.com'); await page.title()"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(`这次调用最多跑多久（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}`),
      },
      async ({ code, timeout_ms }, extra) => {
        try {
          const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
          const result = await repl.run(code, timeout_ms ?? DEFAULT_TIMEOUT_MS, signal);
          const body = keep && result.opened && !result.isError ? `${result.text}\n\n${KEEP_HINT}` : result.text;
          rememberResult(extra, result.text, result.isError);
          return {
            content: [{ type: "text" as const, text: body }, ...result.images.map((img) => ({ type: "image" as const, ...img }))],
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (err) {
          rememberResult(extra, errorMessage(err), true);
          return error(errorMessage(err));
        }
      },
      { annotations: { title: "Run browser code", readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    ),
    tool(
      "browser_snapshot",
      "读当前标签页的页面结构（无障碍树，元素带 [ref=e12]，代码里用 page.locator('aria-ref=e12') 引用），前面列出所有标签页。不改动页面。",
      {},
      async () => {
        try {
          const { context, page } = await repl.current();
          const notice = repl.takeNotice();
          if (!page) return error(withNotice(notice, noPage));
          const snapshot = await page.ariaSnapshot({ mode: "ai", timeout: 15_000 });
          return text(withNotice(notice, `标签页：\n${await describe(context.pages(), page)}\n\n当前标签页 ${page.url()} 的结构：\n${snapshot}`));
        } catch (err) {
          return error(errorMessage(err));
        }
      },
      { annotations: { title: "Page snapshot", readOnlyHint: true, openWorldHint: false } },
    ),
    tool(
      "browser_take_screenshot",
      "给当前标签页截图（默认只截可见区域，full_page 截整页）。只在要看样式、图片时用，读文字和结构用 browser_snapshot。",
      { full_page: z.boolean().optional().describe("截整个页面，默认只截可见区域") },
      async ({ full_page }) => {
        try {
          const { page } = await repl.current();
          const notice = repl.takeNotice();
          if (!page) return error(withNotice(notice, noPage));
          // 整页可能很长，用 JPEG 压一下
          const data = full_page
            ? await page.screenshot({ fullPage: true, type: "jpeg", quality: 80, timeout: 15_000 })
            : await page.screenshot({ type: "png", timeout: 15_000 });
          return {
            content: [
              ...(notice ? [{ type: "text" as const, text: notice }] : []),
              { type: "image" as const, data: data.toString("base64"), mimeType: full_page ? "image/jpeg" : "image/png" },
            ],
          };
        } catch (err) {
          return error(errorMessage(err));
        }
      },
      { annotations: { title: "Screenshot", readOnlyHint: true, openWorldHint: false } },
    ),
    tool(
      "browser_tabs",
      "列出标签页（action: list），或把第 index 个设为当前标签页（action: select，代码里的 page 跟着换）。新开、关闭标签页用 browser_run_code。",
      {
        action: z.enum(["list", "select"]),
        index: z.number().int().min(0).optional().describe("action 为 select 时：标签页序号（list 结果里的 [序号]）"),
      },
      async ({ action, index }) => {
        try {
          const { context, page } = await repl.current();
          const notice = repl.takeNotice();
          const pages = context.pages();
          if (action === "select") {
            const target = index === undefined ? undefined : pages[index];
            if (!target) return error(withNotice(notice, `没有序号为 ${index ?? "（未指定）"} 的标签页。`));
            repl.setPage(target);
            await target.bringToFront().catch(() => undefined);
            return text(withNotice(notice, `已切换到：\n${await describe(pages, target)}`));
          }
          return text(withNotice(notice, pages.length ? await describe(pages, page) : "没有标签页。"));
        } catch (err) {
          return error(errorMessage(err));
        }
      },
      { annotations: { title: "Tabs", readOnlyHint: true, openWorldHint: false } },
    ),
    ...(keep
      ? [
          tool(
            "browser_keep_tab",
            "把你最近操作的那个标签页留给用户：不在这一轮结束时关闭。用户要看的页面（让你打开、找到的网页）在回复前调用。",
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

/**
 * 内置浏览器到桌面版外壳的连接，每个会话一条（connectOverCDP 走外壳的这个会话的 CDP 代理），第一次用到时才连；
 * 桌面版没开时报错，开了之后再调用就能用，断了下次用到再连
 */
function inappContext(host: BrowserHost, sessionId: string): () => Promise<BrowserContext> {
  let connecting: Promise<Browser> | null = null;
  return async () => {
    if (!connecting) {
      const attempt: Promise<Browser> = chromium.connectOverCDP(host.transport(sessionId)).then(
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
  };
}

/** 给模型用的内置浏览器工具，每个会话一个 MCP 服务器；REPL 和连接按会话保留（replFor） */
export function browserServer(host: BrowserHost, sessionId: string): McpSdkServerConfigWithInstance {
  return browserMcpServer({
    name: BROWSER_SERVER,
    instructions: INSTRUCTIONS + (externalBrowserEnabled ? CHROME_NOTE : ""),
    repl: replFor(`${BROWSER_SERVER}:${sessionId}`, inappContext(host, sessionId), INAPP_CLOSED_HINT),
    keep: async () => {
      const tab = await host.keep(sessionId);
      return tab ? `已留下标签页「${tab.title || tab.url}」（${tab.url}），这一轮结束后不会关闭。` : null;
    },
  });
}
