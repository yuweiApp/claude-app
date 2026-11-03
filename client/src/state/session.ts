import type { GatewayEvent, HistoryMessage } from "../api";

/** assistant 消息里的内容块（只取渲染要用的字段） */
export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type Item =
  | { kind: "user"; uuid: string; text: string }
  | { kind: "assistant"; uuid: string; blocks: Block[] }
  | { kind: "result"; uuid: string; isError: boolean; text: string; durationMs: number; costUsd: number }
  | { kind: "error"; uuid: string; text: string };

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  canAlways: boolean;
}

export interface SessionView {
  /** 主线程的消息（parent_tool_use_id 为空） */
  items: Item[];
  /** 子代理里的消息，按所属 Agent 工具调用的 id 分组 */
  children: Record<string, Item[]>;
  toolResults: Record<string, ToolResult>;
  /** 正在生成、还没收到完整 assistant 消息的文字 */
  streaming: { text: string; thinking: string };
  permissions: PermissionRequest[];
  state: string;
  model?: string;
  permissionMode?: string;
  seen: Set<string>;
  /** 续传点已丢失，需要重新拉历史 */
  needsReload: boolean;
}

export function emptyView(): SessionView {
  return {
    items: [],
    children: {},
    toolResults: {},
    streaming: { text: "", thinking: "" },
    permissions: [],
    state: "closed",
    seen: new Set(),
    needsReload: false,
  };
}

export type Action = { type: "event"; event: GatewayEvent } | { type: "history"; messages: HistoryMessage[] };

export function reduce(view: SessionView, action: Action): SessionView {
  if (action.type === "history") {
    // 历史放在前面，已经从事件流收到的（按 uuid）不重复
    const next = { ...emptyView(), state: view.state, model: view.model, permissionMode: view.permissionMode };
    for (const m of action.messages) ingestMessage(next, m.type, m.uuid, m.message, m.parent_tool_use_id);
    for (const item of view.items) pushItem(next, null, item);
    for (const [parent, items] of Object.entries(view.children)) items.forEach((item) => pushItem(next, parent, item));
    next.toolResults = { ...view.toolResults, ...next.toolResults };
    next.streaming = view.streaming;
    next.permissions = view.permissions;
    return next;
  }

  const event = action.event;
  const next: SessionView = { ...view, items: [...view.items], children: { ...view.children } };
  switch (event.type) {
    case "user_message":
      pushItem(next, null, { kind: "user", uuid: event.uuid, text: event.text });
      break;
    case "state":
      next.state = event.state;
      next.model = event.model;
      next.permissionMode = event.permissionMode;
      if (event.state !== "running") next.streaming = { text: "", thinking: "" };
      break;
    case "permission_request":
      next.permissions = [...view.permissions.filter((p) => p.requestId !== event.requestId), event];
      break;
    case "permission_resolved":
      next.permissions = view.permissions.filter((p) => p.requestId !== event.requestId);
      break;
    case "error":
      pushItem(next, null, { kind: "error", uuid: crypto.randomUUID(), text: event.message });
      break;
    case "reset":
      next.needsReload = true;
      break;
    case "sdk":
      ingestSdk(next, event.message);
      break;
  }
  return next;
}

function ingestSdk(view: SessionView, message: Extract<GatewayEvent, { type: "sdk" }>["message"]): void {
  switch (message.type) {
    case "stream_event": {
      if (message.parent_tool_use_id) return;
      const e = message.event;
      if (e.type === "message_start") view.streaming = { text: "", thinking: "" };
      if (e.type === "content_block_delta") {
        if (e.delta.type === "text_delta") view.streaming = { ...view.streaming, text: view.streaming.text + e.delta.text };
        if (e.delta.type === "thinking_delta") {
          view.streaming = { ...view.streaming, thinking: view.streaming.thinking + e.delta.thinking };
        }
      }
      return;
    }
    case "assistant":
      if (!message.parent_tool_use_id) view.streaming = { text: "", thinking: "" };
      ingestMessage(view, "assistant", message.uuid, message.message, message.parent_tool_use_id);
      return;
    case "user":
      if (message.uuid) ingestMessage(view, "user", message.uuid, message.message, message.parent_tool_use_id);
      return;
    case "result":
      view.streaming = { text: "", thinking: "" };
      pushItem(view, null, {
        kind: "result",
        uuid: message.uuid,
        isError: message.is_error,
        text: message.subtype === "success" ? "" : message.errors.join("\n") || message.subtype,
        durationMs: message.duration_ms,
        costUsd: message.total_cost_usd,
      });
      return;
  }
}

/** 把一条 user / assistant 消息（SDK 实时消息和 jsonl 历史格式相同）归并进视图 */
function ingestMessage(view: SessionView, type: string, uuid: string, raw: unknown, parent: string | null): void {
  if (view.seen.has(uuid)) return;
  const content = (raw as { content?: unknown } | null)?.content;

  if (type === "assistant" && Array.isArray(content)) {
    const blocks: Block[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "text" && typeof b.text === "string") blocks.push({ type: "text", text: b.text });
      else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
        blocks.push({ type: "thinking", thinking: b.thinking });
      } else if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") {
        blocks.push({ type: "tool_use", id: String(b.id), name: String(b.name), input: b.input });
      }
    }
    if (blocks.length) pushItem(view, parent, { kind: "assistant", uuid, blocks });
    else view.seen = new Set(view.seen).add(uuid);
    return;
  }

  if (type === "user") {
    if (typeof content === "string") {
      pushItem(view, parent, { kind: "user", uuid, text: content });
      return;
    }
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "tool_result") {
        view.toolResults = { ...view.toolResults, [String(b.tool_use_id)]: { text: resultText(b.content), isError: b.is_error === true } };
      } else if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    if (texts.length) pushItem(view, parent, { kind: "user", uuid, text: texts.join("\n") });
    else view.seen = new Set(view.seen).add(uuid);
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: Record<string, unknown>) => (c.type === "text" ? String(c.text) : `[${String(c.type)}]`))
    .join("\n");
}

function pushItem(view: SessionView, parent: string | null, item: Item): void {
  if (view.seen.has(item.uuid)) return;
  view.seen = new Set(view.seen).add(item.uuid);
  if (parent) view.children = { ...view.children, [parent]: [...(view.children[parent] ?? []), item] };
  else view.items = [...view.items, item];
}
