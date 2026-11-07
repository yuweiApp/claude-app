import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { BrowserRepl } from "../browser/repl.js";
import { browserMcpServer, READ_TOOL_NAMES, replFor, RUNTIME_FACTS } from "../browser/tool.js";
import { stateDir } from "./cli.js";

/**
 * CDP 接管（config.yml 的 desktop.cdp）：agent-desktop 的 launch --cdp 以本机调试端口重新启动一个 Chromium / Electron 应用，
 * 网关用 Playwright 的 connectOverCDP 连上去，模型用 mcp__cdp__ 的工具（同浏览器那一套：browser_run_code 等）操作它的网页内容。
 * 走 CDP 不经系统的无障碍接口：窗口被挡住、元素没名字都不影响，不动鼠标、不抢前台（Windows 上 Chromium 窗口被挡住时，
 * 无障碍树停在第一次读到的一小部分，实测紫鸟因此读不出来，见 docs/agent-desktop.md）。
 * 端口开着时本机任何程序都能控制这个应用，所以默认关
 */
export const CDP_SERVER = "cdp";
export const CDP_READ_TOOLS = READ_TOOL_NAMES.map((name) => `mcp__${CDP_SERVER}__${name}`);

/** launch --cdp 的结果里的 data.cdp */
interface CdpInfo {
  port?: number;
  http_endpoint?: string;
  websocket_url?: string;
  product?: string;
}

interface CdpApp {
  app: string;
  pid?: number;
  port?: number;
  websocketUrl: string;
  product?: string;
  launchedAt: number;
}

/**
 * 用 --cdp 启动过的应用，所有会话共用（应用和端口是这台电脑上的，不属于哪个会话）。
 * 存在状态目录的 cdp-apps.json：网关重启后应用和端口还在，接着连；连不上（应用退出了）就删掉
 */
const apps = new Map<string, CdpApp>();
const browsers = new Map<string, Promise<Browser>>();
/** 每个会话最近一次用 --cdp 启动的应用（mcp__cdp__ 的工具连它）；没有时用最近启动的那个 */
const current = new Map<string, string>();

const key = (app: string) => app.toLowerCase();
const file = () => path.join(stateDir(), "cdp-apps.json");

function load(): void {
  try {
    for (const entry of JSON.parse(readFileSync(file(), "utf8")) as CdpApp[]) apps.set(key(entry.app), entry);
  } catch {
    // 没有文件
  }
}

function save(): void {
  try {
    writeFileSync(file(), JSON.stringify([...apps.values()], null, 2), { mode: 0o600 });
  } catch {
    // 状态目录写不了时只留在内存里
  }
}

let loaded = false;
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  load();
}

/** run 的 launch --cdp 成功了：记下应用和调试地址，返回给模型的说明 */
export function registerCdpLaunch(session: string, data: unknown): string | null {
  ensureLoaded();
  const d = data as { app?: string; pid?: number; cdp?: CdpInfo } | undefined;
  const cdp = d?.cdp;
  const url = cdp?.websocket_url;
  if (!d?.app || !url) return null;
  const k = key(d.app);
  // 同名的应用重新启动过：旧连接作废
  const old = browsers.get(k);
  browsers.delete(k);
  void old?.then((b) => b.close()).catch(() => undefined);
  apps.set(k, { app: d.app, pid: d.pid, port: cdp.port, websocketUrl: url, product: cdp.product, launchedAt: Date.now() });
  current.set(session, k);
  save();
  return `（${d.app} 的网页内容现在可以用 mcp__cdp__ 的工具操作：调试端口 ${cdp.port ?? "?"}${cdp.product ? `，${cdp.product}` : ""}）`;
}

/** 这个会话的工具连哪个应用：它最近用 --cdp 启动的，没有就用所有会话里最近启动的那个 */
function target(session: string): CdpApp | undefined {
  ensureLoaded();
  const mine = current.get(session);
  if (mine && apps.has(mine)) return apps.get(mine);
  return [...apps.values()].sort((a, b) => b.launchedAt - a.launchedAt)[0];
}

async function contextFor(session: string): Promise<BrowserContext> {
  const app = target(session);
  if (!app) throw new Error("还没有用 --cdp 启动过的应用：mcp__desktop__run 的 launch 带上 --cdp 启动之后才能用这组工具");
  const k = key(app.app);
  let connecting = browsers.get(k);
  if (!connecting) {
    connecting = chromium.connectOverCDP(app.websocketUrl, { timeout: 15_000 }).then((browser) => {
      browser.once("disconnected", () => {
        if (browsers.get(k) === connecting) browsers.delete(k);
      });
      return browser;
    });
    browsers.set(k, connecting);
  }
  let browser: Browser;
  try {
    browser = await connecting;
  } catch (err) {
    browsers.delete(k);
    // 连不上多半是应用退出了，端口没了：删掉记录
    apps.delete(k);
    save();
    throw new Error(`连不上 ${app.app} 的调试端口 ${app.port ?? ""}（应用可能已经退出，要重新用 --cdp 启动）：${(err as Error).message}`);
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error(`${app.app} 没有可用的浏览器上下文`);
  return context;
}

const INSTRUCTIONS = [
  "CDP 接管的应用：用 mcp__desktop__run 的 launch 带 --cdp 启动的 Chromium / Electron 应用（agent-desktop 以本机调试端口重新启动它），这组工具经调试端口用 Playwright 操作它的网页内容（应用里的每个网页视图是一个标签页）。",
  "连的是这个会话最近一次用 --cdp 启动的应用；这个会话没启动过时，连所有会话里最近启动的那个。网关重启后调试地址还在，应用退出后连不上。",
  "经调试端口操作不经过系统的无障碍接口：不移动鼠标、不切换前台窗口，窗口被挡住时照样能读能操作。应用的原生菜单、文件对话框、窗口管理不在网页里，这组工具碰不到。",
  RUNTIME_FACTS,
  "标签页：通过这里新开的标签页不会自动关闭。标签页被新开、关闭时，下一次工具结果里会列出变化，只能分出是不是你做的。",
].join("\n");

/** 给模型用的 CDP 接管工具，每个会话一个 MCP 服务器；REPL 按会话保留（replFor），在网关主线程里（同外部 Chrome） */
export function cdpServer(sessionId: string, resumed = false): McpSdkServerConfigWithInstance {
  return browserMcpServer({
    name: CDP_SERVER,
    instructions: INSTRUCTIONS,
    repl: replFor(`${CDP_SERVER}:${sessionId}`, () => new BrowserRepl(() => contextFor(sessionId)), resumed),
  });
}

/** 删会话：忘掉它最近启动的是哪个（应用和连接留着，别的会话可能在用） */
export function disposeCdpSession(sessionId: string): void {
  current.delete(sessionId);
}
