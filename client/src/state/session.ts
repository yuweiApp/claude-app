import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTask, GatewayEvent, HistoryMessage } from "../api";

/** 消息里显示的附件（历史消息里只有路径，没有大小） */
export interface AttachmentChip {
  name: string;
  path: string;
  size?: number;
}

/** assistant 消息里的内容块（只取渲染要用的字段；思考不在界面上显示，不取） */
export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export type Item =
  /** images：用户消息里的 image 块（Claude 的结构，base64），转成 data: 地址直接显示 */
  | { kind: "user"; uuid: string; text: string; images: string[]; attachments: AttachmentChip[] }
  /** messageId：模型 API 那一次响应的 id。一次响应里的多个内容块会拆成多条消息，id 相同；同一个 id 下的多个工具调用是并行的 */
  | { kind: "assistant"; uuid: string; messageId?: string; blocks: Block[] }
  /** userMessageUuid：SDKResultMessage.user_message_uuid，这一轮开头那条用户消息 */
  | { kind: "result"; uuid: string; userMessageUuid?: string; isError: boolean; text: string; durationMs: number; costUsd: number }
  | { kind: "error"; uuid: string; text: string }
  /** 本地命令的输出（setModel 等会发一条 <local-command-stdout> 的 user 消息），显示成一行灰字，不算用户消息 */
  | { kind: "notice"; uuid: string; text: string }
  /**
   * 后台任务（Bash 后台命令、后台子代理等）完成的通知。模型空闲时 Claude Code 会拿它自动开始新的一轮，所以它和用户消息一样是一轮的开头。
   * uuid 用 task:<task_id>：实时的 system/task_notification 和历史里的 <task-notification> 消息 uuid 不同，按任务 id 去重
   */
  | { kind: "task"; uuid: string; status: string; text: string };

export type TaskItem = Extract<Item, { kind: "task" }>;

/**
 * 实时收到、还没放进消息列表的后台任务通知。after：收到时模型正在进行（或刚完成）的那次 API 响应。
 * 这一轮里之后又开始了别的 API 响应，说明 Claude Code 把通知并进了这一轮（历史里它在这一轮中间），就丢掉；
 * 一直到这一轮结束都没有，它会让 Claude Code 开新的一轮，等那一轮开始时放进去当开头
 */
interface PendingTask {
  task: TaskItem;
  after?: string;
}

export interface ToolResult {
  text: string;
  /** 工具返回的图片（Read 读图片时在 tool_result 里），data: 地址 */
  images: string[];
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
  streaming: { text: string };
  permissions: PermissionRequest[];
  state: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: string;
  seen: Set<string>;
  /** 续传点已丢失，需要重新拉历史 */
  needsReload: boolean;
  /** 上一轮已经结束（收到 result，或 assistant 消息的 stop_reason 是 end_turn），之后还没有新的用户消息 */
  turnEnded: boolean;
  /** 实时收到、还没开始那一轮的后台任务通知：等下一轮自己开始（state 变成 running）时再放进消息列表，作为那一轮的开头 */
  pendingTasks: PendingTask[];
  /** 当前这次模型 API 响应的 id（主线程），判断通知有没有被并进当前这一轮 */
  apiMessageId?: string;
  /** 会话的后台任务（网关的 tasks 事件，整个列表）；backgroundTasksLive：已经从事件流收到过，不再用接口拉到的覆盖 */
  backgroundTasks: BackgroundTask[];
  backgroundTasksLive: boolean;
}

export function emptyView(): SessionView {
  return {
    items: [],
    children: {},
    toolResults: {},
    streaming: { text: "" },
    permissions: [],
    state: "closed",
    seen: new Set(),
    needsReload: false,
    turnEnded: false,
    pendingTasks: [],
    backgroundTasks: [],
    backgroundTasksLive: false,
  };
}

export type Action =
  | { type: "event"; event: GatewayEvent }
  | { type: "history"; messages: HistoryMessage[] }
  /** 打开会话时用接口拉到的后台任务（事件缓冲里的 tasks 事件可能已经被挤掉） */
  | { type: "tasks"; tasks: BackgroundTask[] };

export function reduce(view: SessionView, action: Action): SessionView {
  if (action.type === "tasks") return view.backgroundTasksLive ? view : { ...view, backgroundTasks: action.tasks };
  if (action.type === "history") {
    // 历史放在前面，已经从事件流收到的（按 uuid）不重复
    const next = { ...emptyView(), state: view.state, model: view.model, effort: view.effort, permissionMode: view.permissionMode };
    for (const m of action.messages) ingestMessage(next, m.type, m.uuid, m.message, m.parent_tool_use_id);
    for (const item of view.items) pushItem(next, null, item);
    for (const [parent, items] of Object.entries(view.children)) items.forEach((item) => pushItem(next, parent, item));
    next.toolResults = { ...view.toolResults, ...next.toolResults };
    next.streaming = view.streaming;
    next.permissions = view.permissions;
    next.turnEnded = view.turnEnded;
    next.pendingTasks = view.pendingTasks;
    next.backgroundTasks = view.backgroundTasks;
    next.backgroundTasksLive = view.backgroundTasksLive;
    return next;
  }

  const event = action.event;
  const next: SessionView = { ...view, items: [...view.items], children: { ...view.children } };
  switch (event.type) {
    case "user_message":
      // content 和会话历史里的格式一样，按同一套规则归并
      ingestMessage(next, "user", event.uuid, { content: event.content }, null);
      next.turnEnded = false;
      next.pendingTasks = [];
      break;
    case "state":
      next.state = event.state;
      next.model = event.model;
      next.effort = event.effort;
      next.permissionMode = event.permissionMode;
      if (event.state !== "running") next.streaming = { text: "" };
      // 上一轮结束后没有用户消息就又开始运行：是后台任务的通知让 Claude Code 自动开了新的一轮（实时事件里没有这条 user 消息）
      if (event.state === "running" && view.turnEnded && view.pendingTasks.length) {
        view.pendingTasks.forEach(({ task }) => pushItem(next, null, task));
        next.pendingTasks = [];
        next.turnEnded = false;
      }
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
    case "tasks":
      next.backgroundTasks = event.tasks;
      next.backgroundTasksLive = true;
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
      if (e.type === "message_start") {
        view.streaming = { text: "" };
        startApiMessage(view, e.message.id);
      }
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") view.streaming = { text: view.streaming.text + e.delta.text };
      return;
    }
    case "assistant":
      if (!message.parent_tool_use_id) {
        view.streaming = { text: "" };
        startApiMessage(view, message.message.id);
      }
      ingestMessage(view, "assistant", message.uuid, message.message, message.parent_tool_use_id);
      return;
    case "user":
      if (message.uuid) ingestMessage(view, "user", message.uuid, message.message, message.parent_tool_use_id);
      return;
    case "system":
      if (message.subtype === "task_notification" && !message.skip_transcript) {
        const task: TaskItem = { kind: "task", uuid: `task:${message.task_id}`, status: message.status, text: message.summary };
        view.pendingTasks = [...view.pendingTasks, { task, after: view.turnEnded ? undefined : view.apiMessageId }];
      }
      return;
    case "result":
      view.streaming = { text: "" };
      view.turnEnded = true;
      pushItem(view, null, {
        kind: "result",
        uuid: message.uuid,
        userMessageUuid: message.user_message_uuid,
        isError: message.is_error,
        text: message.subtype === "success" ? "" : message.errors.join("\n") || message.subtype,
        durationMs: message.duration_ms,
        costUsd: message.total_cost_usd,
      });
      return;
  }
}

/** 主线程开始（或收到）一次模型 API 响应：这一轮里在它之前收到的通知已经被并进这一轮了 */
function startApiMessage(view: SessionView, id: string): void {
  if (id === view.apiMessageId) return;
  view.apiMessageId = id;
  if (!view.turnEnded && view.pendingTasks.some((p) => p.after !== undefined)) {
    view.pendingTasks = view.pendingTasks.filter((p) => p.after === undefined);
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
      else if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") {
        blocks.push({ type: "tool_use", id: String(b.id), name: String(b.name), input: b.input });
      }
    }
    const messageId = (raw as { id?: unknown }).id;
    // 历史里没有 result：按 stop_reason 判断这一轮是不是结束了（后台任务通知是开新一轮还是并进当前这一轮要用到）
    const stop = (raw as { stop_reason?: unknown }).stop_reason;
    if (!parent && typeof stop === "string") view.turnEnded = stop !== "tool_use" && stop !== "pause_turn";
    if (blocks.length) {
      pushItem(view, parent, { kind: "assistant", uuid, messageId: typeof messageId === "string" ? messageId : undefined, blocks });
    }
    else view.seen = new Set(view.seen).add(uuid);
    return;
  }

  if (type === "user") {
    const task = typeof content === "string" ? taskNotification(content) : null;
    if (task) {
      // 上一轮结束后到的通知让 Claude Code 开了新的一轮，显示成那一轮的开头；
      // 一轮还在进行时到的，Claude Code 把它并进当前这一轮（实时事件里也只有一个 result），对话里不单独显示，后台任务面板里有
      if (parent || view.turnEnded) pushItem(view, parent, task);
      view.turnEnded = false;
      view.seen = new Set(view.seen).add(uuid);
      return;
    }
    const local = typeof content === "string" ? localCommandText(content) : null;
    if (local !== null) {
      if (local) pushItem(view, parent, { kind: "notice", uuid, text: local });
      else view.seen = new Set(view.seen).add(uuid);
      return;
    }
    if (typeof content === "string") {
      pushItem(view, parent, { kind: "user", uuid, text: content, images: [], attachments: [] });
      if (!parent) view.turnEnded = false;
      return;
    }
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    const images: string[] = [];
    const attachments: AttachmentChip[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "tool_result") {
        const inner = Array.isArray(b.content) ? (b.content as unknown[]) : [];
        view.toolResults = {
          ...view.toolResults,
          [String(b.tool_use_id)]: { text: resultText(b.content), images: inner.flatMap((c) => imageSrc(c) ?? []), isError: b.is_error === true },
        };
      } else if (b.type === "image") {
        const src = imageSrc(b);
        if (src) images.push(src);
      } else if (b.type === "text" && typeof b.text === "string") {
        const parsed = parseAttachments(b.text);
        if (parsed) attachments.push(...parsed);
        else texts.push(b.text);
      }
    }
    if (texts.length || images.length || attachments.length) {
      pushItem(view, parent, { kind: "user", uuid, text: texts.join("\n"), images, attachments });
      if (!parent) view.turnEnded = false;
    } else {
      view.seen = new Set(view.seen).add(uuid);
    }
  }
}

/** 网关拼在用户消息里的 <attachments> 段（见 gateway/src/agent/attachments.ts），每行 "- 路径" */
function parseAttachments(text: string): AttachmentChip[] | null {
  const m = /^<attachments>\n([\s\S]*)\n<\/attachments>$/.exec(text.trim());
  if (!m) return null;
  return m[1]!
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const path = line.slice(2);
      return { path, name: path.split("/").pop() || path };
    });
}

/** 历史里后台任务完成的通知：Claude Code 用它开始新一轮时存成一条 user 消息，内容是 <task-notification> 段 */
function taskNotification(text: string): TaskItem | null {
  const body = /^<task-notification>([\s\S]*)<\/task-notification>$/.exec(text.trim())?.[1];
  if (body === undefined) return null;
  const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? "";
  return { kind: "task", uuid: `task:${field("task-id")}`, status: field("status"), text: field("summary") };
}

/**
 * Claude Code 本地命令留下的 user 消息：<local-command-stdout>…</local-command-stdout> 返回里面的文字，
 * <command-name> 这类命令本身的记录返回空串（不显示）；不是本地命令返回 null
 */
function localCommandText(text: string): string | null {
  const out = /^<local-command-(?:stdout|stderr)>([\s\S]*)<\/local-command-(?:stdout|stderr)>$/.exec(text.trim());
  if (out) return out[1]!.replace(/`/g, "").trim();
  if (/^<(command-name|command-message|local-command-caveat)>/.test(text.trim())) return "";
  return null;
}

/** Anthropic 的 image 块转成能直接放进 <img> 的地址：base64 → data:，url 原样 */
function imageSrc(block: unknown): string | null {
  const b = block as { type?: string; source?: { type?: string; media_type?: string; data?: string; url?: string } } | null;
  if (b?.type !== "image" || !b.source) return null;
  if (b.source.type === "base64" && b.source.data) return `data:${b.source.media_type ?? "image/png"};base64,${b.source.data}`;
  if (b.source.type === "url" && b.source.url) return b.source.url;
  return null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: Record<string, unknown>) => c.type !== "image")
    .map((c: Record<string, unknown>) => (c.type === "text" ? String(c.text) : `[${String(c.type)}]`))
    .join("\n");
}

function pushItem(view: SessionView, parent: string | null, item: Item): void {
  if (view.seen.has(item.uuid)) return;
  view.seen = new Set(view.seen).add(item.uuid);
  if (parent) view.children = { ...view.children, [parent]: [...(view.children[parent] ?? []), item] };
  else view.items = [...view.items, item];
}
