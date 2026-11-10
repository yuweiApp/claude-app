import { createRequire } from "node:module";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Browser, BrowserContext } from "playwright-core";
import { config } from "../config.js";
import type { ExternalBrowserInfo, ExternalBrowserTabs } from "../shared/types.js";
import { listBrowsers, tabGroupEnabled, type ResolvedBrowser } from "./browser-settings.js";
import { INSTALL_URL } from "./catalog.js";
import { BrowserRepl } from "./repl.js";
import { browserMcpServer, READ_TOOL_NAMES, replFor, RUNTIME_FACTS } from "./tool.js";

/**
 * 外部浏览器：用户自己的 Chrome、Edge、Brave 等 Chromium 内核浏览器，经 Playwright 扩展连接。
 * 有哪些、启用哪些见 catalog.ts（检测）和 browser-settings.ts（设置页「浏览器」）
 */

/** 连接页（扩展的 connect.html）上显示的客户端名 */
const CLIENT_NAME = "claude-app";

/** Playwright 读的扩展 token 环境变量（CDPRelayServer 构造时读一次），见 connect() */
const PLAYWRIGHT_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";

const coreBundle = createRequire(import.meta.url)("playwright-core/lib/coreBundle") as {
  /**
   * playwright-core 自带的 Playwright MCP 里连扩展的那部分（@playwright/mcp 也只是转出 lib/coreBundle 的 tools）：
   * 起中转、拉起浏览器打开扩展的连接页、等扩展连上。工具不用它的，见 tool.ts 的 browserMcpServer
   */
  tools: {
    /** 按 Playwright MCP 的配置建浏览器（扩展模式是起中转、等扩展连上）；cliOptions 里的 executablePath、profileDirName 优先于环境变量 */
    createBrowserWithInfo(config: object, clientInfo: { clientName: string; cwd: string }, cliOptions: object, bindOptions: { title: string; workspaceDir: string }): Promise<{ browser: Browser }>;
    /** 把 CLI 参数和 PLAYWRIGHT_MCP_* 环境变量合成完整的配置 */
    resolveCLIConfigForMCP(cliOptions: object, env: NodeJS.ProcessEnv): Promise<{ browser: { userDataDir?: string } }>;
  };
};

/**
 * 到用户的一个浏览器的连接，所有会话共用一条：Playwright 扩展同一个浏览器配置只认一个客户端，
 * 第二个连上来会把第一个顶掉（microsoft/playwright#41838）。不同的浏览器各连各的，互不影响。
 * 第一次用到时才连（拉起浏览器打开扩展的连接页，等用户允许，不限时；设了 token 时自动连，30 秒连不上报错），
 * 断了下次用到再连。程序路径、配置、token 每次连接时按设置页现在的设置取
 */
class ExternalBridge {
  private connecting: Promise<Browser> | null = null;
  private browser: Browser | null = null;

  constructor(
    private readonly id: string,
    private readonly name: string,
  ) {}

  async context(): Promise<BrowserContext> {
    this.connecting ??= this.connect();
    const browser = await this.connecting;
    const context = browser.contexts()[0];
    if (!context) throw new Error(`${this.name} 没有可用的浏览器上下文`);
    return context;
  }

  private async connect(): Promise<Browser> {
    try {
      const entry = listBrowsers().find((b) => b.id === this.id);
      if (!entry) throw new Error(`${this.name} 已经从设置里移除，或者这台电脑上找不到它了`);
      if (!entry.installed) throw new Error(`找不到 ${entry.name} 的可执行文件：${entry.executablePath}`);
      if (entry.profiles.length && !entry.extension)
        throw new Error(`${entry.name} 里没有装 Playwright Extension（${entry.userDataDir} 下的各个配置里都没找到），从 Chrome 应用商店安装：${INSTALL_URL}`);
      // tabGroup: false 时连接页地址带 tabGroup=false，扩展不建标签页组（见 browser-settings.ts 的 tabGroupEnabled）
      const pwConfig = await coreBundle.tools.resolveCLIConfigForMCP({ extension: true, tabGroup: tabGroupEnabled() }, process.env);
      // 用户数据目录不交给 Playwright：传了它，createBrowserWithInfo 会先 await 去找配置，下面换 token 的前提就不成立了
      pwConfig.browser.userDataDir = undefined;
      // Playwright 只认 PLAYWRIGHT_MCP_EXTENSION_TOKEN 一个 token，在 CDPRelayServer 构造时读。
      // 给了 executablePath（profileDirName 有没有都行），createBrowserWithInfo 一路同步执行到构造中转（中间没有 await），
      // 所以只在这次同步调用期间换成这个浏览器的 token，调用一返回就换回去，不会串到同时在连的另一个浏览器
      const original = process.env[PLAYWRIGHT_TOKEN_ENV];
      if (entry.token) process.env[PLAYWRIGHT_TOKEN_ENV] = entry.token;
      else delete process.env[PLAYWRIGHT_TOKEN_ENV];
      let created: Promise<{ browser: Browser }>;
      try {
        created = coreBundle.tools.createBrowserWithInfo(
          pwConfig,
          { clientName: CLIENT_NAME, cwd: config.workspaceDir },
          { executablePath: entry.executablePath, ...(entry.profileDir ? { profileDirName: entry.profileDir } : {}) },
          { title: CLIENT_NAME, workspaceDir: config.workspaceDir },
        );
      } finally {
        if (original === undefined) delete process.env[PLAYWRIGHT_TOKEN_ENV];
        else process.env[PLAYWRIGHT_TOKEN_ENV] = original;
      }
      const { browser } = await created;
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

  /** 输入框 @ 引用用：已连上时列出标签页；没连上返回空的，不为了列标签页去拉起连接页 */
  async tabs(): Promise<{ title: string; url: string }[]> {
    const context = this.browser?.contexts()[0];
    if (!context) return [];
    const pages = context.pages();
    // 后台冻结的标签页 title() 可能迟迟不回，最多等 1 秒
    const title = (page: (typeof pages)[number]) =>
      Promise.race([page.title().catch(() => ""), new Promise<string>((resolve) => setTimeout(() => resolve(""), 1000))]);
    return Promise.all(pages.map(async (page) => ({ url: page.url(), title: await title(page) })));
  }
}

/** 每个浏览器一条连接，第一次用到时建，网关运行期间一直留着（设置里停用了也不断开，已经挂了工具的会话还能用） */
const bridges = new Map<string, ExternalBridge>();

function bridgeOf(b: ExternalBrowserInfo): ExternalBridge {
  let bridge = bridges.get(b.id);
  if (!bridge) bridges.set(b.id, (bridge = new ExternalBridge(b.id, b.name)));
  return bridge;
}

/** 启用着的外部浏览器（设置页「浏览器」里开着、可执行文件还在的），每次调用都重新检测 */
export function activeBrowsers(): ResolvedBrowser[] {
  return listBrowsers().filter((b) => b.enabled);
}

/** 只读的工具不用确认，browser_run_code 走权限卡片（「完全访问权限」下直接执行）：操作的是用户真实登录着的账号，不比内置浏览器放得更宽 */
export const externalReadTools = (active: ExternalBrowserInfo[]) => active.flatMap((b) => READ_TOOL_NAMES.map((n) => `mcp__${b.id}__${n}`));

/** GET /external/tabs：启用着的外部浏览器，连上了的带上标签页 */
export const externalTabs = (): Promise<ExternalBrowserTabs[]> =>
  Promise.all(activeBrowsers().map(async ({ id, name, logo }) => ({ id, name, logo, tabs: (await bridges.get(id)?.tabs()) ?? [] })));

/** 内置浏览器的说明里补一句：另外还有哪些浏览器（没有外部浏览器时是空的） */
export function externalNote(active: ExternalBrowserInfo[]): string {
  return active.map((b) => `\n另有 mcp__${b.id}__ 开头的工具，操作的是用户自己的 ${b.name}，带着用户的登录状态。`).join("");
}

function instructions(b: ExternalBrowserInfo, active: ExternalBrowserInfo[]): string {
  const others = active.filter((o) => o.id !== b.id);
  return [
    `用户自己的 ${b.name}：经 Playwright 扩展连接，带着用户的登录状态和 Cookie；右侧面板里的内置浏览器是另一组工具（mcp__inapp__）` +
      others.map((o) => `，用户自己的 ${o.name} 是 mcp__${o.id}__`).join("") +
      "。",
    tabGroupEnabled()
      ? `能看到的标签页只有 ${b.name} 里 Playwright 标签页组里的（用户连接时选的，加上通过这里新开的），所有会话共用这一组。`
      : `能看到的标签页只有交给 Playwright 的那些（用户连接时选的那一个，加上通过这里新开的和从它们弹出的），用户的其他标签页看不到，所有会话共用这一批。`,
    `第一次调用时，${b.name} 会打开扩展的连接页，用户选好标签页、点允许之后工具才返回；扩展没装、连接失败时工具返回错误。`,
    RUNTIME_FACTS,
    "标签页：通过这里开的标签页不会自动关闭。标签页被新开、关闭时，下一次工具结果里会列出变化，只能分出是不是你做的（扩展不提供是用户还是网页）。",
    `用户消息里的 @${b.name} 指这个浏览器（用户自己的 ${b.name}），@${b.id}[标题](网址) 指这里的一个标签页。`,
  ].join("\n");
}

/**
 * 给模型用的外部浏览器工具，每个会话每个启用着的浏览器一个 MCP 服务器，共用这个浏览器的连接；REPL 按会话保留（replFor）。
 * 和内置浏览器不同，REPL 在网关主线程里：扩展同一时间只认一个客户端，所有会话共用一条连接，没法分到各自的 worker
 */
export function externalServers(active: ExternalBrowserInfo[], sessionId: string, resumed = false): Record<string, McpSdkServerConfigWithInstance> {
  return Object.fromEntries(
    active.map((b) => [
      b.id,
      browserMcpServer({
        name: b.id,
        instructions: instructions(b, active),
        repl: replFor(`${b.id}:${sessionId}`, () => new BrowserRepl(() => bridgeOf(b).context()), resumed),
      }),
    ]),
  );
}
