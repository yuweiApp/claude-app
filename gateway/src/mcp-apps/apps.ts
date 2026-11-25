import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import { BadRequestError, HttpError, NotFoundError } from "../errors.js";
import type { McpAppCallResult, McpAppContextUpdate, McpAppCsp, McpAppResource, McpAppTool, McpAppTools, McpAppVisibility } from "../shared/types.js";
import { buildCsp } from "./sandbox.js";

/**
 * MCP Apps（SEP-1865）的宿主这边，见 docs/mcp-apps.md：
 * - 工具表：mcpServerStatus() 里声明了 _meta.ui 的工具（Claude Code 只留 ui 和旧的 ui/resourceUri，其余 _meta 过滤掉）
 * - 读界面资源：Query.readMcpResource（只收 ui://）
 * - 界面调工具：控制请求 mcp_call（Query 上没有公开方法，用运行时的 request）。
 *   Claude Code 不管 visibility（实测只给模型用的工具界面也能调成功），这里自己检查：只能调同一个服务器上 visibility 含 app 的
 */

/** 界面资源的 MIME 类型（规范要求一字不差） */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** 工具全名里服务器名、工具名的规范化：Claude Code 把 [a-zA-Z0-9_-] 以外的字符换成 _ */
const normalize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
export const mcpToolName = (server: string, tool: string) => `mcp__${normalize(server)}__${normalize(tool)}`;

const isVisibility = (v: unknown): v is McpAppVisibility => v === "model" || v === "app";
const stringList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/** 声明了 _meta.ui 的工具；SDK 类型（网关自己的、进程内的）服务器不算，Claude Code 不替它们读资源、调工具 */
export function appToolsOf(servers: McpServerStatus[]): McpAppTools {
  const tools: McpAppTools = {};
  for (const server of servers) {
    if (server.status !== "connected" || server.config?.type === "sdk") continue;
    for (const t of server.tools ?? []) {
      const meta = (t as { _meta?: Record<string, unknown> })._meta;
      if (!meta) continue;
      const ui = meta.ui && typeof meta.ui === "object" ? (meta.ui as Record<string, unknown>) : undefined;
      const uri = typeof ui?.resourceUri === "string" ? ui.resourceUri : typeof meta["ui/resourceUri"] === "string" ? (meta["ui/resourceUri"] as string) : undefined;
      const visibility = Array.isArray(ui?.visibility) ? (ui.visibility as unknown[]).filter(isVisibility) : undefined;
      if (!uri && !visibility) continue;
      tools[mcpToolName(server.name, t.name)] = {
        server: server.name,
        tool: t.name,
        ...(uri?.startsWith("ui://") ? { resourceUri: uri } : {}),
        ...(visibility ? { visibility } : {}),
      };
    }
  }
  return tools;
}

export const sameTools = (a: McpAppTools | undefined, b: McpAppTools) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/** 读一个界面资源：mimeType 要对，blob（base64）解成文字；资源 _meta.ui 里的 csp、permissions、prefersBorder 一起返回 */
export async function readAppResource(query: Query, server: string, uri: string): Promise<McpAppResource> {
  if (!uri.startsWith("ui://")) throw new BadRequestError("界面资源的地址要以 ui:// 开头");
  let read;
  try {
    read = await query.readMcpResource(server, uri);
  } catch (e) {
    throw new HttpError(502, `读界面资源失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const item = read.contents.find((c) => c.mimeType === MCP_APP_MIME && (typeof c.text === "string" || typeof c.blob === "string"));
  if (!item) {
    const got = read.contents.map((c) => c.mimeType ?? "（没有 mimeType）").join("、") || "（没有内容）";
    throw new HttpError(502, `界面资源的类型不是 ${MCP_APP_MIME}：${got}`);
  }
  const html = typeof item.text === "string" ? item.text : Buffer.from(item.blob!, "base64").toString("utf8");
  const ui = item._meta?.ui && typeof item._meta.ui === "object" ? (item._meta.ui as Record<string, unknown>) : {};
  const rawCsp = ui.csp && typeof ui.csp === "object" ? (ui.csp as Record<string, unknown>) : undefined;
  const csp: McpAppCsp | undefined = rawCsp
    ? {
        ...(stringList(rawCsp.connectDomains) ? { connectDomains: stringList(rawCsp.connectDomains) } : {}),
        ...(stringList(rawCsp.resourceDomains) ? { resourceDomains: stringList(rawCsp.resourceDomains) } : {}),
        ...(stringList(rawCsp.frameDomains) ? { frameDomains: stringList(rawCsp.frameDomains) } : {}),
        ...(stringList(rawCsp.baseUriDomains) ? { baseUriDomains: stringList(rawCsp.baseUriDomains) } : {}),
      }
    : undefined;
  return {
    server,
    uri,
    html,
    ...(csp ? { csp } : {}),
    cspPolicy: buildCsp(csp),
    ...(ui.permissions && typeof ui.permissions === "object" ? { permissions: ui.permissions as Record<string, unknown> } : {}),
    ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
  };
}

/**
 * 界面（属于工具 from）调用同一个服务器上的工具 name。visibility 没声明的按 ["model", "app"]。
 * 走 Claude Code 的权限检查（check_permissions，和模型自己调用一样，要确认时走 canUseTool），结果不进模型上下文
 */
export async function callAppTool(query: Query, tools: McpAppTools, from: string, name: string, args: Record<string, unknown>): Promise<McpAppCallResult> {
  const owner = tools[from];
  if (!owner?.resourceUri) throw new NotFoundError(`${from} 没有界面`);
  const full = mcpToolName(owner.server, name);
  const target = tools[full];
  if (target?.visibility && !target.visibility.includes("app")) throw new HttpError(403, `${name} 只给模型用（visibility 不含 app），界面不能调用`);
  const request = (query as unknown as { request(r: Record<string, unknown>): Promise<{ subtype: string; response?: McpAppCallResult; error?: string }> }).request.bind(query);
  let reply;
  try {
    reply = await request({ subtype: "mcp_call", tool: full, arguments: args, result_not_for_model: true, check_permissions: true, soft_error_result: true });
  } catch (e) {
    throw new HttpError(502, e instanceof Error ? e.message : String(e));
  }
  if (reply.subtype !== "success" || !reply.response) throw new HttpError(502, reply.error ?? "工具调用失败");
  return reply.response;
}

/** 界面更新给模型的内容（ui/update-model-context），记下来等下一条用户消息 */
export interface AppContext {
  tool: McpAppTool;
  toolUseId: string;
  text: string;
  structuredContent?: Record<string, unknown>;
}

/** 界面给的内容：只取 text 块；两样都空时返回 null（界面清空了它的内容） */
export function appContextOf(tool: McpAppTool, update: McpAppContextUpdate): AppContext | null {
  const text = (update.content ?? [])
    .flatMap((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string" ? [(b as { text: string }).text] : []))
    .join("\n")
    .trim();
  const structured = update.structuredContent && Object.keys(update.structuredContent).length ? update.structuredContent : undefined;
  if (!text && !structured) return null;
  return { tool, toolUseId: update.toolUseId, text, ...(structured ? { structuredContent: structured } : {}) };
}

const attr = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/** 附在用户消息前面的一段（网页显示用户消息时按标签去掉） */
export function formatAppContext(c: AppContext): string {
  const lines = [
    `<mcp-app-context server="${attr(c.tool.server)}" tool="${attr(c.tool.tool)}" tool_use_id="${attr(c.toolUseId)}">`,
    `MCP 服务器 ${c.tool.server} 的工具 ${c.tool.tool} 的界面（工具调用 ${c.toolUseId}）最后一次更新给模型的内容，随这条用户消息一起送达：`,
  ];
  if (c.text) lines.push(c.text);
  if (c.structuredContent) lines.push("structuredContent：", JSON.stringify(c.structuredContent));
  lines.push("</mcp-app-context>");
  return lines.join("\n");
}
