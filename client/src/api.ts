import type { EffortLevel, ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, BackgroundTask, Capabilities, ConnectorEntry, ConnectorInput, DesktopTarget, FileContent, GatewayEvent, MarketPlugin, MarketPluginPage, McpAuthState, McpServerInfo, McpServerInput, ProjectEntry, SessionListItem, SkillDetail, TerminalEvent, TerminalInfo } from "@gateway/shared/types";

export type { Attachment, BackgroundTask, Capabilities, ConnectorEntry, ConnectorInput, DesktopTarget, FileContent, GatewayEvent, MarketPlugin, MarketPluginPage, McpAuthState, McpServerInfo, McpServerInput, ProjectEntry, SessionListItem, SkillDetail, TerminalEvent, TerminalInfo };

const BASE = "/api";

function token(): string | null {
  try {
    return localStorage.getItem("apiToken");
  } catch {
    return null;
  }
}

/** 网关返回的错误，带 HTTP 状态码（保存文件冲突是 409） */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 浏览器直接请求的地址（EventSource、<img>）带不了请求头，令牌放进 ?token= */
export function withToken(path: string): string {
  const t = token();
  if (!t) return BASE + path;
  return `${BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers["content-type"] = "application/json";
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new RequestError(data.error || `${res.status} ${res.statusText}`, res.status);
  return data;
}

/** getSessionMessages() 返回的历史消息 */
export interface HistoryMessage {
  type: "user" | "assistant" | "system";
  uuid: string;
  message: unknown;
  parent_tool_use_id: string | null;
  /** ISO 时间，历史里没有 result 时用它算一轮的用时 */
  timestamp?: string;
  /** 压缩上下文后 Claude Code 写的摘要（SDK 的类型定义里没有，运行时带着） */
  isCompactSummary?: boolean;
}

/** GET /folders：网关机器上一个文件夹里的子文件夹 */
export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; path: string }[];
}

export interface GatewayConfig {
  workspaceDir: string;
  model: string | null;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  maxUploadMb: number;
  /** 网关开没开桌面工具（config.yml 的 desktop.enabled） */
  desktop: boolean;
}

export const api = {
  config: () => request<GatewayConfig>("GET", "/config"),
  listSessions: () => request<{ sessions: SessionListItem[] }>("GET", "/sessions").then((r) => r.sessions),
  /** 项目里的文件和文件夹，输入框 @ 引用用；q 为空是第一层 */
  files: (cwd: string, q: string) =>
    request<{ entries: ProjectEntry[] }>("GET", `/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`).then((r) => r.entries),
  /** 外部浏览器（用户的 Chrome）里交给 Playwright 的标签页，输入框 @ 引用用；enabled 是 config.yml 里开没开 */
  desktopWindows: () => request<{ enabled: boolean; windows: { id: string; app: string; title: string }[] }>("GET", "/desktop/windows"),
  chromeTabs: () => request<{ enabled: boolean; tabs: { title: string; url: string }[] }>("GET", "/chrome/tabs"),
  /** 右侧面板：项目里一个文件夹的直接子项（path 相对项目文件夹，空是根） */
  listDir: (cwd: string, path: string) => request<{ entries: ProjectEntry[] }>("GET", `/files/list?${q({ cwd, path })}`).then((r) => r.entries),
  readFile: (cwd: string, path: string) => request<FileContent>("GET", `/files/read?${q({ cwd, path })}`),
  /** 保存文件；文件在 mtimeMs 之后被改过时报错（status 409），force 覆盖 */
  writeFile: (cwd: string, path: string, text: string, mtimeMs: number, force = false) =>
    request<{ mtimeMs: number }>("POST", "/files/write", { cwd, path, text, mtimeMs, force }),
  /** 图片原文件；v（修改时间）变了地址就变，浏览器不会用缓存里的旧图 */
  /** 文件树：新建文件（空的）或文件夹 */
  createFile: (cwd: string, path: string, dir: boolean) => request<object>("POST", "/files/create", { cwd, path, dir }),
  deleteFile: (cwd: string, path: string) => request<object>("POST", "/files/delete", { cwd, path }),
  /** 文件树：重命名、拖到别的文件夹 */
  renameFile: (cwd: string, from: string, to: string) => request<object>("POST", "/files/rename", { cwd, from, to }),
  /** 哪些路径（相对项目文件夹）是存在的文件 */
  filesExist: (cwd: string, paths: string[]) => request<{ exists: string[] }>("POST", "/files/exists", { cwd, paths }).then((r) => r.exists),
  /** HTML 文件显示成网页用的地址（iframe 的 src）；网页里的相对路径照常按目录取 */
  pageUrl: (cwd: string, path: string) => request<{ url: string }>("GET", `/files/page-url?${q({ cwd, path })}`).then((r) => BASE + r.url),
  rawFileUrl: (cwd: string, path: string, v?: number) => withToken(`/files/raw?${q({ cwd, path, ...(v ? { v: String(Math.round(v)) } : {}) })}`),
  /** 右侧面板的终端 */
  terminals: (cwd: string) => request<{ terminals: TerminalInfo[] }>("GET", `/terminals?${q({ cwd })}`).then((r) => r.terminals),
  createTerminal: (cwd: string, cols: number, rows: number) =>
    request<{ terminal: TerminalInfo }>("POST", "/terminals", { cwd, cols, rows }).then((r) => r.terminal),
  terminalInput: (id: string, data: string) => request("POST", `/terminals/${id}/input`, { data }),
  resizeTerminal: (id: string, cols: number, rows: number) => request("POST", `/terminals/${id}/resize`, { cols, rows }),
  closeTerminal: (id: string) => request("DELETE", `/terminals/${id}`),
  terminalStreamUrl: (id: string) => withToken(`/terminals/${id}/stream`),
  folders: (path?: string) => request<FolderListing>("GET", `/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  /** Claude Code 的模型列表（SDK 的 ModelInfo） */
  models: () => request<{ models: ModelInfo[] }>("GET", "/models").then((r) => r.models),
  /** opts.cwd：在哪个文件夹里开，不传是无文件夹（默认工作目录）；model 是模型列表里的 value（别名） */
  createSession: (
    text: string,
    attachments: string[],
    opts: { permissionMode?: PermissionMode; cwd?: string; model?: string; effort?: EffortLevel },
  ) => request<{ sessionId: string }>("POST", "/sessions", { text, attachments, ...opts }).then((r) => r.sessionId),
  /** 切换会话的模型或推理强度，只传要改的 */
  setModel: (id: string, change: { model?: string; effort?: EffortLevel }) => request("POST", `/sessions/${id}/model`, change),
  messages: (id: string) =>
    request<{ messages: HistoryMessage[] }>("GET", `/sessions/${id}/messages`).then((r) => r.messages),
  send: (id: string, text: string, attachments: string[]) =>
    request("POST", `/sessions/${id}/messages`, { text, attachments }),
  upload: (files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("file", file, file.name);
    return request<{ attachments: Attachment[] }>("POST", "/uploads", form).then((r) => r.attachments);
  },
  interrupt: (id: string) => request("POST", `/sessions/${id}/interrupt`),
  /** 工作目录下可用的技能、插件和 MCP 服务器，不传是默认工作目录；refresh 不用网关的缓存 */
  capabilities: (cwd?: string, refresh = false) => {
    const params = new URLSearchParams({ ...(cwd ? { cwd } : {}), ...(refresh ? { refresh: "1" } : {}) });
    return request<Capabilities>("GET", `/capabilities?${params}`);
  },
  /** 技能的 SKILL.md，内置技能没有文件时报错 */
  skill: (name: string) => request<SkillDetail>("GET", `/skills/${encodeURIComponent(name)}`),
  setSkillEnabled: (name: string, enabled: boolean) => request("PATCH", `/skills/${encodeURIComponent(name)}`, { enabled }),
  /** 导入技能、插件：path 是网关机器上的文件夹 */
  importExtension: (kind: "skills" | "plugins", path: string) => request<{ name: string }>("POST", `/${kind}/import`, { path }),
  deleteExtension: (kind: "skills" | "plugins", name: string) => request("DELETE", `/${kind}/${encodeURIComponent(name)}`),
  /** 插件市场里按搜索词、来源、分类筛过的一页，带总数和筛选的选项；refresh 时网关先更新市场 */
  pluginMarket: (query: { refresh?: boolean; search?: string; marketplace?: string; category?: string; offset: number; limit: number }) => {
    const params = new URLSearchParams({
      offset: String(query.offset),
      limit: String(query.limit),
      ...(query.refresh ? { refresh: "1" } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.marketplace ? { marketplace: query.marketplace } : {}),
      ...(query.category ? { category: query.category } : {}),
    });
    return request<MarketPluginPage>("GET", `/plugin-market?${params}`);
  },
  /** 安装、卸载、更新市场里的插件：id 是「插件名@市场名」 */
  installPlugin: (id: string) => request("POST", "/plugin-market/install", { id }),
  uninstallPlugin: (id: string) => request("POST", "/plugin-market/uninstall", { id }),
  updatePlugin: (id: string) => request<{ message: string }>("POST", "/plugin-market/update", { id }).then((r) => r.message),
  saveMcpServer: (name: string, input: Omit<McpServerInput, "name">) => request("PUT", `/mcp-servers/${encodeURIComponent(name)}`, input),
  setMcpServerEnabled: (name: string, enabled: boolean) => request("PATCH", `/mcp-servers/${encodeURIComponent(name)}`, { enabled }),
  deleteMcpServer: (name: string) => request("DELETE", `/mcp-servers/${encodeURIComponent(name)}`),
  /** 连接器市场：不传 search 是推荐的，传了查整个 MCP 注册表，cursor 取下一页 */
  connectors: (search?: string, cursor?: string) => {
    const params = new URLSearchParams({ ...(search ? { search } : {}), ...(cursor ? { cursor } : {}) });
    return request<{ connectors: ConnectorEntry[]; nextCursor?: string }>("GET", `/connectors?${params}`);
  },
  /** 添加连接器，返回存成的 MCP 服务器名称 */
  addConnector: (input: ConnectorInput) => request<{ name: string }>("POST", "/connectors", input).then((r) => r.name),
  /** MCP 服务器的 OAuth 登录：开始（返回登录页地址）、查进度、交回调网址、放弃 */
  startMcpAuth: (name: string) => request<McpAuthState>("POST", `/mcp-servers/${encodeURIComponent(name)}/auth`, {}),
  mcpAuth: (name: string) => request<McpAuthState>("GET", `/mcp-servers/${encodeURIComponent(name)}/auth`),
  submitMcpAuthCallback: (name: string, url: string) => request<McpAuthState>("POST", `/mcp-servers/${encodeURIComponent(name)}/auth/callback`, { url }),
  cancelMcpAuth: (name: string) => request("DELETE", `/mcp-servers/${encodeURIComponent(name)}/auth`),
  /** 断开：清除保存的登录令牌，返回清除后的状态 */
  logoutMcpServer: (name: string) => request<{ status: string }>("POST", `/mcp-servers/${encodeURIComponent(name)}/logout`, {}).then((r) => r.status),
  /** 会话的后台任务 */
  tasks: (id: string) => request<{ tasks: BackgroundTask[] }>("GET", `/sessions/${id}/tasks`).then((r) => r.tasks),
  /** 后台任务输出的最后一段（64 KB） */
  taskOutput: (id: string, taskId: string) =>
    request<{ text: string; truncated: boolean }>("GET", `/sessions/${id}/tasks/${encodeURIComponent(taskId)}/output`),
  stopTask: (id: string, taskId: string) => request("POST", `/sessions/${id}/tasks/${encodeURIComponent(taskId)}/stop`),
  /** 清掉已经结束的后台任务 */
  clearTasks: (id: string) => request("DELETE", `/sessions/${id}/tasks`),
  /** 删除会话，会话记录一起删，不能恢复 */
  deleteSession: (id: string) => request("DELETE", `/sessions/${id}`),
  setPermissionMode: (id: string, mode: PermissionMode) => request("POST", `/sessions/${id}/permission-mode`, { mode }),
  /** answers：AskUserQuestion 的回答（问题原文 → 选中的选项） */
  replyPermission: (id: string, requestId: string, behavior: "allow" | "deny", always = false, answers?: Record<string, string>) =>
    request("POST", `/sessions/${id}/permissions/${requestId}`, { behavior, always, ...(answers ? { answers } : {}) }),
};

/**
 * 订阅会话事件。断线时 EventSource 自己会带 Last-Event-ID 重连，但遇到 502 这类错误状态（网关正在重启）会彻底放弃，
 * 这时隔一会儿自己重新连，用 ?since= 带上收到的最后一个事件 id
 */
export function subscribe(sessionId: string, onEvent: (event: GatewayEvent) => void): () => void {
  let source: EventSource | null = null;
  let lastId = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const connect = () => {
    const params = new URLSearchParams();
    const t = token();
    if (t) params.set("token", t);
    if (lastId) params.set("since", lastId);
    const query = params.toString();
    source = new EventSource(`${BASE}/sessions/${sessionId}/events${query ? `?${query}` : ""}`);
    source.onmessage = (e) => {
      if (e.lastEventId) lastId = e.lastEventId;
      onEvent(JSON.parse(e.data as string) as GatewayEvent);
    };
    source.onerror = () => {
      if (stopped || source?.readyState !== EventSource.CLOSED) return;
      timer = setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
}
