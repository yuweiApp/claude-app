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
  | { kind: "user"; uuid: string; at?: number; text: string; images: string[]; attachments: AttachmentChip[] }
  /** messageId：模型 API 那一次响应的 id。一次响应里的多个内容块会拆成多条消息，id 相同；同一个 id 下的多个工具调用是并行的 */
  | { kind: "assistant"; uuid: string; at?: number; messageId?: string; blocks: Block[] }
  /** userMessageUuid：SDKResultMessage.user_message_uuid，这一轮开头那条用户消息 */
  | { kind: "result"; uuid: string; userMessageUuid?: string; isError: boolean; text: string; durationMs: number; costUsd: number }
  | { kind: "error"; uuid: string; text: string }
  /** 本地命令的输出（setModel 等会发一条 <local-command-stdout> 的 user 消息），显示成一行灰字，不算用户消息 */
  | { kind: "notice"; uuid: string; text: string }
  /** 用户中断了这一轮：Claude Code 写的 [Request interrupted by user] 消息，显示成一行「已中断」，不当用户消息 */
  | { kind: "interrupted"; uuid: string }
  /**
   * 换了模型。实时：setModel 后 SDK 发一条 <local-command-stdout>Set model to X</…>，换成这一行；
   * 这条不写进会话文件，历史里按主线程 assistant 消息的 model 和前面的不同推出来，补在那一轮的用户消息前面。
   * 都没有时（换了还没发消息、事件缓冲也挤掉了）由 Messages 按 view.model 和 shownModel 不同临时显示
   */
  | { kind: "model"; uuid: string; from: string; to: string }
  /**
   * 后台任务（Bash 后台命令、后台子代理等）完成的通知。模型空闲时 Claude Code 会拿它自动开始新的一轮，所以它和用户消息一样是一轮的开头。
   * uuid 用 task:<task_id>：实时的 system/task_notification 和历史里的 <task-notification> 消息 uuid 不同，按任务 id 去重
   */
  | {
      kind: "task";
      uuid: string;
      at?: number;
      status: string;
      text: string;
      /** 失败的原因：网关补发的工具结果（task_result 事件），或历史通知里的 <result>；Bash 等其他任务没有 */
      detail?: string;
    };

export type TaskItem = Extract<Item, { kind: "task" }>;

export interface ToolResult {
  text: string;
  /** 工具返回的图片（Read 读图片时在 tool_result 里），data: 地址 */
  images: string[];
  isError: boolean;
  /** 工具调用的耗时：调用到结果的时间差，历史按消息时间戳，实时按收到的时间 */
  durationMs?: number;
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
  /** 工具调用开始的时间（毫秒），按 tool_use id，算耗时用 */
  toolStarts: Record<string, number>;
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
  /**
   * 实时收到、还没开始那一轮的后台任务通知：等下一轮自己开始（state 变成 running）时再放进消息列表，作为那一轮的开头。
   * 这一轮里之后又发出了模型请求（status: requesting），说明 Claude Code 把通知并进了这一轮，就丢掉。
   * 看的是请求发出、不是响应开始：通知到时已经在路上的请求不带它，响应回来后通知还会开新的一轮
   */
  pendingTasks: TaskItem[];
  /** 会话的后台任务（网关的 tasks 事件，整个列表）；backgroundTasksLive：已经从事件流收到过，不再用接口拉到的覆盖 */
  backgroundTasks: BackgroundTask[];
  backgroundTasksLive: boolean;
  /** 对话里已经体现的模型：最近一条主线程 assistant 消息的，或已经显示过的切换 */
  shownModel?: string;
}

export function emptyView(): SessionView {
  return {
    items: [],
    children: {},
    toolResults: {},
    toolStarts: {},
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
    for (const m of action.messages) {
      ingestMessage(next, m.type, m.uuid, m.message, m.parent_tool_use_id, m.timestamp ? Date.parse(m.timestamp) : undefined);
    }
    for (const item of view.items) {
      if (item.kind === "model") {
        // 实时那条切换历史里已经推出来了（最近一次切换就是换到它），不重复
        const derived = next.items.findLast((i) => i.kind === "model");
        next.shownModel = item.to;
        if (derived?.kind === "model" && derived.to === item.to) continue;
      }
      pushItem(next, null, item);
    }
    for (const [parent, items] of Object.entries(view.children)) items.forEach((item) => pushItem(next, parent, item));
    next.toolResults = { ...view.toolResults, ...next.toolResults };
    next.toolStarts = { ...view.toolStarts, ...next.toolStarts };
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
        view.pendingTasks.forEach((task) => pushItem(next, null, task));
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
    case "task_result": {
      // 紧跟在这个任务的 task_notification 后面到：通知生成的那一项还在 pendingTasks 里，或者已经放进了消息列表
      if (!event.isError) break;
      const uuid = `task:${event.taskId}`;
      const withDetail = (task: TaskItem): TaskItem => (task.uuid === uuid ? { ...task, detail: event.text } : task);
      next.pendingTasks = view.pendingTasks.map(withDetail);
      next.items = next.items.map((item) => (item.kind === "task" ? withDetail(item) : item));
      break;
    }
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
      if (e.type === "message_start") view.streaming = { text: "" };
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") view.streaming = { text: view.streaming.text + e.delta.text };
      return;
    }
    case "assistant":
      if (!message.parent_tool_use_id) view.streaming = { text: "" };
      ingestMessage(view, "assistant", message.uuid, message.message, message.parent_tool_use_id);
      return;
    case "user":
      if (message.uuid) ingestMessage(view, "user", message.uuid, message.message, message.parent_tool_use_id);
      return;
    case "system":
      if (message.subtype === "task_notification" && !message.skip_transcript) {
        view.pendingTasks = [...view.pendingTasks, { kind: "task", uuid: `task:${message.task_id}`, status: message.status, text: message.summary }];
      }
      if (message.subtype === "status" && message.status === "requesting" && !view.turnEnded) view.pendingTasks = [];
      return;
    case "result": {
      view.streaming = { text: "" };
      view.turnEnded = true;
      // 中断的一轮也是 error_during_execution（errors 里是 [ede_diagnostic] …），前面已经有「已中断」，不算出错
      const interrupted = view.items.at(-1)?.kind === "interrupted";
      pushItem(view, null, {
        kind: "result",
        uuid: message.uuid,
        userMessageUuid: message.user_message_uuid,
        isError: message.is_error && !interrupted,
        text: message.subtype === "success" ? "" : message.errors.join("\n") || message.subtype,
        durationMs: message.duration_ms,
        costUsd: message.total_cost_usd,
      });
      return;
    }
  }
}

/** 把一条 user / assistant 消息（SDK 实时消息和 jsonl 历史格式相同）归并进视图 */
function ingestMessage(view: SessionView, type: string, uuid: string, raw: unknown, parent: string | null, at?: number): void {
  if (view.seen.has(uuid)) return;
  const content = (raw as { content?: unknown } | null)?.content;

  if (type === "assistant" && Array.isArray(content)) {
    const blocks: Block[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "text" && typeof b.text === "string") blocks.push({ type: "text", text: b.text });
      else if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") {
        blocks.push({ type: "tool_use", id: String(b.id), name: String(b.name), input: b.input });
        view.toolStarts = { ...view.toolStarts, [String(b.id)]: at ?? Date.now() };
      }
    }
    const messageId = (raw as { id?: unknown }).id;
    // 主线程换了模型：在这一轮开头（用户消息）前面补一条；<synthetic> 是 Claude Code 自己造的消息，不算
    const model = (raw as { model?: unknown }).model;
    if (!parent && typeof model === "string" && !model.startsWith("<")) {
      if (view.shownModel && model !== view.shownModel) insertBeforeTurn(view, { kind: "model", uuid: `model:${uuid}`, from: view.shownModel, to: model });
      view.shownModel = model;
    }
    // 历史里没有 result：按 stop_reason 判断这一轮是不是结束了（后台任务通知是开新一轮还是并进当前这一轮要用到）
    const stop = (raw as { stop_reason?: unknown }).stop_reason;
    if (!parent && typeof stop === "string") view.turnEnded = stop !== "tool_use" && stop !== "pause_turn";
    if (blocks.length) {
      pushItem(view, parent, { kind: "assistant", uuid, at, messageId: typeof messageId === "string" ? messageId : undefined, blocks });
    }
    else view.seen = new Set(view.seen).add(uuid);
    return;
  }

  if (type === "user") {
    if (!parent && isInterruptNotice(content)) {
      pushItem(view, null, { kind: "interrupted", uuid });
      return;
    }
    const task = typeof content === "string" ? taskNotification(content) : null;
    if (task) {
      // 上一轮结束后到的通知让 Claude Code 开了新的一轮，显示成那一轮的开头；
      // 一轮还在进行时到的，Claude Code 把它并进当前这一轮（实时事件里也只有一个 result），对话里不单独显示，后台任务面板里有
      if (parent || view.turnEnded) pushItem(view, parent, { ...task, at });
      view.turnEnded = false;
      view.seen = new Set(view.seen).add(uuid);
      return;
    }
    // 用技能时 Claude Code 把消息存成命令标签，后面跟着技能内容（isMeta，不是用户写的）
    const command = typeof content === "string" ? skillCommand(content) : null;
    if (command) {
      pushItem(view, parent, { kind: "user", uuid, at, text: command, images: [], attachments: [] });
      if (!parent) view.turnEnded = false;
      return;
    }
    if (typeof content === "string" && SKILL_META.test(content)) {
      view.seen = new Set(view.seen).add(uuid);
      return;
    }
    const local = typeof content === "string" ? localCommandText(content) : null;
    const switched = local ? /^Set model to (\S+)/.exec(local)?.[1] : undefined;
    if (switched && !parent) {
      // 回放的、已经从历史推出来的切换（换到的就是现在的模型）不再显示
      if (view.shownModel !== switched) pushItem(view, null, { kind: "model", uuid, from: view.shownModel ?? "", to: switched });
      else view.seen = new Set(view.seen).add(uuid);
      view.shownModel = switched;
      return;
    }
    if (local !== null) {
      if (local) pushItem(view, parent, { kind: "notice", uuid, text: local });
      else view.seen = new Set(view.seen).add(uuid);
      return;
    }
    if (typeof content === "string") {
      pushItem(view, parent, { kind: "user", uuid, at, text: content, images: [], attachments: [] });
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
        const id = String(b.tool_use_id);
        const start = view.toolStarts[id];
        view.toolResults = {
          ...view.toolResults,
          [id]: {
            text: resultText(b.content),
            images: inner.flatMap((c) => imageSrc(c) ?? []),
            isError: b.is_error === true,
            durationMs: start === undefined ? undefined : Math.max(0, (at ?? Date.now()) - start),
          },
        };
      } else if (b.type === "image") {
        const src = imageSrc(b);
        if (src) images.push(src);
      } else if (b.type === "text" && typeof b.text === "string") {
        const parsed = parseAttachments(b.text);
        if (parsed) attachments.push(...parsed);
        else if (!SKILL_META.test(b.text)) texts.push(b.text);
      }
    }
    if (texts.length || images.length || attachments.length) {
      pushItem(view, parent, { kind: "user", uuid, at, text: texts.join("\n"), images, attachments });
      if (!parent) view.turnEnded = false;
    } else {
      view.seen = new Set(view.seen).add(uuid);
    }
  }
}

/** 用户中断时 Claude Code 写进对话的 user 消息（字符串，或只有一个 text 块） */
const INTERRUPT = /^\[Request interrupted by user( for tool use)?\]$/;
function isInterruptNotice(content: unknown): boolean {
  if (typeof content === "string") return INTERRUPT.test(content.trim());
  if (!Array.isArray(content) || content.length !== 1) return false;
  const b = content[0] as { type?: unknown; text?: unknown };
  return b.type === "text" && typeof b.text === "string" && INTERRUPT.test(b.text.trim());
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
  const status = field("status");
  // MCP 工具转到后台的任务，通知里带 <result>（结果原文，失败时以「Task failed: 」开头）；失败时拿它显示原因
  const detail = status === "failed" ? field("result").replace(/^Task failed:\s*/, "") || undefined : undefined;
  return { kind: "task", uuid: `task:${field("task-id")}`, status, text: field("summary"), ...(detail ? { detail } : {}) };
}

/** Claude Code 加载技能时写进对话的内容，不是用户发的 */
const SKILL_META = /^(Base directory for this skill:|Skill \/\S+ is already loaded above)/;

/** 用技能的消息：<command-message>…<command-name>/x</command-name><command-args>…</command-args>，还原成用户写的 /x 内容 */
function skillCommand(text: string): string | null {
  const match = /^<command-message>[\s\S]*?<command-name>(\/\S+)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?/.exec(text.trim());
  return match ? `${match[1]} ${match[2] ?? ""}`.trim() : null;
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
    .map((c: Record<string, unknown>) => {
      if (c.type === "text") return String(c.text);
      // ToolSearch 的结果：只带工具名，完整定义不在消息里
      if (c.type === "tool_reference") return `已加载工具：${String(c.tool_name)}`;
      return `[${String(c.type)}]`;
    })
    .join("\n");
}

/** 插到主线程当前这一轮的开头（最后一条用户消息或后台任务通知）前面 */
function insertBeforeTurn(view: SessionView, item: Item): void {
  if (view.seen.has(item.uuid)) return;
  view.seen = new Set(view.seen).add(item.uuid);
  const start = view.items.findLastIndex((i) => i.kind === "user" || i.kind === "task");
  view.items = start < 0 ? [...view.items, item] : [...view.items.slice(0, start), item, ...view.items.slice(start)];
}

function pushItem(view: SessionView, parent: string | null, item: Item): void {
  if (view.seen.has(item.uuid)) return;
  view.seen = new Set(view.seen).add(item.uuid);
  if (parent) view.children = { ...view.children, [parent]: [...(view.children[parent] ?? []), item] };
  else view.items = [...view.items, item];
}
