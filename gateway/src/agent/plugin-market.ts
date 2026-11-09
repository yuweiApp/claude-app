import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { agentEnv } from "../config.js";
import { pluginMarketplaces } from "../config-file.js";
import type { MarketPlugin } from "../shared/types.js";
import { clearCapabilitiesCache } from "./capabilities.js";
import { importedPluginNames } from "./extensions.js";

/**
 * 插件市场：交给 SDK 自带的 Claude Code 命令行（claude plugin …）做，CLAUDE_CONFIG_DIR 是网关的配置目录。
 * 市场是一个 git 仓库（.claude-plugin/marketplace.json 列出插件），Claude Code 克隆到 plugins/marketplaces/ 下；
 * 安装时按插件的来源（市场仓库里的目录、别的 git 仓库或其中的子目录）拉到 plugins/cache/ 下，记进 settings.json 的 enabledPlugins，
 * 会话按 settingSources 的 user 加载。克隆要用 git
 */

/** 克隆市场、拉取插件可能比较久 */
const CLI_TIMEOUT_MS = 5 * 60_000;
const LIST_TTL_MS = 10 * 60_000;

export class PluginMarketError extends Error {}

/** SDK 自带的 claude 可执行文件：和 SDK 一样按平台包名找，Linux 先 glibc 再 musl */
function claudeExecutable(): string {
  const require = createRequire(import.meta.url);
  const { platform, arch } = process;
  const base = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const candidates = platform === "linux" ? [base, `${base}-musl`] : [base];
  for (const pkg of candidates) {
    try {
      const file = require.resolve(`${pkg}/claude${platform === "win32" ? ".exe" : ""}`);
      if (existsSync(file)) return file;
    } catch {
      // 没装这个平台包，试下一个
    }
  }
  throw new PluginMarketError(`找不到 Claude Code 可执行文件（${candidates.join("、")}）`);
}

/** 跑 claude plugin …，返回 stdout；退出码非 0 时 reject，带上 stdout、stderr */
function cli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      claudeExecutable(),
      ["plugin", ...args],
      { env: agentEnv(), timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout)),
    );
    // 不是终端，要确认的步骤不会等输入
    child.stdin?.end();
  });
}

interface CliResult {
  outcome?: string;
  message?: string;
}

/** 带 --json 的命令：最后一行是结果。outcome 不是 ok 时报 message */
async function cliJson(args: string[]): Promise<CliResult> {
  const parse = (text: string | undefined): CliResult | null => {
    const last = text?.trim().split("\n").pop();
    try {
      return last ? (JSON.parse(last) as CliResult) : null;
    } catch {
      return null;
    }
  };
  let result: CliResult | null;
  try {
    result = parse(await cli([...args, "--json"]));
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) throw new PluginMarketError("Claude Code 超过 5 分钟没有完成");
    result = parse(e.stdout);
    if (!result) throw new PluginMarketError(e.stderr?.trim() || e.message);
  }
  if (!result) throw new PluginMarketError("Claude Code 没有返回结果");
  if (result.outcome !== "ok") throw new PluginMarketError(result.message ?? `失败（${result.outcome}）`);
  return result;
}

interface Marketplace {
  name: string;
  source: string;
  url?: string;
  repo?: string;
  installLocation?: string;
}

const sameRepo = (a: string, b: string) => {
  const normalize = (url: string) => url.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  return normalize(a) === normalize(b);
};

/** 配置里的市场没加过的先加（git 克隆）；返回配置里这些市场 */
async function marketplaces(): Promise<Marketplace[]> {
  const list = async () => JSON.parse(await cli(["marketplace", "list", "--json"])) as Marketplace[];
  let known = await list();
  const find = (source: string) => known.find((m) => (m.url && sameRepo(m.url, source)) || (m.repo && sameRepo(`https://github.com/${m.repo}`, source)));
  const missing = pluginMarketplaces.filter((source) => !find(source));
  if (missing.length) {
    for (const source of missing) await cliJson(["marketplace", "add", source]);
    known = await list();
  }
  return pluginMarketplaces.flatMap((source) => find(source) ?? []);
}

/** marketplace.json 里命令行列表没给的字段：分类、作者、主页 */
interface ManifestEntry {
  name: string;
  displayName?: string;
  category?: string;
  author?: { name?: string } | string;
  homepage?: string;
}

function manifestEntries(location: string | undefined): Map<string, ManifestEntry> {
  if (!location) return new Map();
  try {
    const manifest = JSON.parse(readFileSync(path.join(location, ".claude-plugin", "marketplace.json"), "utf8")) as { plugins?: ManifestEntry[] };
    return new Map((manifest.plugins ?? []).map((p) => [p.name, p]));
  } catch {
    return new Map();
  }
}

interface Available {
  pluginId: string;
  name: string;
  description?: string;
  marketplaceName: string;
  version?: string;
  installCount?: number;
}

let cache: { at: number; value: Promise<MarketPlugin[]> } | null = null;

async function load(refresh: boolean): Promise<MarketPlugin[]> {
  const markets = await marketplaces();
  if (refresh) for (const m of markets) await cliJson(["marketplace", "update", m.name]).catch(() => undefined);
  const { available, installed } = JSON.parse(await cli(["list", "--available", "--json"])) as { available: Available[]; installed: { id: string }[] };
  const installedIds = new Set(installed.map((p) => p.id));
  const extra = new Map(markets.map((m) => [m.name, manifestEntries(m.installLocation)]));
  return available
    .filter((p) => extra.has(p.marketplaceName))
    .map((p): MarketPlugin => {
      const more = extra.get(p.marketplaceName)?.get(p.name);
      const author = typeof more?.author === "string" ? more.author : more?.author?.name;
      return {
        id: p.pluginId,
        name: p.name,
        ...(more?.displayName ? { title: more.displayName } : {}),
        description: p.description ?? "",
        marketplace: p.marketplaceName,
        ...(more?.category ? { category: more.category } : {}),
        ...(author ? { author } : {}),
        ...(more?.homepage ? { homepage: more.homepage } : {}),
        ...(p.version ? { version: p.version } : {}),
        ...(p.installCount !== undefined ? { installCount: p.installCount } : {}),
        installed: installedIds.has(p.pluginId),
      };
    })
    .sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0) || a.name.localeCompare(b.name));
}

/** 市场里的插件，按安装次数排序；缓存 10 分钟，refresh 时先更新市场（git 拉取） */
export function listMarketPlugins(refresh = false): Promise<MarketPlugin[]> {
  if (!refresh && cache && Date.now() - cache.at < LIST_TTL_MS) return cache.value;
  const value = load(refresh);
  cache = { at: Date.now(), value };
  value.catch(() => cache?.value === value && (cache = null));
  return value;
}

/** 装上、卸载、更新之后，列表和能力列表都要重新读 */
function changed(): void {
  cache = null;
  clearCapabilitiesCache();
}

const VALID_ID = /^[\w.-]+@[\w.-]+$/;

function checkId(id: string): void {
  if (!VALID_ID.test(id)) throw new PluginMarketError(`插件不合法：${id}`);
}

/** 安装（插件名@市场名）。导入了同名插件的不装，两个同名插件的技能、MCP 服务器名称会冲突 */
export async function installMarketPlugin(id: string): Promise<void> {
  checkId(id);
  const name = id.split("@")[0]!;
  if (importedPluginNames().includes(name)) throw new PluginMarketError(`已经导入了同名插件「${name}」，请先删除`);
  try {
    await cliJson(["install", id]);
  } finally {
    changed();
  }
}

export async function uninstallMarketPlugin(id: string): Promise<void> {
  checkId(id);
  try {
    await cliJson(["uninstall", id]);
  } finally {
    changed();
  }
}

/** 更新到市场里的最新版本，返回 Claude Code 的说明（已经是最新、从哪个版本更新到哪个版本） */
export async function updateMarketPlugin(id: string): Promise<string> {
  checkId(id);
  try {
    return (await cliJson(["update", id])).message ?? "已更新";
  } finally {
    changed();
  }
}
