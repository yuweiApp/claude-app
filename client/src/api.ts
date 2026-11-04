import type { EffortLevel, ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, BackgroundTask, Capabilities, GatewayEvent, SessionListItem } from "@gateway/shared/types";

export type { Attachment, BackgroundTask, Capabilities, GatewayEvent, SessionListItem };

const BASE = "/api";

function token(): string | null {
  try {
    return localStorage.getItem("apiToken");
  } catch {
    return null;
  }
}

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
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
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
}

export const api = {
  config: () => request<GatewayConfig>("GET", "/config"),
  listSessions: () => request<{ sessions: SessionListItem[] }>("GET", "/sessions").then((r) => r.sessions),
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
  /** 工作目录下可用的技能和插件，不传是默认工作目录 */
  capabilities: (cwd?: string) => request<Capabilities>("GET", `/capabilities${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
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
  replyPermission: (id: string, requestId: string, behavior: "allow" | "deny", always = false) =>
    request("POST", `/sessions/${id}/permissions/${requestId}`, { behavior, always }),
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
