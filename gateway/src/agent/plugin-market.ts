import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { agentEnv, config } from "../config.js";
import { pluginMarketplaces } from "../config-file.js";
import type { MarketPlugin, MarketPluginPage } from "../shared/types.js";
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

/** 配置里写的是地址（git 仓库）还是 Claude Code 内置市场的名称 */
const isUrl = (source: string) => source.includes("://");

/**
 * Claude Code 内置的插件目录：不在 marketplace list 里，不用 add，列表、安装、更新照常用名称。
 * 不用登录（没有任何凭据时也能列出、安装），数据由 Claude Code 从网上取，缓存在配置目录的 plugins/ 下
 */
const BUILTIN_DIRECTORY = "anthropic-plugin-directory";

/** 配置里的 git 市场没加过的先加（git 克隆）；返回配置里这些市场，顺序同配置 */
async function marketplaces(): Promise<Marketplace[]> {
  const list = async () => JSON.parse(await cli(["marketplace", "list", "--json"])) as Marketplace[];
  let known = await list();
  const find = (source: string) =>
    isUrl(source)
      ? known.find((m) => (m.url && sameRepo(m.url, source)) || (m.repo && sameRepo(`https://github.com/${m.repo}`, source)))
      : (known.find((m) => m.name === source) ?? { name: source, source: "builtin" });
  const missing = pluginMarketplaces.filter((source) => isUrl(source) && !find(source));
  if (missing.length) {
    for (const source of missing) await cliJson(["marketplace", "add", source]);
    known = await list();
  }
  return pluginMarketplaces.flatMap((source) => find(source) ?? []);
}

/** 命令行列表没给的字段：分类、作者、主页、审核情况等 */
interface ManifestEntry {
  name: string;
  displayName?: string;
  category?: string;
  author?: { name?: string } | string;
  homepage?: string;
  review?: "anthropic" | "partner";
}

/** git 市场：仓库里的 .claude-plugin/marketplace.json */
function manifestEntries(location: string | undefined): Map<string, ManifestEntry> {
  if (!location) return new Map();
  try {
    const manifest = JSON.parse(readFileSync(path.join(location, ".claude-plugin", "marketplace.json"), "utf8")) as { plugins?: ManifestEntry[] };
    return new Map((manifest.plugins ?? []).map((p) => [p.name, p]));
  } catch {
    return new Map();
  }
}

/** 内置目录在 plugins/plugin-directory-cache-v2.json 里的一项（只取用得到的字段） */
interface DirectoryListing {
  id: string;
  name?: string;
  publisher?: { name?: string };
  links?: { documentation?: string };
  checks?: { review?: { state?: string; by?: { type?: string } | null } };
}

/**
 * 内置目录：命令行列表里只有插件名和简介，显示名称、发布者、文档链接、审核情况从 Claude Code 的缓存文件里补；
 * 这是 Claude Code 内部的文件，格式变了或读不到就只显示命令行给的
 */
function directoryEntries(): Map<string, ManifestEntry> {
  try {
    const cache = JSON.parse(readFileSync(path.join(config.claudeConfigDir, "plugins", "plugin-directory-cache-v2.json"), "utf8")) as {
      listings?: DirectoryListing[];
      entryNames?: Record<string, string>;
    };
    const names = cache.entryNames ?? {};
    const entries = new Map<string, ManifestEntry>();
    for (const listing of cache.listings ?? []) {
      const name = names[listing.id];
      if (!name) continue;
      const review = listing.checks?.review;
      const by = review?.state === "done" ? review.by?.type : undefined;
      entries.set(name, {
        name,
        ...(listing.name && listing.name !== name ? { displayName: listing.name } : {}),
        ...(listing.publisher?.name ? { author: listing.publisher.name } : {}),
        ...(listing.links?.documentation ? { homepage: listing.links.documentation } : {}),
        ...(by === "anthropic" || by === "partner" ? { review: by } : {}),
      });
    }
    return entries;
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
  source?: { source?: string; url?: string; repo?: string };
}

/** 插件代码所在的仓库：git 地址去掉 .git，GitHub 简写补成网址 */
function repositoryOf(source: Available["source"]): string | undefined {
  if (source?.url && /^https?:\/\//.test(source.url)) return source.url.replace(/\.git$/, "");
  if (source?.repo) return `https://github.com/${source.repo}`;
  return undefined;
}

/** 完整列表的缓存：data 是最近一次取到的（at 是取到的时间），pending 是正在取的 */
let cache: { at: number; data?: MarketPlugin[]; pending?: Promise<MarketPlugin[]> } = { at: 0 };

async function load(refresh: boolean): Promise<MarketPlugin[]> {
  const markets = await marketplaces();
  if (refresh) for (const m of markets) await cliJson(["marketplace", "update", m.name]).catch(() => undefined);
  const { available, installed } = JSON.parse(await cli(["list", "--available", "--json"])) as { available: Available[]; installed: { id: string }[] };
  const installedIds = new Set(installed.map((p) => p.id));
  // 内置目录的缓存文件在上面的 list 之后读，第一次时它刚取下来
  const extra = new Map(markets.map((m) => [m.name, m.source === "builtin" ? directoryEntries() : manifestEntries(m.installLocation)]));
  const order = markets.map((m) => m.name);
  const plugins = available
    .filter((p) => extra.has(p.marketplaceName))
    .map((p, index) => {
      const more = extra.get(p.marketplaceName)?.get(p.name);
      const author = typeof more?.author === "string" ? more.author : more?.author?.name;
      const repository = repositoryOf(p.source);
      const plugin: MarketPlugin = {
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
        ...(more?.review ? { review: more.review } : {}),
        ...(repository ? { repository } : {}),
        installed: installedIds.has(p.pluginId),
      };
      return { plugin, index };
    });
  // 同名插件（官方市场的大多也在内置目录里）只留一个：已经装了的那个，都没装用配置里排在前面的市场的。两个同名插件不能同时装（技能、MCP 服务器名称冲突）
  const rank = ({ plugin }: (typeof plugins)[number]) => (plugin.installed ? -1 : order.indexOf(plugin.marketplace));
  const byName = new Map<string, (typeof plugins)[number]>();
  for (const entry of plugins) {
    const kept = byName.get(entry.plugin.name);
    if (!kept || rank(entry) < rank(kept)) byName.set(entry.plugin.name, entry);
  }
  // 按配置里市场的顺序；同一个市场里有安装次数的按次数，没有的（内置目录）保持 Claude Code 给的顺序
  return [...byName.values()]
    .sort(
      (a, b) =>
        order.indexOf(a.plugin.marketplace) - order.indexOf(b.plugin.marketplace) ||
        (b.plugin.installCount ?? 0) - (a.plugin.installCount ?? 0) ||
        a.index - b.index,
    )
    .map(({ plugin }) => plugin);
}

/** 重新取完整列表：已经在取（又不是要先更新市场）就等那一次；取的过程中缓存被作废了（装、卸了插件），结果不要 */
function reload(refresh: boolean): Promise<MarketPlugin[]> {
  if (cache.pending && !refresh) return cache.pending;
  const pending: Promise<MarketPlugin[]> = load(refresh).then(
    (data) => {
      if (cache.pending === pending) cache = { at: Date.now(), data };
      return data;
    },
    (err: unknown) => {
      if (cache.pending === pending) cache = { ...cache, pending: undefined };
      throw err;
    },
  );
  cache = { ...cache, pending };
  return pending;
}

/**
 * 市场里的插件（同名的只留一个），按市场、安装次数排序。Claude Code 一次给出全部，取一次要几秒，所以缓存起来：
 * refresh 时先更新市场再取；还没取到过时等着取；超过 10 分钟的先用旧的返回，后台重新取
 */
function listMarketPlugins(refresh: boolean): Promise<MarketPlugin[]> {
  if (refresh || !cache.data) return reload(refresh);
  if (Date.now() - cache.at >= LIST_TTL_MS) reload(false).catch(() => undefined);
  return Promise.resolve(cache.data);
}

export interface MarketQuery {
  refresh?: boolean;
  /** 搜索词：名称、显示名称、简介、分类、作者里包含（不分大小写） */
  search?: string;
  /** 来源市场名称，空是全部 */
  marketplace?: string;
  category?: string;
  offset?: number;
  limit?: number;
}

const MAX_PAGE = 100;

/** 一页插件：完整列表在网关里缓存，按条件筛过再取 offset 起的 limit 条，带总数和筛选的选项 */
export async function queryMarketPlugins(query: MarketQuery): Promise<MarketPluginPage> {
  const all = await listMarketPlugins(query.refresh === true);
  const inMarket = query.marketplace ? all.filter((p) => p.marketplace === query.marketplace) : all;
  const keyword = query.search?.trim().toLowerCase() ?? "";
  const matched = inMarket.filter(
    (p) =>
      (!query.category || p.category === query.category) &&
      (!keyword || [p.name, p.title, p.description, p.category, p.author].join(" ").toLowerCase().includes(keyword)),
  );
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(query.limit ?? 20)));
  return {
    plugins: matched.slice(offset, offset + limit),
    total: matched.length,
    marketplaces: [...new Set(all.map((p) => p.marketplace))],
    categories: [...new Set(inMarket.flatMap((p) => p.category ?? []))].sort(),
  };
}

/**
 * 装上、卸载、更新之后，能力列表要重新读；插件列表先在缓存里改好这一个的安装状态，下次查询时后台重新取，
 * 正在取的那一次是改之前开始的，结果不要
 */
function changed(id: string, installed?: boolean): void {
  if (cache.data && installed !== undefined) cache.data = cache.data.map((p) => (p.id === id ? { ...p, installed } : p));
  cache = { at: 0, ...(cache.data ? { data: cache.data } : {}) };
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
  let done = false;
  try {
    await cliJson(["install", id]);
    done = true;
  } finally {
    // 失败时不知道装到了哪一步，状态等重新取
    changed(id, done ? true : undefined);
  }
}

export async function uninstallMarketPlugin(id: string): Promise<void> {
  checkId(id);
  let done = false;
  try {
    await cliJson(["uninstall", id]);
    done = true;
  } finally {
    // 失败时不知道装到了哪一步，状态等重新取
    changed(id, done ? false : undefined);
  }
}

/** 更新到市场里的最新版本，返回 Claude Code 的说明（已经是最新、从哪个版本更新到哪个版本） */
export async function updateMarketPlugin(id: string): Promise<string> {
  checkId(id);
  try {
    return (await cliJson(["update", id])).message ?? "已更新";
  } finally {
    changed(id);
  }
}
