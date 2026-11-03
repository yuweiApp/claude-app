import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, GatewayEvent, SessionSummary } from "@gateway/shared/types";

export type { Attachment, GatewayEvent, SessionSummary };

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
}

export interface GatewayConfig {
  workspaceDir: string;
  model: string | null;
  permissionMode: PermissionMode;
  maxUploadMb: number;
  imageInput: boolean;
}

export const api = {
  config: () => request<GatewayConfig>("GET", "/config"),
  listSessions: () => request<{ sessions: SessionSummary[] }>("GET", "/sessions").then((r) => r.sessions),
  createSession: (text: string, attachments: string[], permissionMode?: PermissionMode) =>
    request<{ sessionId: string }>("POST", "/sessions", { text, attachments, permissionMode }).then((r) => r.sessionId),
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
  setPermissionMode: (id: string, mode: PermissionMode) => request("POST", `/sessions/${id}/permission-mode`, { mode }),
  replyPermission: (id: string, requestId: string, behavior: "allow" | "deny", always = false) =>
    request("POST", `/sessions/${id}/permissions/${requestId}`, { behavior, always }),
};

/** 订阅会话事件；断线后 EventSource 自动重连并带上 Last-Event-ID */
export function subscribe(sessionId: string, onEvent: (event: GatewayEvent) => void): () => void {
  const t = token();
  const source = new EventSource(`${BASE}/sessions/${sessionId}/events${t ? `?token=${encodeURIComponent(t)}` : ""}`);
  source.onmessage = (e) => onEvent(JSON.parse(e.data as string) as GatewayEvent);
  return () => source.close();
}
