import { createRequire } from "node:module";
import path from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { chromium } from "playwright-core";
import { config } from "../config.js";
import { ALWAYS_LOAD_META, isAlwaysLoad } from "../config-file.js";
import type { BrowserHost } from "./host.js";

/**
 * MCP 服务器名：工具全名是 mcp__web__browser_navigate 这样。
 * 不叫 browser：Playwright 的工具名自带 browser_ 前缀，叫 browser 就成了 mcp__browser__browser_navigate，又长又重复
 */
export const BROWSER_SERVER = "web";

/** 只读的工具不用确认（options.allowedTools）；打开网址、点击、输入等走权限卡片（「完全访问权限」下直接执行） */
export const BROWSER_READ_TOOLS = [
  "browser_keep_tab",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_find",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_wait_for",
].map((name) => `mcp__${BROWSER_SERVER}__${name}`);

/**
 * 去掉的工具：
 * - browser_resize：改视口会改掉面板里原生视图的网页大小（视口由面板决定）
 * - browser_close：会关掉整个浏览器上下文；关标签页用 browser_tabs
 *
 * browser_run_code_unsafe 留着：拿 Playwright 的 page 跑一段脚本（多步操作一次做完、等网络请求、拦截请求、上传文件等）。
 * 它在网关进程里执行（Node 的 vm 不是安全边界，能碰到网关的文件和环境变量），等同于 Bash，
 * 所以不放进 allowedTools，每次走权限卡片（「完全访问权限」下和 Bash 一样直接执行）
 */
const HIDDEN_TOOLS = new Set(["browser_resize", "browser_close"]);

// 常驻哪些工具（第一轮就给完整定义、不藏在 ToolSearch 后面）在 gateway/config.yml 的 tools.alwaysLoad 里配，
// 默认是 snapshot、navigate、click、type、tabs、keep_tab；为什么要常驻见那里的说明和 docs/README.md 第 12 节

const INSTRUCTIONS =
  "这些工具操作的是用户界面右侧面板里的内置浏览器（桌面版里的真实网页，用户能看到、也能自己操作），" +
  "只能看到和操作这个会话自己的标签页。用户说「浏览器」「内置浏览器」「打开网页」时指的就是它。" +
  "先用 browser_snapshot 读页面结构（无障碍树），再按里面的 ref 点击、输入；截图只在需要看样式、图片时用。" +
  "只是在网页里执行 JS 用 browser_evaluate；browser_run_code_unsafe 拿 Playwright 的 page 跑脚本（多步操作、等请求、拦截请求等），" +
  "每次要用户确认，单个工具能做到的不要用它。" +
  "你新开的标签页是临时的，这一轮结束时会自动关掉；用户要看的页面（比如让你打开、找到某个网页），在结束前对它调用 browser_keep_tab 留下。" +
  "用户消息里的 @[标题](网址) 指内置浏览器里的一个标签页：用 browser_tabs 列出标签页，按网址找到它再切过去。";

/** 打开网页后提醒模型：临时标签页这一轮结束会关，要留给用户就 browser_keep_tab（模型常忘） */
const KEEP_HINT = "\n\n（这是你开的临时标签页，这一轮结束会自动关闭；如果是给用户看的页面，结束前调用 browser_keep_tab 留下。）";
const KEEP_TOOL = {
  name: "browser_keep_tab",
  description: "把你最近操作的那个标签页留给用户：不在这一轮结束时关闭。用户要看的页面（让你打开、找到的网页）在回复前调用。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "Keep tab for the user", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

// MCP 服务器的实现在 playwright-core 里（@playwright/mcp 也只是转出这个函数），用同一个包、同一个版本
type McpServerLike = {
  connect(transport: unknown): Promise<void>;
  _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  _instructions?: string;
};
type CreateConnection = (config: object, contextGetter: () => Promise<import("playwright-core").BrowserContext>) => Promise<McpServerLike>;
const { tools } = createRequire(import.meta.url)("playwright-core/lib/coreBundle") as { tools: { createConnection: CreateConnection } };

/**
 * 给模型用的浏览器工具（Playwright MCP），每个会话一个。浏览器经 BrowserHost 连到桌面版外壳，
 * 第一次调用工具时才连（connectOverCDP 走外壳的这个会话的 CDP 代理）；桌面版没开时工具返回错误，开了之后再调用就能用
 */
export function browserServer(host: BrowserHost, sessionId: string): McpSdkServerConfigWithInstance {
  const server = tools
    .createConnection(
      {
        browser: { isolated: false },
        // 截图等文件存到工作区下，不写进用户的项目文件夹
        outputDir: path.join(config.workspaceDir, ".playwright-mcp", sessionId),
      },
      async () => {
        const browser = await chromium.connectOverCDP(host.transport(sessionId));
        const context = browser.contexts()[0];
        if (!context) throw new Error("内置浏览器没有可用的浏览器上下文");
        return context;
      },
    )
    .then((s) => {
      s._instructions = INSTRUCTIONS;
      patchTools(s, host, sessionId);
      return s;
    });
  // SDK 只调用 instance.connect（把它的传输接上来）；createConnection 是异步的，等它建好再接
  const instance = { connect: async (transport: unknown) => (await server).connect(transport) };
  return { type: "sdk", name: BROWSER_SERVER, instance: instance as unknown as McpSdkServerConfigWithInstance["instance"] };
}

/**
 * 改写 Playwright MCP 的工具：去掉 HIDDEN_TOOLS（它的配置关不掉核心工具）；加上 browser_keep_tab；
 * config.yml 里配了常驻的标上 _meta；打开网页（browser_navigate、browser_tabs new）的结果后面附 KEEP_HINT
 */
function patchTools(server: McpServerLike, host: BrowserHost, sessionId: string): void {
  const handlers = server._requestHandlers;
  const list = handlers.get("tools/list");
  const call = handlers.get("tools/call");
  if (!list || !call) throw new Error("Playwright MCP 的接口变了：找不到 tools/list、tools/call");
  handlers.set("tools/list", async (request, extra) => {
    const result = (await list(request, extra)) as { tools: { name: string; _meta?: Record<string, unknown> }[] };
    const tools = [...result.tools.filter((t) => !HIDDEN_TOOLS.has(t.name)), KEEP_TOOL].map((t) =>
      isAlwaysLoad(`mcp__${BROWSER_SERVER}__${t.name}`) ? { ...t, _meta: { ...("_meta" in t ? t._meta : undefined), [ALWAYS_LOAD_META]: true } } : t,
    );
    return { ...result, tools };
  });
  handlers.set("tools/call", async (request, extra) => {
    const params = (request as { params?: { name?: string; arguments?: { action?: string } } }).params;
    const name = params?.name ?? "";
    const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
    if (HIDDEN_TOOLS.has(name)) return text(`工具 ${name} 在内置浏览器里不可用`, true);
    if (name === KEEP_TOOL.name) {
      try {
        const tab = await host.keep(sessionId);
        return tab ? text(`已留下标签页「${tab.title || tab.url}」（${tab.url}），这一轮结束后不会关闭。`) : text("没有你操作过的标签页可以留下。", true);
      } catch (err) {
        return text((err as Error).message, true);
      }
    }
    const result = (await call(request, extra)) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const opened = name === "browser_navigate" || (name === "browser_tabs" && params?.arguments?.action === "new");
    if (opened && !result.isError && result.content) result.content = [...result.content, { type: "text", text: KEEP_HINT.trim() }];
    return result;
  });
}
