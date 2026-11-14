import type { EffortLevel, ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, BackgroundTask, Capabilities, ContextUsage, SessionContextInfo, ConnectorEntry, ConnectorInput, DesktopTarget, BrowserEntry, BrowserLogo, BrowserProfile, BrowserSettingsView, ExternalBrowserId, ExternalBrowserInfo, ExternalBrowserTabs, FileContent, FileEncoding, GatewayEvent, MarketPlugin, MarketPluginPage, McpAuthState, McpServerInfo, McpServerInput, MessagePriority, ProjectEntry, SessionListItem, SkillDetail, SshConfigHost, SshConnectionInfo, SshConnectionInput, TaskOutput, TerminalClientMessage, TerminalEvent, TerminalInfo } from "@gateway/shared/types";

export type { MessagePriority, SshConfigHost, SshConnectionInfo, SshConnectionInput, Attachment, BackgroundTask, Capabilities, ContextUsage, SessionContextInfo, ConnectorEntry, ConnectorInput, DesktopTarget, BrowserEntry, BrowserLogo, BrowserProfile, BrowserSettingsView, ExternalBrowserId, ExternalBrowserInfo, ExternalBrowserTabs, FileContent, FileEncoding, GatewayEvent, MarketPlugin, MarketPluginPage, McpAuthState, McpServerInfo, McpServerInput, ProjectEntry, SessionListItem, SkillDetail, TaskOutput, TerminalClientMessage, TerminalEvent, TerminalInfo };

const BASE = "/api";

/** 设置页改了外部浏览器（启用、添加、删除）时在 window 上发这个事件，App 重新取启用着的浏览器 */
export const BROWSERS_CHANGED = "claude-app:browsers-changed";

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

/** 浏览器直接请求的地址（EventSource、WebSocket、<img>）带不了请求头，令牌放进 ?token= */
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
  desktopWindows: () => request<{ enabled: boolean; windows: { id: string; app: string; title: string }[] }>("GET", "/desktop/windows"),
  /** 启用着的外部浏览器（用户的 Chrome、Edge 等）和交给 Playwright 的标签页，输入框 @ 引用用；没有启用的时是空数组 */
  externalTabs: () => request<{ browsers: ExternalBrowserTabs[] }>("GET", "/external/tabs").then((r) => r.browsers),
  /** 设置页「浏览器」：每次都重新检测网关那台电脑上的浏览器 */
  browsers: () => request<BrowserSettingsView>("GET", "/browsers"),
  setBrowserTabGroup: (tabGroup: boolean) => request<BrowserSettingsView>("PATCH", "/browsers", { tabGroup }),
  /** 改一个浏览器：开关、配置（null 是不指定）、扩展 token（空字符串或 null 是清掉） */
  updateBrowser: (id: string, patch: { enabled?: boolean; profile?: string | null; token?: string | null }) =>
    request<BrowserSettingsView>("PATCH", `/browsers/${encodeURIComponent(id)}`, patch),
  addBrowser: (input: { name: string; executablePath: string; userDataDir?: string }) =>
    request<{ id: string; chromium: boolean; view: BrowserSettingsView }>("POST", "/browsers", input),
  removeBrowser: (id: string) => request<BrowserSettingsView>("DELETE", `/browsers/${encodeURIComponent(id)}`),
  /** 右侧面板：项目里一个文件夹的直接子项（path 相对项目文件夹，空是根） */
  listDir: (cwd: string, path: string) => request<{ entries: ProjectEntry[] }>("GET", `/files/list?${q({ cwd, path })}`).then((r) => r.entries),
  readFile: (cwd: string, path: string) => request<FileContent>("GET", `/files/read?${q({ cwd, path })}`),
  /** 保存文件，按 encoding（读的时候认出来的编码）写；文件在 mtimeMs 之后被改过时报错（status 409），force 覆盖 */
  writeFile: (cwd: string, path: string, text: string, mtimeMs: number, encoding: FileEncoding | undefined, force = false) =>
    request<{ mtimeMs: number; size: number }>("POST", "/files/write", { cwd, path, text, mtimeMs, encoding, force }),
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
  closeTerminal: (id: string) => request("DELETE", `/terminals/${id}`),
  /** 终端的 WebSocket 地址（输出、输入、改大小） */
  terminalSocketUrl: (id: string) => {
    const url = new URL(withToken(`/terminals/${id}/socket`), location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  },
  folders: (path?: string) => request<FolderListing>("GET", `/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  /** 设置页「SSH 连接」 */
  sshConnections: () => request<{ connections: SshConnectionInfo[] }>("GET", "/ssh/connections").then((r) => r.connections),
  sshConfigHosts: () => request<{ hosts: SshConfigHost[] }>("GET", "/ssh/config-hosts").then((r) => r.hosts),
  addSshConnection: (input: SshConnectionInput) => request<{ connection: SshConnectionInfo }>("POST", "/ssh/connections", input).then((r) => r.connection),
  updateSshConnection: (id: string, input: Partial<SshConnectionInput>) =>
    request<{ connection: SshConnectionInfo }>("PATCH", `/ssh/connections/${id}`, input).then((r) => r.connection),
  removeSshConnection: (id: string) => request("DELETE", `/ssh/connections/${id}`),
  /** 连上并准备好远端（第一次要装 Claude Code），等到连上或失败才返回；失败时看返回的状态（error、hostKey、needsPassword） */
  connectSsh: (id: string, password?: string) =>
    request<{ connection: SshConnectionInfo }>("POST", `/ssh/connections/${id}/connect`, password === undefined ? {} : { password }).then((r) => r.connection),
  trustSshHostKey: (id: string, fingerprint: string) =>
    request<{ connection: SshConnectionInfo }>("POST", `/ssh/connections/${id}/trust`, { fingerprint }).then((r) => r.connection),
  disconnectSsh: (id: string) => request<{ connection: SshConnectionInfo }>("POST", `/ssh/connections/${id}/disconnect`).then((r) => r.connection),
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
  /** elements：网页上选中的元素，每个是一段文字和截图的附件 id，网关排在用户文字后面（见 gateway/src/agent/attachments.ts） */
  send: (id: string, text: string, attachments: string[], elements: { text: string; screenshot?: string }[] = [], priority?: MessagePriority) =>
    request("POST", `/sessions/${id}/messages`, { text, attachments, ...(elements.length ? { elements } : {}), ...(priority ? { priority } : {}) }),
  upload: (files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("file", file, file.name);
    return request<{ attachments: Attachment[] }>("POST", "/uploads", form).then((r) => r.attachments);
  },
  interrupt: (id: string) => request("POST", `/sessions/${id}/interrupt`),
  /** 上下文用量和设置（输入框的上下文弹层） */
  context: (id: string) => request<SessionContextInfo>("GET", `/sessions/${id}/context`),
  /** 改上下文窗口和自动压缩阈值，null 是不设；asModelDefault 时设成这个模型的默认。子进程空闲时网关会重启它 */
  compact: (id: string) => request("POST", `/sessions/${id}/compact`),
  /** 工作目录下可用的技能、插件、MCP 服务器和子代理，不传是默认工作目录；refresh 不用网关的缓存 */
  capabilities: (cwd?: string, refresh = false) => {
    const params = new URLSearchParams({ ...(cwd ? { cwd } : {}), ...(refresh ? { refresh: "1" } : {}) });
    return request<Capabilities>("GET", `/capabilities?${params}`);
  },
  /** 技能的 SKILL.md，内置技能没有文件时报错 */
  skill: (name: string) => request<SkillDetail>("GET", `/skills/${encodeURIComponent(name)}`),
  setSkillEnabled: (name: string, enabled: boolean) => request("PATCH", `/skills/${encodeURIComponent(name)}`, { enabled }),
  /** 子代理的定义文件，内置的没有文件时报错 */
  agent: (name: string) => request<SkillDetail>("GET", `/agents/${encodeURIComponent(name)}`),
  setAgentEnabled: (name: string, enabled: boolean) => request("PATCH", `/agents/${encodeURIComponent(name)}`, { enabled }),
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
  /** 后台任务输出的最后一段（64 KB）；子代理是整理成文字的对话记录 */
  taskOutput: (id: string, taskId: string) =>
    request<TaskOutput>("GET", `/sessions/${id}/tasks/${encodeURIComponent(taskId)}/output`),
  stopTask: (id: string, taskId: string) => request("POST", `/sessions/${id}/tasks/${encodeURIComponent(taskId)}/stop`),
  /** 清掉已经结束的后台任务 */
  clearTasks: (id: string) => request("DELETE", `/sessions/${id}/tasks`),
  /** 从某条消息分叉出新会话（记录到这条消息为止），返回新会话 id */
  forkSession: (id: string, messageId: string) =>
    request<{ sessionId: string }>("POST", `/sessions/${id}/fork`, { messageId }).then((r) => r.sessionId),
  /** 改会话标题（写成自定义标题） */
  renameSession: (id: string, title: string) => request("PATCH", `/sessions/${id}`, { title }),
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
