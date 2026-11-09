import { connectorRegistry, featuredConnectors } from "../config-file.js";
import type { ConnectorEntry, ConnectorField, ConnectorInput } from "../shared/types.js";
import { readMcpServers, saveMcpServer } from "./mcp-config.js";

/**
 * 连接器市场：MCP 官方注册表（registry.modelcontextprotocol.io，API 见 /docs）里有远程地址的服务器。
 * 不搜索时列 config.yml 里推荐的（注册表很大，也有不少批量发布的杂项），搜索时查整个注册表。添加就是存成设置页的 MCP 服务器，
 * 之后的连接、OAuth 登录和手动添加的一样
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

export class ConnectorError extends Error {}

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

/** 请求注册表；404 返回 null */
async function registry<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(connectorRegistry + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const e = err as Error;
    throw new ConnectorError(`连接器市场加载失败：${e.name === "TimeoutError" ? "注册表超过 15 秒没有响应" : ((e.cause as Error | undefined)?.message ?? e.message)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ConnectorError(`连接器市场加载失败：注册表返回 ${res.status}`);
  return (await res.json()) as T;
}

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

/** 连接器市场：不传 search 列推荐的；传了查整个注册表，一次一页，nextCursor 取下一页 */
export async function listConnectors(search?: string, cursor?: string): Promise<{ connectors: ConnectorEntry[]; nextCursor?: string }> {
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

/** 添加连接器：填好地址里的变量和请求头，存成 MCP 服务器。名称被别的服务器占了时加 -2、-3。返回服务器名称 */
export async function addConnector(input: ConnectorInput): Promise<string> {
  const entry = await connectorById(input.id);
  if (!entry) throw new ConnectorError(`注册表里没有「${input.id}」`);

  const url = entry.url.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const variable = entry.variables.find((v) => v.name === name);
    const value = input.variables?.[name]?.trim() || variable?.default;
    if (!value) throw new ConnectorError(`请填写地址里的「${name}」`);
    return encodeURIComponent(value).replace(/%2F/gi, "/");
  });
  const headers: Record<string, string> = {};
  for (const header of entry.headers) {
    // 可选的请求头没填就不带，默认值由服务器自己定（如 Neon 的 x-read-only）
    const value = input.headers?.[header.name]?.trim() || (header.required ? header.default : undefined);
    if (value) headers[header.name] = value;
    else if (header.required) throw new ConnectorError(`请填写请求头「${header.name}」`);
  }

  const requested = input.name?.trim();
  if (requested && !/^[\w-]+$/.test(requested)) throw new ConnectorError("名称只能用字母、数字、下划线和连字符");
  const servers = readMcpServers();
  const base = requested || entry.suggestedName;
  let name = base;
  // 同一个连接器再添加一次是覆盖（改了请求头之类的），别的服务器占着这个名字就换一个
  for (let i = 2; servers[name] && servers[name]?.connector?.id !== entry.id; i++) name = `${base}-${i}`;

  saveMcpServer(
    { name, type: entry.type, url, ...(Object.keys(headers).length ? { headers } : {}) },
    { id: entry.id, title: entry.title, ...(entry.icon ? { icon: entry.icon } : {}) },
  );
  return name;
}
