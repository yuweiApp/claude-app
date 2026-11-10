import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Browser, BrowserContext } from "playwright-core";
import { config } from "../config.js";
import { externalBrowserEnabled, externalBrowserTabGroup } from "../config-file.js";
import type { ExternalBrowserId, ExternalBrowserTabs } from "../shared/types.js";
import { BrowserRepl } from "./repl.js";
import { browserMcpServer, READ_TOOL_NAMES, replFor, RUNTIME_FACTS } from "./tool.js";

/** 连接页（扩展的 connect.html）上显示的客户端名 */
const CLIENT_NAME = "claude-app";

/** Playwright Extension 在 Chrome 应用商店里的 id；Edge 也从 Chrome 应用商店装，id 一样（连接页的地址写死了这个 id） */
const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
const INSTALL_URL = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`;

/** Playwright 读的扩展 token 环境变量（CDPRelayServer 构造时读一次），见 connect() */
const PLAYWRIGHT_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";

interface Spec {
  /** 也是 MCP 服务器名：工具全名是 mcp__chrome__browser_run_code、mcp__edge__browser_run_code 这样 */
  id: ExternalBrowserId;
  name: string;
  /** Playwright 的浏览器通道，按它找可执行文件 */
  channel: string;
  /** 默认的用户数据目录（下面是 Default、Profile 1 这些配置） */
  userDataDir: Partial<Record<NodeJS.Platform, string>>;
  /** 扩展 token（连接页上复制的那一行）：设了就自动连、不显示批准界面。config.ts 的 agentEnv 不把它传给 claude 子进程 */
  tokenEnv: string;
  /** 指定用哪个配置（如 "Profile 1"），默认是装了扩展的、最近用过的那个 */
  profileEnv: string;
}

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const macSupport = path.join(os.homedir(), "Library", "Application Support");

const SPECS: Spec[] = [
  {
    id: "chrome",
    name: "Chrome",
    channel: "chrome",
    userDataDir: {
      win32: path.join(localAppData, "Google", "Chrome", "User Data"),
      darwin: path.join(macSupport, "Google", "Chrome"),
      linux: path.join(os.homedir(), ".config", "google-chrome"),
    },
    tokenEnv: PLAYWRIGHT_TOKEN_ENV,
    profileEnv: "PLAYWRIGHT_MCP_PROFILE_DIR_NAME",
  },
  {
    id: "edge",
    name: "Edge",
    channel: "msedge",
    userDataDir: {
      win32: path.join(localAppData, "Microsoft", "Edge", "User Data"),
      darwin: path.join(macSupport, "Microsoft Edge"),
      linux: path.join(os.homedir(), ".config", "microsoft-edge"),
    },
    tokenEnv: "PLAYWRIGHT_MCP_EDGE_EXTENSION_TOKEN",
    profileEnv: "PLAYWRIGHT_MCP_EDGE_PROFILE_DIR_NAME",
  },
];

const coreBundle = createRequire(import.meta.url)("playwright-core/lib/coreBundle") as {
  /**
   * playwright-core 自带的 Playwright MCP 里连扩展的那部分（@playwright/mcp 也只是转出 lib/coreBundle 的 tools）：
   * 起中转、拉起浏览器打开扩展的连接页、等扩展连上。工具不用它的，见 tool.ts 的 browserMcpServer
   */
  tools: {
    /** 按 Playwright MCP 的配置建浏览器（扩展模式是起中转、等扩展连上）；cliOptions 里的 browser、executablePath、profileDirName 优先于环境变量 */
    createBrowserWithInfo(config: object, clientInfo: { clientName: string; cwd: string }, cliOptions: object, bindOptions: { title: string; workspaceDir: string }): Promise<{ browser: Browser }>;
    /** 把 CLI 参数和 PLAYWRIGHT_MCP_* 环境变量合成完整的配置 */
    resolveCLIConfigForMCP(cliOptions: object, env: NodeJS.ProcessEnv): Promise<object>;
  };
  registry: { registry: { findExecutable(name: string): { executablePath(): string | undefined } | undefined } };
};

/** 浏览器的可执行文件（装在标准位置的），没装是 undefined */
function findExecutable(channel: string): string | undefined {
  try {
    return coreBundle.registry.registry.findExecutable(channel)?.executablePath() || undefined;
  } catch {
    return undefined;
  }
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** 这个配置里装没装扩展：扩展目录在，或者 Preferences 里有它的记录（解压加载的） */
async function hasExtension(profileDir: string): Promise<boolean> {
  if (await exists(path.join(profileDir, "Extensions", EXTENSION_ID))) return true;
  for (const file of ["Preferences", "Secure Preferences"]) {
    try {
      const prefs = JSON.parse(await readFile(path.join(profileDir, file), "utf8"));
      const record = prefs?.extensions?.settings?.[EXTENSION_ID];
      if (record && typeof record === "object" && Object.keys(record).length) return true;
    } catch {
      // 没有或读不了，看下一个
    }
  }
  return false;
}

/** 装了扩展的配置，最近用过的（Local State 的 profile.last_used）优先，其余按 Default、Profile 1、Profile 2… */
async function findExtensionProfile(userDataDir: string): Promise<string | undefined> {
  const entries = await readdir(userDataDir).catch(() => [] as string[]);
  const rank = (p: string) => (p === "Default" ? -1 : Number(p.slice("Profile ".length)));
  const profiles = entries.filter((e) => e === "Default" || /^Profile \d+$/.test(e)).sort((a, b) => rank(a) - rank(b));
  let lastUsed: unknown;
  try {
    lastUsed = JSON.parse(await readFile(path.join(userDataDir, "Local State"), "utf8"))?.profile?.last_used;
  } catch {
    // 没有 Local State
  }
  const ordered = typeof lastUsed === "string" && profiles.includes(lastUsed) ? [lastUsed, ...profiles.filter((p) => p !== lastUsed)] : profiles;
  for (const profile of ordered) if (await hasExtension(path.join(userDataDir, profile))) return profile;
  return undefined;
}

/**
 * 到用户的一个浏览器（Chrome 或 Edge）的连接，所有会话共用一条：Playwright 扩展同一个浏览器配置只认一个客户端，
 * 第二个连上来会把第一个顶掉（microsoft/playwright#41838）。Chrome 和 Edge 各连各的，互不影响。
 * 第一次用到时才连（拉起浏览器打开扩展的连接页，等用户允许，不限时；设了 token 时自动连，30 秒连不上报错），
 * 断了下次用到再连
 */
class ExternalBridge {
  private connecting: Promise<Browser> | null = null;
  private browser: Browser | null = null;

  constructor(
    private readonly spec: Spec,
    private readonly executablePath: string,
  ) {}

  async context(): Promise<BrowserContext> {
    this.connecting ??= this.connect();
    const browser = await this.connecting;
    const context = browser.contexts()[0];
    if (!context) throw new Error(`${this.spec.name} 没有可用的浏览器上下文`);
    return context;
  }

  private async connect(): Promise<Browser> {
    const { spec, executablePath } = this;
    try {
      const userDataDir = spec.userDataDir[process.platform];
      const profile = process.env[spec.profileEnv] || (userDataDir ? await findExtensionProfile(userDataDir) : undefined);
      if (!profile) throw new Error(`${spec.name} 里没有装 Playwright Extension（在 ${userDataDir ?? "默认的用户数据目录"} 的各个配置里都没找到），从 Chrome 应用商店安装：${INSTALL_URL}`);
      // tabGroup: false 时连接页地址带 tabGroup=false，扩展不建标签页组（见 config-file.ts 的 externalBrowserTabGroup）
      const pwConfig = await coreBundle.tools.resolveCLIConfigForMCP({ extension: true, tabGroup: externalBrowserTabGroup }, process.env);
      // Playwright 只认 PLAYWRIGHT_MCP_EXTENSION_TOKEN 一个 token，在 CDPRelayServer 构造时读。
      // 给了 executablePath 和 profileDirName，createBrowserWithInfo 一路同步执行到构造中转（中间没有 await），
      // 所以只在这次同步调用期间换成这个浏览器的 token，调用一返回就换回去，不会串到同时在连的另一个浏览器
      const original = process.env[PLAYWRIGHT_TOKEN_ENV];
      const token = process.env[spec.tokenEnv];
      if (token) process.env[PLAYWRIGHT_TOKEN_ENV] = token;
      else delete process.env[PLAYWRIGHT_TOKEN_ENV];
      let created: Promise<{ browser: Browser }>;
      try {
        created = coreBundle.tools.createBrowserWithInfo(
          pwConfig,
          { clientName: CLIENT_NAME, cwd: config.workspaceDir },
          { browser: spec.channel, executablePath, profileDirName: profile },
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

export interface ExternalBrowser {
  id: ExternalBrowserId;
  name: string;
  bridge: ExternalBridge;
  /** 只读的工具不用确认，browser_run_code 走权限卡片（「完全访问权限」下直接执行）：操作的是用户真实登录着的账号，不比内置浏览器放得更宽 */
  readTools: string[];
}

/**
 * 开着的外部浏览器：config.yml 的 externalBrowser.enabled 开着，并且这台电脑上装了（标准位置找得到可执行文件）。
 * 启动时定一次，之后新装的浏览器要重启网关
 */
export const externalBrowsers: ExternalBrowser[] = externalBrowserEnabled
  ? SPECS.flatMap((spec) => {
      const executablePath = findExecutable(spec.channel);
      if (!executablePath) return [];
      return [{ id: spec.id, name: spec.name, bridge: new ExternalBridge(spec, executablePath), readTools: READ_TOOL_NAMES.map((n) => `mcp__${spec.id}__${n}`) }];
    })
  : [];

/** GET /external/tabs */
export const externalTabs = (): Promise<ExternalBrowserTabs[]> =>
  Promise.all(externalBrowsers.map(async (b) => ({ id: b.id, name: b.name, tabs: await b.bridge.tabs() })));

/** 内置浏览器的说明里补一句：另外还有哪些浏览器（没有外部浏览器时是空的） */
export function externalNote(): string {
  return externalBrowsers.map((b) => `\n另有 mcp__${b.id}__ 开头的工具，操作的是用户自己的 ${b.name}，带着用户的登录状态。`).join("");
}

function instructions(b: ExternalBrowser): string {
  const others = externalBrowsers.filter((o) => o !== b);
  return [
    `用户自己的 ${b.name}：经 Playwright 扩展连接，带着用户的登录状态和 Cookie；右侧面板里的内置浏览器是另一组工具（mcp__inapp__）` +
      others.map((o) => `，用户自己的 ${o.name} 是 mcp__${o.id}__`).join("") +
      "。",
    externalBrowserTabGroup
      ? `能看到的标签页只有 ${b.name} 里 Playwright 标签页组里的（用户连接时选的，加上通过这里新开的），所有会话共用这一组。`
      : `能看到的标签页只有交给 Playwright 的那些（用户连接时选的那一个，加上通过这里新开的和从它们弹出的），用户的其他标签页看不到，所有会话共用这一批。`,
    `第一次调用时，${b.name} 会打开扩展的连接页，用户选好标签页、点允许之后工具才返回；扩展没装、连接失败时工具返回错误。`,
    RUNTIME_FACTS,
    "标签页：通过这里开的标签页不会自动关闭。标签页被新开、关闭时，下一次工具结果里会列出变化，只能分出是不是你做的（扩展不提供是用户还是网页）。",
    `用户消息里的 @${b.name} 指这个浏览器（用户自己的 ${b.name}），@${b.id}[标题](网址) 指这里的一个标签页。`,
  ].join("\n");
}

/**
 * 给模型用的外部浏览器工具，每个会话每个浏览器一个 MCP 服务器，共用这个浏览器的连接；REPL 按会话保留（replFor）。
 * 和内置浏览器不同，REPL 在网关主线程里：扩展同一时间只认一个客户端，所有会话共用一条连接，没法分到各自的 worker
 */
export function externalServers(sessionId: string, resumed = false): Record<string, McpSdkServerConfigWithInstance> {
  return Object.fromEntries(
    externalBrowsers.map((b) => [
      b.id,
      browserMcpServer({
        name: b.id,
        instructions: instructions(b),
        repl: replFor(`${b.id}:${sessionId}`, () => new BrowserRepl(() => b.bridge.context()), resumed),
      }),
    ]),
  );
}
