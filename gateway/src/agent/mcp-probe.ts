import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";

/**
 * 「已连接」但其实没登录的远程 MCP 服务器。
 *
 * Claude Code 按 MCP 2026-07-28 连接时，握手是 server/discover；有的服务器握手不要认证、之后的 tools/list 才回 401
 * （实测 Apify：server/discover 200，tools/list、prompts/list、resources/list 都是 401）。Claude Code（2.1.331）把它记成
 * connected、0 个工具，不变成 needs-auth，设置页就没有「登录」。它自己的 `claude mcp get` 对同一个服务器报 Needs authentication，
 * mcpAuthenticate 也照样能拿到登录地址，只是状态不对。
 *
 * 这里对「connected、0 个工具」的 HTTP 服务器由网关自己发一次 tools/list（带配置里的请求头，不带 Claude Code 存的令牌），
 * 回 401 的当作 needs-auth。别的服务器、别的返回（200、400 没有会话等）都不改。
 * 不管的：SSE 类型；请求头里有 ${…} 变量的（网关不展开，发出去会错报 401）；已经登录、本来就没有工具的服务器也会被判成
 * 需要认证（网关拿不到 Claude Code 的令牌），这种很少见。
 */

const PROBE_TIMEOUT_MS = 5_000;
/** 登录对话框每秒查一次状态，探测结果缓存一会儿 */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<boolean> }>();

export const AUTH_PROBE_ERROR = "列工具时服务器要求认证（HTTP 401）";

/** 只探测这一种：Claude Code 说连上了、却一个工具也没有的 HTTP 服务器 */
function probeTarget(server: McpServerStatus): { url: string; headers: Record<string, string> } | undefined {
  const config = server.config;
  if (server.status !== "connected" || (server.tools?.length ?? 0) > 0) return undefined;
  if (!config || config.type !== "http") return undefined;
  const headers = config.headers ?? {};
  if (Object.values(headers).some((value) => value.includes("${"))) return undefined;
  return { url: config.url, headers };
}

async function answers401(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    return res.status === 401;
  } catch {
    return false;
  }
}

function requiresAuth(url: string, headers: Record<string, string>): Promise<boolean> {
  const key = JSON.stringify([url, headers]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = answers401(url, headers);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return value;
}

/** 登录、断开之后马上要看新状态，不用缓存 */
export function clearAuthProbeCache(): void {
  cache.clear();
}

/** 状态表里「连上了却要认证」的改成 needs-auth（带上 error 说明），其余原样返回 */
export async function withAuthProbe(servers: McpServerStatus[]): Promise<McpServerStatus[]> {
  return Promise.all(
    servers.map(async (server) => {
      const target = probeTarget(server);
      if (!target || !(await requiresAuth(target.url, target.headers))) return server;
      return { ...server, status: "needs-auth" as const, error: AUTH_PROBE_ERROR };
    }),
  );
}

/** 已经是 connected 的服务器，探测后是不是要认证（登录、断开时用） */
export async function connectedButNeedsAuth(server: McpServerStatus): Promise<boolean> {
  const target = probeTarget(server);
  return target !== undefined && (await requiresAuth(target.url, target.headers));
}
