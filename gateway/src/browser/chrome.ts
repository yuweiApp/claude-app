import path from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Browser, BrowserContext } from "playwright-core";
import { config } from "../config.js";
import { patchTools, playwrightTools, READ_TOOL_NAMES, sdkServer } from "./tool.js";

/** MCP 服务器名：工具全名是 mcp__chrome__browser_click 这样 */
export const CHROME_SERVER = "chrome";

/** 只读的工具不用确认，其余的走权限卡片：操作的是用户真实登录着的账号，不比内置浏览器放得更宽 */
export const CHROME_READ_TOOLS = READ_TOOL_NAMES.map((name) => `mcp__${CHROME_SERVER}__${name}`);

/** 连接页（扩展的 connect.html）上显示的客户端名 */
const CLIENT_NAME = "claude-app";

const INSTRUCTIONS =
  "这些工具操作的是用户自己的 Chrome（经 Playwright 扩展连接，带着用户的登录状态和 Cookie），不是右侧面板里的内置浏览器（mcp__inapp__ 开头的工具）。" +
  "用户说「我的 Chrome」「外部浏览器」，或者网页要用到用户的登录状态时才用；其他情况用内置浏览器。" +
  "只能看到交给 Playwright 的标签页（Chrome 里 Playwright 标签页组里的：用户连接时选的，加上你新开的），看不到用户其他的标签页；所有会话共用这一组。" +
  "第一次调用时 Chrome 会打开扩展的连接页，要等用户在 Chrome 里选标签页、点允许，工具才返回；报错时把错误告诉用户（比如扩展没装）。" +
  "先用 browser_snapshot 读页面结构（无障碍树），再按里面的 ref 点击、输入；截图只在需要看样式、图片时用。" +
  "你新开的标签页不会自动关闭：用完、用户也不需要看的，用 browser_tabs 关掉；不要关用户自己的标签页。" +
  "用户消息里的 @chrome[标题](网址) 指 Chrome 里的一个标签页：用 browser_tabs 列出标签页，按网址找到它再切过去。";

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

/** 给模型用的外部 Chrome 工具（Playwright MCP），每个会话一个，共用 chromeBridge 的连接 */
export function chromeServer(sessionId: string): McpSdkServerConfigWithInstance {
  const server = playwrightTools
    .createConnection(
      {
        browser: { isolated: false },
        outputDir: path.join(config.workspaceDir, ".playwright-mcp", `chrome-${sessionId}`),
      },
      () => chromeBridge.context(),
    )
    .then((s) => {
      s._instructions = INSTRUCTIONS;
      patchTools(s, CHROME_SERVER);
      return s;
    });
  return sdkServer(CHROME_SERVER, server);
}
