import { setTimeout as sleep } from "node:timers/promises";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { McpAuthState } from "../shared/types.js";
import { clearCapabilitiesCache, inspectQuery, settledMcpStatus } from "./capabilities.js";

/**
 * MCP 服务器的 OAuth 登录，由 Claude Code 自己完成：注册客户端、PKCE、在本机 localhost 的随机端口上等回调、换令牌、
 * 存令牌（Linux / Windows 是配置目录下的 .credentials.json，macOS 是钥匙串）、过期刷新。令牌按服务器名称和配置存，
 * 同一个配置目录下的会话共用，插件带来的服务器也一样。
 *
 * 网关起一个临时 query 发 mcp_authenticate 控制请求，拿到登录页地址给网页，query 留着等回调（回调的端口在它的进程里）。
 * 浏览器和网关不在同一台电脑上时，回调跳到打不开的 localhost 页面，用户把地址栏里的网址贴回来，经 mcp_oauth_callback_url 交给它。
 */

/** SDK 的 Query 上有这几个方法，类型定义里没写（Claude Code 的 mcp_authenticate、mcp_oauth_callback_url 控制请求） */
interface AuthQuery {
  mcpAuthenticate(serverName: string, redirectUri?: string, options?: { redirectUriOnly?: boolean }): Promise<{ authUrl?: string; requiresUserAction?: boolean }>;
  mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string): Promise<unknown>;
}

/** 打开登录页后等多久，过了就结束这次登录 */
const FLOW_TIMEOUT_MS = 10 * 60_000;
/** 结束的登录留多久给网页查结果 */
const KEEP_RESULT_MS = 5 * 60_000;

interface Flow extends McpAuthState {
  q?: Query;
  cleanup?: NodeJS.Timeout;
}

const flows = new Map<string, Flow>();

export class McpAuthError extends Error {}

function authQuery(q: Query): AuthQuery {
  const candidate = q as unknown as Partial<AuthQuery>;
  if (typeof candidate.mcpAuthenticate !== "function" || typeof candidate.mcpSubmitOAuthCallbackUrl !== "function") {
    throw new McpAuthError("当前版本的 Claude Agent SDK 不支持 MCP 登录");
  }
  return candidate as AuthQuery;
}

const view = ({ state, authUrl, error }: Flow): McpAuthState => ({ state, ...(authUrl ? { authUrl } : {}), ...(error ? { error } : {}) });

function finish(name: string, flow: Flow, result: { state: "done" } | { state: "failed"; error: string }, onDone: () => void): void {
  if (flows.get(name) !== flow || flow.state !== "waiting") return;
  Object.assign(flow, result);
  flow.q?.close();
  flow.q = undefined;
  clearCapabilitiesCache();
  if (result.state === "done") onDone();
  flow.cleanup = setTimeout(() => flows.get(name) === flow && flows.delete(name), KEEP_RESULT_MS);
  flow.cleanup.unref();
}

/** 等 Claude Code 换完令牌、重新连上服务器 */
async function watch(name: string, flow: Flow, q: Query, onDone: () => void): Promise<void> {
  const deadline = Date.now() + FLOW_TIMEOUT_MS;
  while (flows.get(name) === flow && flow.state === "waiting") {
    if (Date.now() > deadline) return finish(name, flow, { state: "failed", error: "登录超时，请重新登录" }, onDone);
    await sleep(1000);
    const server = (await q.mcpServerStatus().catch(() => [])).find((s) => s.name === name);
    if (server?.status === "connected") return finish(name, flow, { state: "done" }, onDone);
    if (server?.status === "failed") return finish(name, flow, { state: "failed", error: server.error || "登录后连接失败" }, onDone);
  }
}

/**
 * 开始登录：返回登录页地址。服务器已经连上的直接返回 done。
 * 同一个服务器重复开始时，前一次作废（它在 localhost 上等的回调也跟着关掉）。onDone 在登录成功后调用
 */
export async function startMcpAuth(name: string, cwd: string, onDone: () => void): Promise<McpAuthState> {
  cancelMcpAuth(name);
  const flow: Flow = { state: "waiting" };
  flows.set(name, flow);
  const q = inspectQuery(cwd);
  flow.q = q;
  try {
    const servers = await settledMcpStatus(q, await q.mcpServerStatus());
    const server = servers.find((s) => s.name === name);
    if (!server) throw new McpAuthError(`找不到 MCP 服务器「${name}」`);
    if (server.status === "connected") {
      finish(name, flow, { state: "done" }, () => {});
      return view(flow);
    }
    const { authUrl } = await authQuery(q).mcpAuthenticate(name);
    if (!authUrl) throw new McpAuthError("服务器没有给出登录地址");
    flow.authUrl = authUrl;
    void watch(name, flow, q, onDone);
    return view(flow);
  } catch (err) {
    if (flows.get(name) === flow) flows.delete(name);
    q.close();
    if (err instanceof McpAuthError) throw err;
    throw new McpAuthError((err as Error).message);
  }
}

export function getMcpAuth(name: string): McpAuthState | undefined {
  const flow = flows.get(name);
  return flow && view(flow);
}

/** 浏览器跳到的回调网址（地址栏里带 code 的那个）交给 Claude Code，等它换完令牌 */
export async function submitMcpAuthCallback(name: string, url: string): Promise<McpAuthState> {
  const flow = flows.get(name);
  if (!flow?.q || flow.state !== "waiting") throw new McpAuthError("这次登录已经结束，请重新登录");
  const q = flow.q;
  await authQuery(q).mcpSubmitOAuthCallbackUrl(name, url).catch((err: Error) => {
    throw new McpAuthError(err.message);
  });
  // 令牌换好了。贴回来的回调 Claude Code 不会自己重连服务器（localhost 上收到的会），这里重连，结果由 watch 记下
  await q.reconnectMcpServer(name).catch(() => {});
  for (let i = 0; i < 20 && flow.state === "waiting"; i++) await sleep(250);
  return view(flow);
}

/**
 * 断开：清除 Claude Code 存的这个服务器的令牌（mcp_clear_auth 控制请求，类型定义里同样没写），再重连一次看结果。
 * 令牌同一个配置目录下的会话共用，所以对所有会话生效。返回清除后的状态：不是靠登录连上的服务器（地址不要认证、令牌写在请求头里）仍是 connected
 */
export async function clearMcpAuth(name: string, cwd: string): Promise<string> {
  cancelMcpAuth(name);
  const q = inspectQuery(cwd);
  try {
    const servers = await settledMcpStatus(q, await q.mcpServerStatus());
    if (!servers.some((s) => s.name === name)) throw new McpAuthError(`找不到 MCP 服务器「${name}」`);
    const clear = (q as unknown as { mcpClearAuth?: (serverName: string) => Promise<unknown> }).mcpClearAuth;
    if (typeof clear !== "function") throw new McpAuthError("当前版本的 Claude Agent SDK 不支持清除 MCP 登录");
    await clear.call(q, name).catch((err: Error) => {
      throw new McpAuthError(err.message);
    });
    await q.reconnectMcpServer(name).catch(() => {});
    const after = await settledMcpStatus(q, await q.mcpServerStatus());
    return after.find((s) => s.name === name)?.status ?? "pending";
  } finally {
    q.close();
    clearCapabilitiesCache();
  }
}

/** 放弃正在进行的登录 */
export function cancelMcpAuth(name: string): void {
  const flow = flows.get(name);
  if (!flow) return;
  flows.delete(name);
  clearTimeout(flow.cleanup);
  flow.q?.close();
  flow.q = undefined;
}
