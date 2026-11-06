import { createRequire } from "node:module";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Browser, BrowserContext } from "playwright-core";
import { config } from "../config.js";
import { browserMcpServer, READ_TOOL_NAMES, replFor, RUNTIME_FACTS } from "./tool.js";

/** MCP 服务器名：工具全名是 mcp__chrome__browser_run_code 这样 */
export const CHROME_SERVER = "chrome";

/** 只读的工具不用确认，browser_run_code 走权限卡片（「完全访问权限」下直接执行）：操作的是用户真实登录着的账号，不比内置浏览器放得更宽 */
export const CHROME_READ_TOOLS = READ_TOOL_NAMES.map((name) => `mcp__${CHROME_SERVER}__${name}`);

/** 连接页（扩展的 connect.html）上显示的客户端名 */
const CLIENT_NAME = "claude-app";

/**
 * playwright-core 自带的 Playwright MCP 里连扩展的那部分（@playwright/mcp 也只是转出 lib/coreBundle 的 tools）：
 * 起中转、拉起 Chrome 打开扩展的连接页、等扩展连上。工具不用它的，见 tool.ts 的 browserMcpServer
 */
const playwrightTools = createRequire(import.meta.url)("playwright-core/lib/coreBundle").tools as {
  /** 按 Playwright MCP 的配置建浏览器（扩展模式是起中转、等扩展连上） */
  createBrowserWithInfo(config: object, clientInfo: { clientName: string; cwd: string }, cliOptions: object, bindOptions: { title: string; workspaceDir: string }): Promise<{ browser: Browser }>;
  /** 把 CLI 参数和 PLAYWRIGHT_MCP_* 环境变量合成完整的配置 */
  resolveCLIConfigForMCP(cliOptions: object, env: NodeJS.ProcessEnv): Promise<object>;
};

const INSTRUCTIONS = [
  "用户自己的 Chrome：经 Playwright 扩展连接，带着用户的登录状态和 Cookie；右侧面板里的内置浏览器是另一组工具（mcp__inapp__）。",
  "能看到的标签页只有 Chrome 里 Playwright 标签页组里的（用户连接时选的，加上通过这里新开的），所有会话共用这一组。",
  "第一次调用时，Chrome 会打开扩展的连接页，用户选好标签页、点允许之后工具才返回；扩展没装、连接失败时工具返回错误。",
  RUNTIME_FACTS,
  "标签页：通过这里开的标签页不会自动关闭。标签页被新开、关闭时，下一次工具结果里会列出变化，只能分出是不是你做的（扩展不提供是用户还是网页）。",
  "用户消息里的 @chrome[标题](网址) 指这里的一个标签页。",
].join("\n");

/**
 * 到用户 Chrome 的连接，所有会话共用一条：Playwright 扩展同一个 Chrome 配置只认一个客户端，
 * 第二个连上来会把第一个顶掉（microsoft/playwright#41838）。
 * 第一次用到时才连（拉起 Chrome 打开扩展的连接页，等用户允许，不限时；设了 PLAYWRIGHT_MCP_EXTENSION_TOKEN 时自动连，30 秒连不上报错），
 * 断了下次用到再连
 */
class ChromeBridge {
  private connecting: Promise<Browser> | null = null;
  private browser: Browser | null = null;

  async context(): Promise<BrowserContext> {
    this.connecting ??= this.connect();
    const browser = await this.connecting;
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome 没有可用的浏览器上下文");
    return context;
  }

  private async connect(): Promise<Browser> {
    try {
      // 扩展模式：起中转、拉起 Chrome 打开连接页、等扩展连上。Chrome、配置目录、token 读 PLAYWRIGHT_MCP_* 环境变量
      const pwConfig = await playwrightTools.resolveCLIConfigForMCP({ extension: true }, process.env);
      const { browser } = await playwrightTools.createBrowserWithInfo(
        pwConfig,
        { clientName: CLIENT_NAME, cwd: config.workspaceDir },
        {},
        { title: CLIENT_NAME, workspaceDir: config.workspaceDir },
      );
      // createBrowserWithInfo 会把浏览器登记出去给 playwright-cli 接（bind），这里不需要，撤掉
      await (browser as Browser & { unbind?: () => Promise<void> }).unbind?.().catch(() => undefined);
      browser.once("disconnected", () => {
        if (this.browser === browser) this.browser = null;
        this.connecting = null;
      });
      this.browser = browser;
      return browser;
    } catch (err) {
      this.connecting = null;
      throw err;
    }
  }

  /** 输入框 @ 引用用：已连上时列出标签页；没连上返回 null，不为了列标签页去拉起连接页 */
  async tabs(): Promise<{ title: string; url: string }[] | null> {
    const context = this.browser?.contexts()[0];
    if (!context) return null;
    const pages = context.pages();
    // 后台冻结的标签页 title() 可能迟迟不回，最多等 1 秒
    const title = (page: (typeof pages)[number]) =>
      Promise.race([page.title().catch(() => ""), new Promise<string>((resolve) => setTimeout(() => resolve(""), 1000))]);
    return Promise.all(pages.map(async (page) => ({ url: page.url(), title: await title(page) })));
  }
}

export const chromeBridge = new ChromeBridge();

/** 给模型用的外部 Chrome 工具，每个会话一个 MCP 服务器，共用 chromeBridge 的连接；REPL 按会话保留（replFor） */
export function chromeServer(sessionId: string): McpSdkServerConfigWithInstance {
  return browserMcpServer({
    name: CHROME_SERVER,
    instructions: INSTRUCTIONS,
    repl: replFor(`${CHROME_SERVER}:${sessionId}`, () => chromeBridge.context()),
  });
}
