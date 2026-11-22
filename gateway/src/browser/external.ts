import { fsFor, machinePathOf } from "../ssh/host-fs.js";
import { createRequire } from "node:module";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { config } from "../config.js";
import type { ExternalBrowserInfo, ExternalBrowserTabs } from "../shared/types.js";
import { listBrowsers, tabGroupEnabled, type ResolvedBrowser } from "./browser-settings.js";
import { INSTALL_URL } from "./catalog.js";
import { BrowserRepl, closeAutomatically, MAX_URL_CHARS } from "./repl.js";
import { browserMcpServer, replFor, RUN_CODE_TOOL, RUNTIME_FACTS } from "./tool.js";

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

/** 等连接时调用被取消了（用户停掉了后台任务、中断了这一轮），同 repl.ts 里代码跑着时取消的说法 */
const CANCELLED = "已取消。";

/** 一次还没连上的连接 */
interface Attempt {
  /** 发起时的设置（可执行文件、配置、token、建不建标签页组）：等待期间变了就放弃这一次 */
  key: string;
  /** 连上的浏览器；失败、被放弃时拒绝 */
  promise: Promise<Browser>;
  /** 还在等它的调用数 */
  waiters: number;
  giveUp: (err: Error) => void;
}

/**
 * 到用户的一个浏览器的连接，所有会话共用一条：Playwright 扩展同一个浏览器配置只认一个客户端，
 * 第二个连上来会把第一个顶掉（microsoft/playwright#41838）。不同的浏览器各连各的，互不影响。
 * 第一次用到时才连（拉起浏览器打开扩展的连接页，等用户允许，不限时；设了 token 时自动连，30 秒连不上报错），
 * 断了下次用到再连。程序路径、配置、token 每次连接时按设置页现在的设置取。
 *
 * 还在等扩展连上的那一次（attempt）不一定等得到：没设 token 时不限时，用户把连接页关了、转头去设置页填 token，它就一直挂着。
 * 所以它只在还有调用等着、设置也没变时才留着：等待期间设置变了（填了 token、换了配置），或者等它的调用都被取消了，
 * 就放弃它，下一次调用按现在的设置重新连（重新打开连接页）。放弃的那次没法撤掉（Playwright 没给出中转的句柄），
 * 它后来真连上了（用户在旧的连接页上点了允许）就立刻断开
 */
class ExternalBridge {
  private attempt: Attempt | null = null;
  private browser: Browser | null = null;

  constructor(
    private readonly id: string,
    private readonly name: string,
  ) {}

  async context(signal?: AbortSignal): Promise<BrowserContext> {
    const browser = this.browser ?? (await this.connected(signal));
    const context = browser.contexts()[0];
    if (!context) throw new Error(`${this.name} 没有可用的浏览器上下文`);
    return context;
  }

  /** 等连上：接着等正在连的那一次，没有（或者设置变了）就新连一次。signal 取消时只是这个调用不等了 */
  private async connected(signal?: AbortSignal): Promise<Browser> {
    if (signal?.aborted) throw new Error(CANCELLED);
    const entry = listBrowsers().find((b) => b.id === this.id);
    const key = JSON.stringify(entry ? [entry.executablePath, entry.profileDir, entry.token, tabGroupEnabled()] : null);
    if (this.attempt && this.attempt.key !== key) {
      this.abandon(this.attempt, `${this.name} 的连接设置在等待连接期间改了，这次等待已放弃；之后的调用按新的设置连接。`);
    }
    const attempt = (this.attempt ??= this.start(key, entry));
    attempt.waiters++;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<Browser>((resolve, reject) => {
        attempt.promise.then(resolve, reject);
        if (signal) {
          onAbort = () => reject(new Error(CANCELLED));
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      attempt.waiters--;
      // 连上或失败时 this.attempt 已经清掉了；还在就是等它的调用被取消了，没有别的调用在等就放弃
      if (!attempt.waiters && this.attempt === attempt) this.abandon(attempt, CANCELLED);
    }
  }

  private start(key: string, entry: ResolvedBrowser | undefined): Attempt {
    let giveUp!: (err: Error) => void;
    const givenUp = new Promise<never>((_, reject) => (giveUp = reject));
    const attempt: Attempt = { key, waiters: 0, giveUp, promise: givenUp };
    const settled = this.connect(entry).then(
      (browser) => {
        if (this.attempt !== attempt) {
          // 放弃了的那次后来连上了：断开（经扩展连的浏览器 close 只是断开连接，中转跟着停掉），不留着占扩展的那一个客户端位置
          void browser.close().catch(() => undefined);
          throw new Error(`${this.name} 的这次连接已经放弃`);
        }
        this.attempt = null;
        this.browser = browser;
        const context = browser.contexts()[0];
        if (context) dropConnectPage(context);
        browser.once("disconnected", () => {
          if (this.browser === browser) this.browser = null;
        });
        return browser;
      },
      (err: unknown) => {
        if (this.attempt === attempt) this.attempt = null;
        throw err;
      },
    );
    attempt.promise = Promise.race([settled, givenUp]);
    // 没有调用在等时（放弃之后）结果没人接，不当成未处理的拒绝
    attempt.promise.catch(() => undefined);
    settled.catch(() => undefined);
    return attempt;
  }

  /** 不再等这一次：还在等它的调用收到 reason，之后的调用重新连 */
  private abandon(attempt: Attempt, reason: string): void {
    if (this.attempt === attempt) this.attempt = null;
    attempt.giveUp(new Error(reason));
  }

  private async connect(entry: ResolvedBrowser | undefined): Promise<Browser> {
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
    return browser;
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

/** 扩展的连接页（connect.html，标题 Welcome） */
const isConnectPage = (page: Page) => /^chrome-extension:\/\/[^/]+\/connect\.html/.test(page.url());

/**
 * 连接页自己被交出来时（设了 token 自动连接时扩展就这么做；用户在连接页上选了别的标签页的，扩展自己会关掉连接页），
 * 它一直留在浏览器里，显示「"claude-app" connected」。有了别的标签页就把它关掉。
 * 只剩它一个时不能关：交出来的标签页全关了，扩展会断开连接。连接页上的保活定时器只是等连接时用的，
 * 有标签页挂着调试器时扩展不会被回收（用户选了别的标签页时扩展自己也是这样关掉连接页的）
 */
function dropConnectPage(context: BrowserContext): void {
  const sweep = () => {
    const pages = context.pages().filter((p) => !p.isClosed());
    if (!pages.some((p) => !isConnectPage(p))) return;
    for (const p of pages.filter(isConnectPage)) {
      void closeAutomatically(p, "扩展的连接页自动关闭了（有了别的标签页）").catch(() => undefined);
    }
  };
  context.on("page", sweep);
  sweep();
}

/** 每个浏览器一条连接，第一次用到时建，网关运行期间一直留着（设置里停用了也不断开，已经挂了工具的会话还能用） */
const bridges = new Map<string, ExternalBridge>();

function bridgeOf(b: ExternalBrowserInfo): ExternalBridge {
  let bridge = bridges.get(b.id);
  if (!bridge) bridges.set(b.id, (bridge = new ExternalBridge(b.id, b.name)));
  return bridge;
}

/**
 * 设置页「浏览器」的导入登录状态（cookie-import.ts）：经这个浏览器的连接读它整个配置的 cookie（Playwright 的 context.cookies()，
 * 浏览器自己解密好的，Windows 的 App-Bound 加密也不影响）。和 AI 共用同一条连接，没连上就连（没设 token 时拉起连接页等用户允许）；
 * 设置里停用着的也能读。signal 取消时只是这次不等了
 */
export async function externalCookies(id: string, signal?: AbortSignal): Promise<Awaited<ReturnType<BrowserContext["cookies"]>>> {
  const entry = listBrowsers().find((b) => b.id === id);
  if (!entry) throw new Error("没有这个浏览器：已经从设置里移除，或者这台电脑上找不到它了");
  const context = await bridgeOf(entry).context(signal);
  return context.cookies();
}

/** 启用着的外部浏览器（设置页「浏览器」里开着、可执行文件还在的），每次调用都重新检测 */
export function activeBrowsers(): ResolvedBrowser[] {
  return listBrowsers().filter((b) => b.enabled);
}

/** 外部浏览器的 browser_run_code 也不弹权限卡片（用户定的，同内置浏览器）：操作的是用户真实登录着的账号 */
export const externalTools = (active: ExternalBrowserInfo[]) => active.map((b) => `mcp__${b.id}__${RUN_CODE_TOOL}`);

/** GET /external/tabs：启用着的外部浏览器，连上了的带上标签页 */
export const externalTabs = (): Promise<ExternalBrowserTabs[]> =>
  Promise.all(activeBrowsers().map(async ({ id, name, logo }) => ({ id, name, logo, tabs: (await bridges.get(id)?.tabs()) ?? [] })));

/** 内置浏览器的说明里补一句：另外还有哪些浏览器（没有外部浏览器时是空的） */
export function externalNote(active: ExternalBrowserInfo[]): string {
  return active.map((b) => `\n另有 mcp__${b.id}__ 开头的工具，操作的是用户自己的 ${b.name}，带着用户的登录状态。`).join("");
}

/**
 * saveFile、readFile 的 name：相对会话工作目录的路径，不能跑到外面。返回 fsFor 那套写法的绝对路径。
 * outside：name 跑到工作目录外面时的报错（参数是给模型看的工作目录）
 */
function inWorkdir(cwd: string, fn: string, outside: (dir: string) => string, name: unknown): string {
  const { fs, root } = fsFor(cwd);
  const p = fs.path;
  if (typeof name !== "string" || !name.trim()) throw new Error(`${fn} 的第一个参数是文件名（相对工作目录的路径）`);
  const target = p.resolve(root, name);
  const rel = p.relative(root, target);
  if (!rel || rel.startsWith("..") || p.isAbsolute(rel)) throw new Error(`${outside(machinePathOf(cwd, root))}，name 要是相对路径`);
  return target;
}

/**
 * browser_run_code 里的全局函数 saveFile(name, data)：把数据写进会话的工作目录，返回绝对路径。
 * 经扩展连接的浏览器上 Playwright 的 download 事件不会触发（中转把 Browser.setDownloadBehavior 当空操作，浏览器不发下载事件），
 * 下载的文件存到浏览器自己的下载位置，代码拿不到；拿到数据（context.request.get、page.evaluate 里 fetch）后用它存。
 * name 是相对工作目录的路径，不能跑到外面；同名时文件名后加 (1)、(2)，同内置浏览器的下载。
 * data：Buffer、Uint8Array 等 TypedArray、ArrayBuffer，或字符串（按 UTF-8 写）。vm 里建的对象不是这边的 Uint8Array，按 ArrayBuffer.isView 认
 */
export function fileSaver(cwd: string) {
  // 远程会话的工作目录在远端：经 SFTP 写过去（见 ssh/host-fs.ts）
  const { fs } = fsFor(cwd);
  const p = fs.path;
  return async (name: string, data: unknown): Promise<string> => {
    const target = inWorkdir(cwd, "saveFile", (dir) => `saveFile 只能写进工作目录 ${dir} 下面`, name);
    let bytes: Buffer;
    if (typeof data === "string") bytes = Buffer.from(data, "utf8");
    else if (ArrayBuffer.isView(data)) bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") bytes = Buffer.from(data as ArrayBuffer);
    else throw new Error("saveFile 的数据要是 Buffer、Uint8Array、ArrayBuffer 或字符串");
    await fs.mkdir(p.dirname(target), { recursive: true });
    const ext = p.extname(target);
    const stem = target.slice(0, target.length - ext.length);
    for (let n = 0; ; n++) {
      const file = n ? `${stem} (${n})${ext}` : target;
      try {
        await fs.writeFile(file, bytes, { exclusive: true });
        // 返回给模型：Windows 远端是 C:\… 的写法
        return machinePathOf(cwd, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  };
}

/**
 * 读会话工作目录里的文件（远程会话经 SFTP）：browser_run_code 里的全局函数 readFile(name, encoding?)，
 * 和 browser_run_code 的 file 参数（执行工作目录里的脚本文件，tool.ts）都用它。name 的规则同 saveFile。
 * REPL 里没有 require、fs：采集脚本要读的输入（网址列表、要上传的文件）、存在工作目录里反复用的脚本，都经这里
 */
export function fileReader(cwd: string) {
  const { fs } = fsFor(cwd);
  return async (name: string): Promise<Buffer> => fs.readFile(inWorkdir(cwd, "readFile", (dir) => `readFile 只能读工作目录 ${dir} 下面的文件`, name));
}

/** 说明里 saveFile、readFile 的那一行，内置浏览器（tool.ts 的 browserServer）和外部浏览器共用 */
export const filesFact = (cwd: string) =>
  `文件：全局函数 await saveFile(name, data) 把数据写进这个会话的工作目录（${machinePathOf(cwd, fsFor(cwd).root)}）：name 是相对这个目录的路径，data 是 Buffer、Uint8Array、ArrayBuffer 或字符串（按 UTF-8 写），同名时文件名后加 (1)、(2)，返回写入的绝对路径。` +
  '全局函数 await readFile(name, encoding?) 读这个目录里的文件：name 同上，不传 encoding 时返回 Buffer，传了（如 "utf8"、"base64"）返回按它解码的字符串，文件不存在时抛错。' +
  "browser_run_code 的 file 参数也是相对这个目录的路径。";

function instructions(b: ExternalBrowserInfo, active: ExternalBrowserInfo[], cwd: string, remote?: string): string {
  const others = active.filter((o) => o.id !== b.id);
  return [
    `用户自己的 ${b.name}：经 Playwright 扩展连接，带着用户的登录状态和 Cookie；右侧面板里的内置浏览器是另一组工具（mcp__inapp__）` +
      others.map((o) => `，用户自己的 ${o.name} 是 mcp__${o.id}__`).join("") +
      "。",
    ...(remote ? [`这个会话的工作目录在远程主机「${remote}」上（经 SSH），${b.name} 在用户的电脑上：网址里的 localhost、127.0.0.1 指用户的电脑，不是「${remote}」。`] : []),
    tabGroupEnabled()
      ? `能看到的标签页只有 ${b.name} 里 Playwright 标签页组里的（用户连接时选的，加上通过这里新开的），所有会话共用这一组。`
      : `能看到的标签页只有交给 Playwright 的那些（用户连接时选的那一个，加上通过这里新开的和从它们弹出的），用户的其他标签页看不到，所有会话共用这一批。`,
    `第一次调用时，${b.name} 会打开扩展的连接页，用户选好标签页、点允许之后工具才返回；扩展没装、连接失败时工具返回错误。` +
      "用户设了 token 时不用点允许，交出来的第一个标签页就是连接页本身（chrome-extension://…/connect.html，标题 Welcome），context 里有了别的标签页之后它会自动关闭。" +
      "交出来的标签页全部关闭时连接断开，下一次调用重新连接（重新打开连接页）。",
    RUNTIME_FACTS,
    "标签页：通过这里开的标签页不会自动关闭。标签页被新开、关闭时，下一次工具结果里会列出变化，只能分出是不是你做的（扩展不提供是用户还是网页）。" +
      `这些说明里的网址超过 ${MAX_URL_CHARS} 个字符时只显示开头和总长度，完整的网址是那个标签页的 page.url()。`,
    `下载：网页里的下载（包括脚本触发的）由 ${b.name} 自己处理，按用户在浏览器里的设置保存（默认是系统的「下载」文件夹，设了下载前询问时会弹出另存为对话框），同名时浏览器自己在文件名后加 (1)；` +
      "Playwright 的 download 事件不会触发，page.waitForEvent('download') 一直等到超时，也拿不到文件存在哪。",
    filesFact(cwd),
    `用户消息里的 @${b.name} 指这个浏览器（用户自己的 ${b.name}），@${b.id}[标题](网址) 指这里的一个标签页。`,
  ].join("\n");
}

/**
 * 给模型用的外部浏览器工具，每个会话每个启用着的浏览器一个 MCP 服务器，共用这个浏览器的连接；REPL 按会话保留（replFor）。
 * 和内置浏览器不同，REPL 在网关主线程里：扩展同一时间只认一个客户端，所有会话共用一条连接，没法分到各自的 worker
 */
/** remote：远程会话所在主机的名称 */
export function externalServers(active: ExternalBrowserInfo[], sessionId: string, cwd: string, resumed = false, remote?: string): Record<string, McpSdkServerConfigWithInstance> {
  return Object.fromEntries(
    active.map((b) => [
      b.id,
      browserMcpServer({
        name: b.id,
        instructions: instructions(b, active, cwd, remote),
        readFile: fileReader(cwd),
        repl: replFor(`${b.id}:${sessionId}`, () => new BrowserRepl((signal) => bridgeOf(b).context(signal), undefined, undefined, fileSaver(cwd), undefined, fileReader(cwd)), resumed),
      }),
    ]),
  );
}
