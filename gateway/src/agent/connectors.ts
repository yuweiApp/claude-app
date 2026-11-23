import { connectorDirectory, connectorRegistry, featuredConnectors } from "../config-file.js";
import type { ConnectorEntry, ConnectorField, ConnectorInput, ConnectorPage, ConnectorSource } from "../shared/types.js";
import { readMcpServers, saveMcpServer } from "./mcp-config.js";
import { BadRequestError } from "../errors.js";

/**
 * 连接器市场，两个来源，都只列有远程地址的服务器：
 * - Claude 目录（claude.ai 上的连接器目录，api.anthropic.com/api/directory/servers，Claude Code 查目录也用它，不用登录）：
 *   一千多个，网关一次取完缓存 1 小时，搜索、分类、分页在网关里做。
 * - MCP 官方注册表（registry.modelcontextprotocol.io，API 见 /docs）：不搜索时列 config.yml 里推荐的（注册表很大，也有不少批量发布的杂项），
 *   搜索时查整个注册表，按注册表的游标一页页取。
 * 添加就是存成设置页的 MCP 服务器，之后的连接、OAuth 登录和手动添加的一样
 */

/** 注册表 server.json 里用到的字段（schema 2025-09-29 / 2025-12-11） */
interface RegistryField {
  name?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  value?: string;
  choices?: string[];
}

interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version: string;
  websiteUrl?: string;
  repository?: { url?: string };
  icons?: { src: string }[];
  remotes?: { type: string; url: string; headers?: RegistryField[]; variables?: Record<string, RegistryField> }[];
}

interface RegistryItem {
  server: RegistryServer;
  _meta?: Record<string, { status?: string } | undefined>;
}

const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
/** 推荐的和按名称取的缓存 1 小时，搜索结果 5 分钟 */
const ENTRY_TTL_MS = 60 * 60_000;
const SEARCH_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  // 失败的不留着，下次重新请求
  value.catch(() => cache.get(key)?.value === value && cache.delete(key));
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

/** 请求注册表或 Claude 目录（label 用在错误信息里）；404 返回 null */
async function getJson<T>(url: string, label: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const e = err as Error;
    throw new BadRequestError(`连接器市场加载失败：${e.name === "TimeoutError" ? `${label}超过 15 秒没有响应` : ((e.cause as Error | undefined)?.message ?? e.message)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new BadRequestError(`连接器市场加载失败：${label}返回 ${res.status}`);
  return (await res.json()) as T;
}

const registry = <T>(path: string) => getJson<T>(connectorRegistry + path, "注册表");

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/\b(mcp|server)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * 添加时默认的名称：反向域名的主体（com.figma.mcp → figma、app.linear → linear）；
 * io.github.用户名 的用标题（GitHub、Sentry、Context7），没有标题用斜杠后面的部分
 */
function suggestName(server: RegistryServer): string {
  const [namespace = "", rest = ""] = server.name.split("/");
  const labels = namespace.split(".");
  const name = labels[0] === "io" && labels[1] === "github" ? slug(server.title ?? "") || slug(rest) : slug(labels[1] ?? "") || slug(rest);
  return (name || "connector").slice(0, 40);
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * 没写 title 的（不少）：用斜杠后面那段（ai.smithery/smithery-ai-slack → Smithery Ai Slack）；
 * 那段只是 mcp、server 之类的（com.notion/mcp）用名称的主体（Notion）
 */
function fallbackTitle(registryName: string, suggested: string): string {
  const rest = slug(registryName.split("/")[1] ?? "");
  return rest && rest !== suggested ? rest.split("-").map(capitalize).join(" ") : capitalize(suggested);
}

const field = (name: string, f: RegistryField): ConnectorField => ({
  name,
  ...(f.description ? { description: f.description } : {}),
  required: f.isRequired === true,
  secret: f.isSecret === true,
  ...((f.value ?? f.default) ? { default: f.value ?? f.default } : {}),
  ...(f.choices?.length ? { choices: f.choices } : {}),
});

/** 没有远程地址的（只能本机运行的包）、已经删除的不算连接器 */
function toEntry(item: RegistryItem): ConnectorEntry | null {
  const { server } = item;
  const status = item._meta?.["io.modelcontextprotocol.registry/official"]?.status;
  if (status === "deleted") return null;
  const remote = server.remotes?.find((r) => r.type === "streamable-http") ?? server.remotes?.find((r) => r.type === "sse");
  if (!remote || !/^https?:\/\//.test(remote.url)) return null;
  const icon = server.icons?.find((i) => /^https:\/\//.test(i.src))?.src;
  const name = suggestName(server);
  return {
    id: server.name,
    source: "registry",
    title: server.title || fallbackTitle(server.name, name),
    description: server.description ?? "",
    version: server.version,
    type: remote.type === "sse" ? "sse" : "http",
    url: remote.url,
    variables: Object.entries(remote.variables ?? {}).map(([name, f]) => field(name, f)),
    headers: (remote.headers ?? []).filter((h) => h.name).map((h) => field(h.name!, h)),
    ...(icon ? { icon } : {}),
    ...(server.websiteUrl ? { website: server.websiteUrl } : {}),
    ...(server.repository?.url ? { repository: server.repository.url } : {}),
    suggestedName: name,
  };
}

/** 按注册表里的名称取最新版本 */
function connectorById(id: string): Promise<ConnectorEntry | null> {
  return cached(`id:${id}`, ENTRY_TTL_MS, async () => {
    const item = await registry<RegistryItem>(`/v0/servers/${encodeURIComponent(id)}/versions/latest`);
    return item && toEntry(item);
  });
}

/** 标上已经添加成了哪个 MCP 服务器 */
function markAdded(entries: ConnectorEntry[]): ConnectorEntry[] {
  const added = new Map(
    Object.entries(readMcpServers())
      .filter(([, s]) => s.connector)
      .map(([name, s]) => [s.connector!.id, name]),
  );
  return entries.map((entry) => (added.has(entry.id) ? { ...entry, added: added.get(entry.id) } : { ...entry, added: undefined }));
}

export interface ConnectorQuery {
  /** 没有是 MCP 注册表 */
  source?: ConnectorSource;
  search?: string;
  /** MCP 注册表的下一页 */
  cursor?: string;
  /** Claude 目录：分类、从第几个开始、取几个 */
  category?: string;
  offset?: number;
  limit?: number;
}

/** 连接器市场的一页 */
export function listConnectors(query: ConnectorQuery): Promise<ConnectorPage> {
  return query.source === "directory" ? listDirectory(query) : listRegistry(query.search, query.cursor);
}

/** MCP 注册表：不传 search 列推荐的；传了查整个注册表，一次一页，nextCursor 取下一页 */
async function listRegistry(search?: string, cursor?: string): Promise<ConnectorPage> {
  const keyword = search?.trim();
  if (!keyword) {
    // 推荐的一个个按名称取；取不到的（注册表里删了、改名了）跳过，全部失败才报错
    const results = await Promise.allSettled(featuredConnectors.map(connectorById));
    const entries = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (entries.length === 0 && failure) throw failure.reason;
    return { connectors: markAdded(entries) };
  }
  const params = new URLSearchParams({ search: keyword, version: "latest", limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
  const page = await cached(`search:${params}`, SEARCH_TTL_MS, () =>
    registry<{ servers: RegistryItem[]; metadata?: { nextCursor?: string } }>(`/v0/servers?${params}`),
  );
  // 注册表按名称排序，官方的不一定在前面：推荐的、名称主体就是搜索词的（com.notion 对 notion）排到前面
  const rank = (entry: ConnectorEntry) => (featuredConnectors.includes(entry.id) ? 0 : entry.suggestedName === keyword.toLowerCase() ? 1 : 2);
  const entries = (page?.servers ?? []).flatMap((item) => toEntry(item) ?? []).sort((a, b) => rank(a) - rank(b));
  const nextCursor = page?.metadata?.nextCursor;
  return { connectors: markAdded(entries), ...(nextCursor ? { nextCursor } : {}) };
}

/** 添加连接器：填好地址里的变量和请求头（Claude 目录的是选的或填的地址），存成 MCP 服务器。名称被别的服务器占了时加 -2、-3。返回服务器名称 */
export async function addConnector(input: ConnectorInput): Promise<string> {
  if (input.source === "directory") return addDirectoryConnector(input);
  const entry = await connectorById(input.id);
  if (!entry) throw new BadRequestError(`注册表里没有「${input.id}」`);

  const url = entry.url.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const variable = entry.variables.find((v) => v.name === name);
    const value = input.variables?.[name]?.trim() || variable?.default;
    if (!value) throw new BadRequestError(`请填写地址里的「${name}」`);
    return encodeURIComponent(value).replace(/%2F/gi, "/");
  });
  const headers: Record<string, string> = {};
  for (const header of entry.headers) {
    // 可选的请求头没填就不带，默认值由服务器自己定（如 Neon 的 x-read-only）
    const value = input.headers?.[header.name]?.trim() || (header.required ? header.default : undefined);
    if (value) headers[header.name] = value;
    else if (header.required) throw new BadRequestError(`请填写请求头「${header.name}」`);
  }

  const name = serverName(input.name, entry);
  saveMcpServer(
    { name, type: entry.type, url, ...(Object.keys(headers).length ? { headers } : {}) },
    { id: entry.id, title: entry.title, ...(entry.icon ? { icon: entry.icon } : {}) },
  );
  return name;
}

/** 存成的服务器名称：不填用建议的。同一个连接器再添加一次是覆盖（改了请求头之类的），别的服务器占着这个名字就加 -2、-3 */
function serverName(requested: string | undefined, entry: ConnectorEntry): string {
  const wanted = requested?.trim();
  if (wanted && !/^[\w-]+$/.test(wanted)) throw new BadRequestError("名称只能用字母、数字、下划线和连字符");
  const servers = readMcpServers();
  const base = wanted || entry.suggestedName;
  let name = base;
  for (let i = 2; servers[name] && servers[name]?.connector?.id !== entry.id; i++) name = `${base}-${i}`;
  return name;
}

// ---- Claude 目录 ----

/** 目录接口里用到的字段（GET /api/directory/servers?limit=&cursor=，返回 { servers, total, next_cursor }） */
interface DirectoryServer {
  id: string;
  /** remote 是远程连接器；local 是桌面版的扩展（.dxt），要在本机装，不列 */
  type: string;
  name: string;
  display_name?: string;
  one_liner?: string;
  description?: string;
  icon_url?: string;
  /** 一部分是图片地址，其余是 claude.ai 自己的图标名（canva、notion），用不上 */
  logo?: string;
  author?: { name?: string };
  tool_names?: string[];
  categories?: string[];
  /** claude、claude-api、claude-code、claude-desktop */
  works_with?: string[];
  documentation?: string | null;
  /** 目录的默认排序（越小越靠前） */
  rank?: number;
  directory_url?: string;
  verified_tier?: string;
  slug?: string;
  /** 目录给 Claude Code 用户的添加命令，带 --client-id 的要用服务商预先注册的 OAuth 客户端 */
  claude_code_copy_text?: string;
  remote?: {
    url?: string | null;
    url_regex?: string | null;
    transport?: string;
    auth_posture?: string;
    url_options?: { url: string; label: string; description?: string }[];
    /** url：地址要自己填；custom_oauth_client_id / secret：要在服务商那里自己注册 OAuth 客户端 */
    required_fields?: { field: string }[];
  };
}

const DIRECTORY_PAGE = 500;
const isHttps = (url: string | null | undefined): url is string => typeof url === "string" && /^https:\/\//.test(url);

/** 加不了的：要自己注册 OAuth 客户端（客户端 ID、密钥），或者要用服务商给 Claude Code 预先注册的客户端（固定的客户端 ID 和回调端口） */
function unsupportedReason(server: DirectoryServer): string | undefined {
  const fields = new Set(server.remote?.required_fields?.map((f) => f.field));
  if (fields.has("custom_oauth_client_id"))
    return `要先在服务商那里注册 OAuth 客户端，添加时填客户端 ID${fields.has("custom_oauth_client_secret") ? "和密钥" : ""}，暂不支持`;
  if (/--client-id\b/.test(server.claude_code_copy_text ?? "")) return "要用服务商给 Claude Code 预先注册的 OAuth 客户端（固定的客户端 ID 和回调端口），暂不支持";
  return undefined;
}

const isImage = (url: string) => /\.(png|svg|jpe?g|webp|gif|ico|avif)$/i.test(new URL(url).pathname) || /favicon/i.test(url);

/**
 * 卡片上的图标：logo 是图片地址的优先，其次 icon_url。icon_url 有三百多个不是图片，是服务商的网站（https://slack.com/、
 * https://mcp.linear.app/mcp），当图片加载会拿到网页（401、被跨域拦截），换成那个网站的图标（目录里 Google 的几个本来就是这样写的）；
 * 网站没有图标时图标服务返回 404，网页退回首字母
 */
function directoryIcon(server: DirectoryServer): string | undefined {
  try {
    if (isHttps(server.logo) && isImage(server.logo)) return server.logo;
    if (!isHttps(server.icon_url)) return undefined;
    if (isImage(server.icon_url)) return server.icon_url;
    const params = new URLSearchParams({ client: "SOCIAL", type: "FAVICON", fallback_opts: "TYPE,SIZE,URL", url: new URL(server.icon_url).origin, size: "64" });
    return `https://t0.gstatic.com/faviconV2?${params}`;
  } catch {
    return undefined;
  }
}

/** 只要远程的、有地址（固定的、几个里选一个的、自己填的）的 */
function directoryEntry(server: DirectoryServer): ConnectorEntry | null {
  const remote = server.remote;
  if (server.type !== "remote" || !remote) return null;
  const url = isHttps(remote.url) ? remote.url : "";
  const urlOptions = (remote.url_options ?? []).filter((o) => isHttps(o.url));
  const urlPattern = !urlOptions.length && remote.url_regex ? remote.url_regex : undefined;
  if (!url && !urlOptions.length && !urlPattern) return null;
  const title = server.display_name || server.name;
  const tier = server.verified_tier;
  const unsupported = unsupportedReason(server);
  const icon = directoryIcon(server);
  return {
    id: server.id,
    source: "directory",
    title,
    description: server.description || server.one_liner || "",
    version: "",
    type: remote.transport === "sse" ? "sse" : "http",
    url: urlOptions.length ? "" : url,
    variables: [],
    headers: [],
    ...(icon ? { icon } : {}),
    ...(isHttps(server.documentation) ? { website: server.documentation } : {}),
    suggestedName: (slug(title) || slug(server.slug ?? "") || "connector").slice(0, 40),
    ...(urlOptions.length ? { urlOptions: urlOptions.map((o) => ({ url: o.url, label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}),
    ...(urlPattern ? { urlPattern } : {}),
    ...(server.author?.name ? { author: server.author.name } : {}),
    ...(tier === "anthropic" || tier === "partner" ? { review: tier } : {}),
    categories: server.categories ?? [],
    toolCount: server.tool_names?.length ?? 0,
    claudeCode: server.works_with?.includes("claude-code") ?? false,
    authless: remote.auth_posture === "no_auth",
    ...(isHttps(server.directory_url) ? { directoryUrl: server.directory_url } : {}),
    ...(unsupported ? { unsupported } : {}),
  };
}

/** 整个目录（按目录的默认排序）和分类（按个数从多到少），缓存 1 小时 */
function loadDirectory(): Promise<{ entries: ConnectorEntry[]; categories: string[] }> {
  return cached("directory", ENTRY_TTL_MS, async () => {
    const servers: DirectoryServer[] = [];
    let cursor: string | undefined;
    // 目录一千多个，一页 500；最多取 20 页，防止游标出问题时一直取
    for (let i = 0; i < 20; i++) {
      const params = new URLSearchParams({ limit: String(DIRECTORY_PAGE), ...(cursor ? { cursor } : {}) });
      const page = await getJson<{ servers?: DirectoryServer[]; next_cursor?: string | null }>(`${connectorDirectory}?${params}`, "Claude 目录");
      servers.push(...(page?.servers ?? []));
      cursor = page?.next_cursor ?? undefined;
      if (!cursor || !page?.servers?.length) break;
    }
    const rank = new Map(servers.map((s) => [s.id, s.rank ?? Number.MAX_SAFE_INTEGER]));
    const entries = servers
      .flatMap((s) => directoryEntry(s) ?? [])
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)! || a.title.localeCompare(b.title));
    const counts = new Map<string, number>();
    for (const entry of entries) for (const c of entry.categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
    const categories = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
    return { entries, categories };
  });
}

/** Claude 目录：按搜索词、分类筛，标题以搜索词开头的、标题里有搜索词的排前面，其余按目录的默认排序；返回 offset 开始的一页和总数 */
async function listDirectory(query: ConnectorQuery): Promise<ConnectorPage> {
  const { entries, categories } = await loadDirectory();
  const keyword = query.search?.trim().toLowerCase() ?? "";
  const score = (entry: ConnectorEntry) => {
    const title = entry.title.toLowerCase();
    if (title.startsWith(keyword)) return 0;
    if (title.includes(keyword)) return 1;
    return [entry.author, entry.description, ...(entry.categories ?? [])].some((text) => text?.toLowerCase().includes(keyword)) ? 2 : -1;
  };
  let matched = query.category ? entries.filter((e) => e.categories?.includes(query.category!)) : entries;
  if (keyword) {
    const scored = matched.map((entry) => ({ entry, score: score(entry) })).filter((x) => x.score >= 0);
    // sort 是稳定的，同分的保持目录的默认排序
    matched = scored.sort((a, b) => a.score - b.score).map((x) => x.entry);
  }
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 24)));
  return { connectors: markAdded(matched.slice(offset, offset + limit)), total: matched.length, categories };
}

/** 添加 Claude 目录里的连接器：地址是固定的、几个里选的或自己填的（要匹配目录给的格式） */
async function addDirectoryConnector(input: ConnectorInput): Promise<string> {
  const entry = (await loadDirectory()).entries.find((e) => e.id === input.id);
  if (!entry) throw new BadRequestError("Claude 目录里没有这个连接器");
  if (entry.unsupported) throw new BadRequestError(`${entry.title}：${entry.unsupported}`);
  const given = input.url?.trim();
  let url = entry.url;
  if (entry.urlOptions) {
    if (!given || !entry.urlOptions.some((o) => o.url === given)) throw new BadRequestError("请选择地址");
    url = given;
  } else if (entry.urlPattern) {
    url = given || entry.url;
    if (!url) throw new BadRequestError("请填写地址");
    if (!isHttps(url)) throw new BadRequestError("地址要以 https:// 开头");
    let pattern: RegExp | undefined;
    try {
      pattern = new RegExp(entry.urlPattern);
    } catch {
      // 目录给的正则 JavaScript 解析不了时不检查格式
    }
    if (pattern && !pattern.test(url)) throw new BadRequestError(`地址不符合 ${entry.title} 的格式`);
  }
  const name = serverName(input.name, entry);
  saveMcpServer({ name, type: entry.type, url }, { id: entry.id, title: entry.title, source: "directory", ...(entry.icon ? { icon: entry.icon } : {}) });
  return name;
}
