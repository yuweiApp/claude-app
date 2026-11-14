import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { withToken, type BackgroundTask, type ContextUsage, type DesktopTarget, type GatewayEvent, type HistoryMessage } from "../api";
import { parseSelectedElement, splitResponseAnnotations, type SentResponseAnnotation } from "./responseAnnotations";

/** 消息里显示的附件（历史消息里只有路径，没有大小） */
export interface AttachmentChip {
  name: string;
  path: string;
  size?: number;
}

/** assistant 消息里的内容块（只取渲染要用的字段；思考不在界面上显示，不取） */
export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export type Item =
  /** images：用户消息里的 image 块（Claude 的结构，base64），转成 data: 地址直接显示；历史里的是网关的取图地址 */
  /** annotations：消息末尾带的回复注释（见 responseAnnotations.ts），text 里已去掉 */
  | { kind: "user"; uuid: string; at?: number; text: string; images: string[]; attachments: AttachmentChip[]; annotations?: SentResponseAnnotation[] }
  /** messageId：模型 API 那一次响应的 id。一次响应里的多个内容块会拆成多条消息，id 相同；同一个 id 下的多个工具调用是并行的 */
  | { kind: "assistant"; uuid: string; at?: number; messageId?: string; blocks: Block[] }
  /**
   * userMessageUuid：SDKResultMessage.user_message_uuid，这一轮开头那条用户消息；后台任务通知唤起的轮没有。
   * startUuid：result 到达时消息列表里最近一条主线程的用户消息或后台任务通知，没有 userMessageUuid 时按它归属。
   * beforeUuid：result 之后开始的第一轮的开头。两个都对不上时（事件流回放从某一轮中间开始，那一轮又是后台任务通知开始的），
   * 只往这一轮之前找；否则拉回历史后它会挂到正在进行的这一轮上，这一轮当成已经结束，过程折叠、计时变成上一轮的用时
   */
  | {
      kind: "result";
      uuid: string;
      at?: number;
      userMessageUuid?: string;
      startUuid?: string;
      beforeUuid?: string;
      isError: boolean;
      text: string;
      durationMs: number;
      costUsd: number;
    }
  /** 子进程异常结束的报错。at：网关发出的时间；host：SSH 连接断开引起的，是连接 id（重新连上后不再显示，见 Messages 的 ErrorLine） */
  | { kind: "error"; uuid: string; at: number; text: string; host?: string }
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
   * 压缩上下文：这一轮在这里分段，显示成一条分界线，摘要不显示（不是用户写的）。
   * 实时：system/status 是 compacting 时开始（running，显示动画；压缩期间每 30 秒还会再来一次），compact_boundary 到了算完成（done），
   * 紧跟着一条 isSynthetic 的 user 消息是摘要，uuid 换成摘要的（awaitingSummary），重新拉历史时按 uuid 去重；
   * status 带 compact_result: failed、或者没等到 compact_boundary 这一轮就结束了，算没完成（failed）。
   * 历史：网关接上了压缩前的消息，摘要（isCompactSummary）在分界处。at：实时是开始压缩的时间，历史是摘要的时间。
   * manual：空闲时用 /compact（输入框的「压缩会话」）压缩的，自成一轮，不是上一轮的一段。实时按开始压缩时上一轮已经结束判断，
   * 历史按摘要后面紧跟着的 <command-name>/compact</command-name>
   */
  | { kind: "compact"; uuid: string; at?: number; status: "running" | "done" | "failed"; awaitingSummary?: boolean; manual?: boolean }
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
      /** 子代理的最终回复（可能很长）：历史通知里的 <result>，实时通知里的 summary */
      result?: string;
    }
  /**
   * 同一会话里的其他 agent（子代理、队友）用 SendMessage 发来的消息。Claude Code 把它存成一条 user 消息：
   * 「Another Claude session sent a message:」、<agent-message from="…">正文</agent-message>，后面跟一段给模型看的说明；
   * 一轮进行中并进来的（会话记录里是 queued_command 附件）只有 <agent-message> 那段。
   * 空闲时到的会开始新的一轮，和用户消息一样是一轮的开头。from 是发送方的 agentId（队友是名字）
   */
  | { kind: "agent"; uuid: string; at?: number; from: string; text: string };

export type TaskItem = Extract<Item, { kind: "task" }>;
export type AgentItem = Extract<Item, { kind: "agent" }>;
export type UserItem = Extract<Item, { kind: "user" }>;

/** 还没交给模型的用户消息（user_message 事件带 queued）：content 原样留着，交给模型时再归并进消息列表；preview 是显示用的 */
export interface QueuedMessage {
  uuid: string;
  content: unknown;
  preview?: UserItem;
  /** 以 next 排队的（Ctrl+Enter，或有待确认的权限时）：列在输入框上面，可以撤回、编辑、改成立即发送，不显示在对话最后 */
  next?: boolean;
}

export interface ToolResult {
  text: string;
  /** 工具返回的图片（Read 读图片时在 tool_result 里），data: 地址；历史里的是网关的取图地址 */
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
  /**
   * 历史已经拉回来（失败了也算，只显示事件流里的）。打开会话时先连事件流，回放的只是最近的事件，
   * 历史回来之前显示的是后半截，滚动条会忽长忽短，这期间不显示消息
   */
  historyLoaded: boolean;
  /** 上一轮已经结束（收到 result，或 assistant 消息的 stop_reason 是 end_turn），之后还没有新的用户消息 */
  turnEnded: boolean;
  /**
   * 实时收到、还没开始那一轮的后台任务通知：等下一轮自己开始（state 变成 running）时再放进消息列表，作为那一轮的开头。
   * 这一轮里主线程有工具结果回来之后又发出了模型请求（status: requesting），说明 Claude Code 把通知并进了这一轮，就丢掉；
   * 没有工具结果的请求、后台子代理的请求不带它（status 消息分不出是谁的请求，只看主线程的工具结果）。
   * 看的是请求发出、不是响应开始：通知到时已经在路上的请求不带它，响应回来后通知还会开新的一轮。
   * 子代理发给主线程的消息（Item 的 agent）也在这里：实时事件里没有那条 user 消息，子代理的 SendMessage 成功时
   * （结果是「queued for the main conversation's next turn」）生成，同样等下一轮开始时放进去；
   * Claude Code 在工具结果之后发下一次请求时才取队列：上次请求之后主线程有工具结果回来（toolResultSinceRequest），
   * 这次请求就带上了它，这时放进去，和会话记录里它的位置一致；没有工具结果的请求（如没有输出时的重试）不带它
   */
  pendingTasks: Array<TaskItem | AgentItem>;
  /** 上次发出模型请求（status: requesting）之后，主线程有工具结果回来 */
  toolResultSinceRequest: boolean;
  /** 有后台任务结束的通知还没交给模型（网关的 state 事件）：Claude Code 会拿它开始新的一轮，空闲时也算在忙 */
  noticePending: boolean;
  /** 会话的后台任务（网关的 tasks 事件，整个列表）；backgroundTasksLive：已经从事件流收到过，不再用接口拉到的覆盖 */
  backgroundTasks: BackgroundTask[];
  backgroundTasksLive: boolean;
  /** 对话里已经体现的模型：最近一条主线程 assistant 消息的，或已经显示过的切换 */
  shownModel?: string;
  /**
   * 这一轮进行中发出、Claude Code 放进了队列的用户消息（有工具在跑时 priority: now，否则 next）：
   * 先像普通消息一样显示在对话最后，这一轮剩下的回复排在它上面；交给模型时（command_lifecycle 的 started：
   * 某个工具结果之后并进这一轮，或者这一轮结束后开始下一轮）再放进消息列表，位置就固定了。
   * 马上放进去的话，这一轮剩下的回复会排在它后面、被算进它那一轮
   */
  queued: QueuedMessage[];
  /** 网关的 turn_start 事件：这些用户消息开始了新的一轮，不是插进上一轮的（见 Messages 的 splitTurns） */
  turnStartUuids: string[];
  /**
   * 发出了、Claude Code 还没交给模型的用户消息（还没收到 command_lifecycle 的 started 等）。这时到的 result 不属于它开始的那一轮：
   * 空闲时发的消息也可能先排着，Claude Code 先处理完别的（比如后台任务的通知）出一个 result，才拿它开新的一轮
   */
  unstartedUuids: string[];
  /** 桌面工具最近操作的窗口（网关的 desktop_target 事件），右上角的浮窗显示它 */
  desktopTarget: DesktopTarget | null;
  /** 上下文用量（网关的 context 事件），还没收到时 null */
  context: ContextUsage | null;
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
    historyLoaded: false,
    turnEnded: false,
    pendingTasks: [],
    toolResultSinceRequest: false,
    noticePending: false,
    backgroundTasks: [],
    backgroundTasksLive: false,
    queued: [],
    turnStartUuids: [],
    unstartedUuids: [],
    desktopTarget: null,
    context: null,
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
    const next = { ...emptyView(), state: view.state, model: view.model, effort: view.effort, permissionMode: view.permissionMode, noticePending: view.noticePending, historyLoaded: true };
    for (const m of action.messages) {
      const at = m.timestamp ? Date.parse(m.timestamp) : undefined;
      if (m.isCompactSummary && !m.parent_tool_use_id) ingestCompactSummary(next, m.uuid, at);
      else ingestMessage(next, m.type, m.uuid, m.message, m.parent_tool_use_id, at);
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
    // 拉历史之前已经从事件流收到过消息的，以实时的为准；没有的按历史推出来的（最后一条主线程回复的 stop_reason），
    // 否则刚打开的会话一直当上一轮没结束，后台任务通知唤起的新一轮会接在上一轮后面、没有通知行
    if (view.items.length) next.turnEnded = view.turnEnded;
    // 子代理的消息已经在历史里的（Claude Code 已经交给模型）不再挂着
    next.pendingTasks = view.pendingTasks.filter((pending) => !next.seen.has(pending.uuid));
    next.toolResultSinceRequest = view.toolResultSinceRequest;
    next.backgroundTasks = view.backgroundTasks;
    next.backgroundTasksLive = view.backgroundTasksLive;
    next.desktopTarget = view.desktopTarget;
    next.context = view.context;
    // 历史里已经有的（Claude Code 已经交给模型、写进了会话文件），不再排队
    next.queued = view.queued.filter((q) => !next.seen.has(q.uuid));
    next.turnStartUuids = view.turnStartUuids;
    next.unstartedUuids = view.unstartedUuids;
    return next;
  }

  const event = action.event;
  const next: SessionView = { ...view, items: [...view.items], children: { ...view.children } };
  switch (event.type) {
    case "user_message":
      if (!view.unstartedUuids.includes(event.uuid)) next.unstartedUuids = [...view.unstartedUuids, event.uuid];
      if (event.queued) {
        if (!view.seen.has(event.uuid) && !view.queued.some((q) => q.uuid === event.uuid)) {
          next.queued = [
            ...view.queued,
            { uuid: event.uuid, content: event.content, preview: previewUser(event.uuid, event.content), ...(event.priority === "next" ? { next: true } : {}) },
          ];
        }
        break;
      }
      ingestUserMessage(next, event.uuid, event.content);
      break;
    case "turn_start":
      if (!view.turnStartUuids.includes(event.uuid)) next.turnStartUuids = [...view.turnStartUuids, event.uuid];
      break;
    case "user_message_cancelled":
      next.queued = view.queued.filter((q) => q.uuid !== event.uuid);
      next.unstartedUuids = view.unstartedUuids.filter((u) => u !== event.uuid);
      break;
    case "state":
      next.state = event.state;
      next.model = event.model;
      next.effort = event.effort;
      next.permissionMode = event.permissionMode;
      next.noticePending = !!event.noticePending;
      if (event.state !== "running") next.streaming = { text: "" };
      // 兜底：没收到 started 就停了（子进程退出等），排队的消息不再一直挂在最后
      // 子进程结束了，没交给模型的消息不会再开始
      if (event.state === "closed") next.unstartedUuids = [];
      if (event.state === "idle" || event.state === "closed") {
        flushQueued(next);
        finishCompact(next, "failed");
      }
      // 上一轮结束后没有用户消息就又开始运行：是后台任务的通知或子代理的消息让 Claude Code 自动开了新的一轮（实时事件里没有这条 user 消息）。
      // 后台任务通知和子代理消息各开各的一轮：放进开头连着的同一类，剩下的等下一轮
      if (event.state === "running" && view.turnEnded && view.pendingTasks.length) {
        const kind = view.pendingTasks[0]!.kind;
        const count = view.pendingTasks.findIndex((pending) => pending.kind !== kind);
        const take = count < 0 ? view.pendingTasks : view.pendingTasks.slice(0, count);
        take.forEach((pending) => pushItem(next, null, { ...pending, at: Date.now() }));
        next.pendingTasks = view.pendingTasks.slice(take.length);
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
      pushItem(next, null, { kind: "error", uuid: crypto.randomUUID(), at: event.at, text: event.message, ...(event.host ? { host: event.host } : {}) });
      break;
    case "tasks":
      next.backgroundTasks = event.tasks;
      next.backgroundTasksLive = true;
      break;
    case "task_result": {
      // 紧跟在这个任务的 task_notification 后面到：通知生成的那一项还在 pendingTasks 里，或者已经放进了消息列表
      if (!event.isError) break;
      const uuid = `task:${event.taskId}`;
      const withDetail = <T extends Item>(item: T): T => (item.kind === "task" && item.uuid === uuid ? { ...item, detail: event.text } : item);
      next.pendingTasks = view.pendingTasks.map(withDetail);
      next.items = next.items.map((item) => (item.kind === "task" ? withDetail(item) : item));
      break;
    }
    case "desktop_target":
      next.desktopTarget = event.target;
      break;
    case "context":
      next.context = event.usage;
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
  // 用户消息的进度（SDK 的类型定义里没有）：started 是这条消息交给模型了，排队的消息这时放进消息列表
  const lifecycle = message as unknown as { type: string; command_uuid?: string; state?: string };
  if (lifecycle.type === "command_lifecycle") {
    if (lifecycle.state === "started" && lifecycle.command_uuid) flushQueued(view, lifecycle.command_uuid);
    if (lifecycle.state !== "queued" && lifecycle.command_uuid) view.unstartedUuids = view.unstartedUuids.filter((u) => u !== lifecycle.command_uuid);
    return;
  }
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
      ingestMessage(view, "assistant", message.uuid, message.message, message.parent_tool_use_id, Date.now());
      return;
    case "user": {
      if (!message.uuid) return;
      // isSynthetic 是 Claude Code 自己加的 user 消息（不止摘要），紧跟在 compact_boundary 后面的才是摘要
      const last = view.items.at(-1);
      if (message.isSynthetic && !message.parent_tool_use_id && last?.kind === "compact" && last.awaitingSummary) {
        ingestCompactSummary(view, message.uuid, Date.now());
      } else if (message.isSynthetic && syntheticPrompt(message.message.content)) {
        // Claude Code 自己发给模型的提示（如「[Your previous response had no visible output…]」），不是用户写的，不显示
        view.seen = new Set(view.seen).add(message.uuid);
      } else ingestMessage(view, "user", message.uuid, message.message, message.parent_tool_use_id, Date.now());
      const content = message.message.content;
      if (!message.parent_tool_use_id && Array.isArray(content) && content.some((b) => b.type === "tool_result")) view.toolResultSinceRequest = true;
      if (message.parent_tool_use_id) queueAgentMessages(view, message.parent_tool_use_id, (message as { agent_id?: unknown }).agent_id, message.message.content);
      return;
    }
    case "system":
      if (message.subtype === "status" && message.status === "compacting") {
        if (!runningCompact(view)) pushItem(view, null, { kind: "compact", uuid: `compact:${message.uuid}`, at: Date.now(), status: "running", manual: view.turnEnded });
      } else if (message.subtype === "status" && message.compact_result === "failed") {
        finishCompact(view, "failed");
      }
      if (message.subtype === "compact_boundary") {
        if (runningCompact(view)) {
          view.seen = new Set(view.seen).add(message.uuid);
          finishCompact(view, "done");
        } else pushItem(view, null, { kind: "compact", uuid: message.uuid, at: Date.now(), status: "done", awaitingSummary: true, manual: message.compact_metadata.trigger === "manual" });
      }
      // 子代理里的工具调用（它自己的 Bash 等）结束也发通知，但那不会开始主线程的新一轮
      if (message.subtype === "task_notification" && !message.skip_transcript && !subagentCall(view, message.tool_use_id)) {
        view.pendingTasks = [...view.pendingTasks, liveTaskItem(view, message)];
      }
      if (message.subtype === "status" && message.status === "requesting") {
        // 主线程有工具结果回来后的这次请求才带上队列（没有工具结果的请求、后台子代理的请求都不带）：
        // 子代理的消息放进这一轮，后台任务通知并进这一轮、对话里不显示，都不再挂着
        if (!view.turnEnded && view.toolResultSinceRequest && view.pendingTasks.length) {
          // 时间用 SendMessage 成功（进队列）的时刻：会话记录里并进这一轮的消息记的也是它
          view.pendingTasks.forEach((pending) => pending.kind === "agent" && pushItem(view, null, pending));
          view.pendingTasks = [];
        }
        view.toolResultSinceRequest = false;
      }
      return;
    case "result": {
      view.streaming = { text: "" };
      // 最近的一轮开头还没交给模型：它的那一轮马上开始，不算结束
      const latest = view.items.findLast(isTurnStart);
      view.turnEnded = !(latest && view.unstartedUuids.includes(latest.uuid));
      // 压缩到一半这一轮就结束了（中断等）
      finishCompact(view, "failed");
      // 中断的一轮也是 error_during_execution（errors 里是 [ede_diagnostic] …），前面已经有「已中断」，不算出错
      const interrupted = view.items.at(-1)?.kind === "interrupted";
      // 还没交给模型的消息开始的轮不算：这个 result 是它之前那段处理的（见 unstartedUuids）
      const start = view.items.findLast((it) => isTurnStart(it) && !view.unstartedUuids.includes(it.uuid));
      pushItem(view, null, {
        kind: "result",
        uuid: message.uuid,
        at: Date.now(),
        userMessageUuid: message.user_message_uuid,
        startUuid: start?.uuid,
        isError: message.is_error && !interrupted,
        text: message.subtype === "success" ? "" : message.errors.join("\n") || message.subtype,
        durationMs: message.duration_ms,
        costUsd: message.total_cost_usd,
      });
      // 兜底：这一轮结束了，还排着的消息只会在下一轮开头交给模型（正常会先收到 started）
      flushQueued(view);
      return;
    }
  }
}

/**
 * 用户发的消息归并进视图：content 和会话历史里的格式一样，按同一套规则归并；
 * 实时消息没有时间戳，按归并的时间记（算一轮的用时要用）
 */
function ingestUserMessage(view: SessionView, uuid: string, content: unknown): void {
  ingestMessage(view, "user", uuid, { content }, null, Date.now());
  view.turnEnded = false;
  // 后台任务通知不会再开新的一轮了；子代理的消息会并进这一轮，等这一轮发请求时放进去
  view.pendingTasks = view.pendingTasks.filter((pending) => pending.kind === "agent");
}

/**
 * 子代理的 SendMessage 发给主线程（to: "main"）成功了：生成一条 agent 项挂进 pendingTasks。
 * uuid 用发送方和正文，和会话记录里那条（agentMessage）一样，重新拉历史时不重复
 */
function queueAgentMessages(view: SessionView, parent: string, agentId: unknown, content: unknown): void {
  if (typeof agentId !== "string" || !Array.isArray(content)) return;
  for (const b of content as Array<Record<string, unknown>>) {
    if (b.type !== "tool_result" || b.is_error === true) continue;
    const call = view.children[parent]?.flatMap((item) => (item.kind === "assistant" ? item.blocks : [])).find((block) => block.type === "tool_use" && block.id === b.tool_use_id);
    if (call?.type !== "tool_use" || call.name !== "SendMessage") continue;
    const input = (call.input ?? {}) as { to?: unknown; message?: unknown };
    if (input.to !== "main" || typeof input.message !== "string" || !/queued for the main conversation/i.test(resultText(b.content))) continue;
    const text = input.message.trim();
    const uuid = agentUuid(agentId, text);
    if (!view.seen.has(uuid) && !view.pendingTasks.some((p) => p.uuid === uuid)) view.pendingTasks = [...view.pendingTasks, { kind: "agent", uuid, at: Date.now(), from: agentId, text }];
  }
}

/** agent 项的 uuid：实时（SendMessage）和历史（会话记录里的 user 消息）两边对得上；同一个子代理发两条一模一样的只显示一条 */
const agentUuid = (from: string, text: string) => `agent:${from}:${text}`;

/** 排队的消息放进消息列表：给了 uuid 只放这一条，不给放全部（历史或事件里已经有的跳过） */
function flushQueued(view: SessionView, uuid?: string): void {
  const take = view.queued.filter((q) => uuid === undefined || q.uuid === uuid);
  if (!take.length) return;
  view.queued = view.queued.filter((q) => !take.includes(q));
  for (const q of take) if (!view.seen.has(q.uuid)) ingestUserMessage(view, q.uuid, q.content);
}

/** 排队中的消息显示用：按归并用户消息的同一套规则转成 user 项，不碰真正的视图 */
function previewUser(uuid: string, content: unknown): UserItem | undefined {
  const scratch = emptyView();
  ingestMessage(scratch, "user", uuid, { content }, null, Date.now());
  const item = scratch.items[0];
  return item?.kind === "user" ? item : undefined;
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
      // 并进去的也按任务 id 记下：几条通知一起到时实时会各开一轮（见 state 事件），重新拉历史后实时那项不能再接到最后
      if (parent || view.turnEnded) pushItem(view, parent, { ...task, at });
      view.turnEnded = false;
      view.seen = new Set(view.seen).add(uuid).add(task.uuid);
      return;
    }
    const agent = agentMessage(content);
    if (agent) {
      view.seen = new Set(view.seen).add(uuid);
      pushItem(view, parent, { kind: "agent", uuid: agentUuid(agent.from, agent.text), at, ...agent });
      if (!parent) view.turnEnded = false;
      return;
    }
    // 用技能时 Claude Code 把消息存成命令标签，后面跟着技能内容（isMeta，不是用户写的）
    const command = typeof content === "string" ? skillCommand(content) : null;
    if (command) {
      pushItem(view, parent, userItem(uuid, at, command, [], []));
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
      // 空闲时换的模型，Claude Code 等下一条消息开始处理时才发这条，排在那条用户消息后面：
      // 这一轮还没有回复时放到这一轮开头前面，和历史里推出来的位置一致；这一轮进行中换的才接在最后
      if (view.shownModel !== switched) {
        const item: Item = { kind: "model", uuid, from: view.shownModel ?? "", to: switched };
        if (turnHasReply(view)) pushItem(view, null, item);
        else insertBeforeTurn(view, item);
      } else view.seen = new Set(view.seen).add(uuid);
      view.shownModel = switched;
      return;
    }
    if (local !== null) {
      // /compact 成功时的「Compacted」：前面已经有「上下文已压缩」那一行
      if (local && !/^Compacted\b/.test(local)) pushItem(view, parent, { kind: "notice", uuid, text: local });
      else view.seen = new Set(view.seen).add(uuid);
      // 历史里手动压缩的：摘要后面跟着 /compact 命令本身的记录
      const last = view.items.at(-1);
      if (!parent && typeof content === "string" && /<command-name>\/compact<\/command-name>/.test(content) && last?.kind === "compact" && !last.manual) {
        view.items = view.items.with(-1, { ...last, manual: true });
      }
      return;
    }
    if (typeof content === "string") {
      pushItem(view, parent, userItem(uuid, at, content, [], []));
      if (!parent) view.turnEnded = false;
      return;
    }
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    const images: string[] = [];
    const attachments: AttachmentChip[] = [];
    /** 网页上选中的元素（<selected-element> 文字块），紧挨在前面的图片是它的截图 */
    const elements: SentResponseAnnotation[] = [];
    let prev: Record<string, unknown> | undefined;
    for (const b of content as Array<Record<string, unknown>>) {
      const before = prev;
      prev = b;
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
        const element = parsed ? null : parseSelectedElement(b.text);
        if (element) {
          const shot = before?.type === "image" ? imageSrc(before) : null;
          if (shot && images.at(-1) === shot) images.pop();
          elements.push(shot && element.element ? { ...element, element: { ...element.element, image: shot } } : element);
        } else if (parsed) attachments.push(...parsed);
        else if (!SKILL_META.test(b.text)) texts.push(b.text);
      }
    }
    if (texts.length || images.length || attachments.length || elements.length) {
      pushItem(view, parent, userItem(uuid, at, texts.join("\n"), images, attachments, elements));
      if (!parent) view.turnEnded = false;
    } else {
      view.seen = new Set(view.seen).add(uuid);
    }
  }
}

/**
 * 压缩的摘要：前面有 compact_boundary 生成的那一项（实时）就把它的 uuid 换成摘要的，之后重新拉历史时按 uuid 去重；
 * 没有就新加一项（历史）
 */
function ingestCompactSummary(view: SessionView, uuid: string, at: number | undefined): void {
  if (view.seen.has(uuid)) return;
  const i = view.items.findLastIndex((it) => it.kind === "compact" && it.awaitingSummary);
  const prev = view.items[i];
  const item: Item = { kind: "compact", uuid, at: prev?.kind === "compact" ? prev.at : at, status: "done", ...(prev?.kind === "compact" && prev.manual ? { manual: true } : {}) };
  if (i < 0) {
    pushItem(view, null, item);
    return;
  }
  view.seen = new Set(view.seen).add(uuid);
  view.items = view.items.with(i, item);
}

/** 正在进行的压缩（还没等到 compact_boundary） */
function runningCompact(view: SessionView): boolean {
  return view.items.some((it) => it.kind === "compact" && it.status === "running");
}

/** 正在进行的压缩结束了：done 之后还要等摘要（换 uuid 用） */
function finishCompact(view: SessionView, status: "done" | "failed"): void {
  const i = view.items.findLastIndex((it) => it.kind === "compact" && it.status === "running");
  const item = view.items[i];
  if (item?.kind !== "compact") return;
  view.items = view.items.with(i, { ...item, status, awaitingSummary: status === "done" });
}

/** 用户消息：末尾带回复注释的拆出来，和网页上选中的元素一起放进 annotations */
function userItem(uuid: string, at: number | undefined, raw: string, images: string[], attachments: AttachmentChip[], elements: SentResponseAnnotation[] = []): Item {
  const split = splitResponseAnnotations(raw);
  const annotations = [...(split?.annotations ?? []), ...elements];
  const text = split ? split.text : raw;
  return annotations.length ? { kind: "user", uuid, at, text, images, attachments, annotations } : { kind: "user", uuid, at, text, images, attachments };
}

/** 用户中断时 Claude Code 写进对话的 user 消息（字符串，或只有一个 text 块） */
const INTERRUPT = /^\[Request interrupted by user( for tool use)?\]$/;
function isInterruptNotice(content: unknown): boolean {
  if (typeof content === "string") return INTERRUPT.test(content.trim());
  if (!Array.isArray(content) || content.length !== 1) return false;
  const b = content[0] as { type?: unknown; text?: unknown };
  return b.type === "text" && typeof b.text === "string" && INTERRUPT.test(b.text.trim());
}

/**
 * 网关拼在用户消息里的 <attachments> 段（见 gateway/src/agent/attachments.ts），每行 "- 路径"；
 * 引用会话导出的文件在 <session-references> 段，每行 "- session:会话 id：路径"，也显示成附件
 */
function parseAttachments(text: string): AttachmentChip[] | null {
  const m = /^<(attachments|session-references)>\n([\s\S]*)\n<\/\1>$/.exec(text.trim());
  if (!m) return null;
  const sessions = m[1] === "session-references";
  return m[2]!
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const path = sessions ? line.slice(2).replace(/^session:[\w-]+：/, "") : line.slice(2);
      return { path, name: path.split(/[\\/]/).pop() || path };
    });
}

/**
 * 实时的任务通知。子代理的 summary 是它的最终回复，不是一句话的说明：
 * 按任务列表或 Agent 调用找到说明，整理成和历史通知一样的 Agent "说明" finished，回复放进 result
 */
function liveTaskItem(view: SessionView, message: { task_id: string; tool_use_id?: string; status: string; summary: string }): TaskItem {
  const item: TaskItem = { kind: "task", uuid: `task:${message.task_id}`, status: message.status, text: message.summary };
  const listed = view.backgroundTasks.find((t) => t.taskId === message.task_id);
  let description = listed?.type === "local_agent" ? listed.description : undefined;
  if (description === undefined && message.tool_use_id) {
    for (const it of view.items) {
      if (it.kind !== "assistant") continue;
      const call = it.blocks.find((b) => b.type === "tool_use" && b.id === message.tool_use_id);
      if (!call || call.type !== "tool_use") continue;
      if (call.name === "Agent" || call.name === "Task") {
        const input = (call.input ?? {}) as { description?: unknown; name?: unknown };
        description = typeof input.description === "string" ? input.description : typeof input.name === "string" ? input.name : "";
      }
      break;
    }
  }
  if (description === undefined) return item;
  return { ...item, text: `Agent "${description}" finished`, ...(message.summary ? { result: message.summary } : {}) };
}

/** 这个工具调用是子代理发出的（在某个子代理的消息里） */
function subagentCall(view: SessionView, toolUseId: string | undefined): boolean {
  if (!toolUseId) return false;
  return Object.values(view.children).some((items) =>
    items.some((it) => it.kind === "assistant" && it.blocks.some((b) => b.type === "tool_use" && b.id === toolUseId)),
  );
}

/** 历史里后台任务完成的通知：Claude Code 用它开始新一轮时存成一条 user 消息，内容是 <task-notification> 段 */
function taskNotification(text: string): TaskItem | null {
  const body = /^<task-notification>([\s\S]*)<\/task-notification>$/.exec(text.trim())?.[1];
  if (body === undefined) return null;
  // 字段里的 & < > 是转义过的
  const field = (name: string) => unescapeXml(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? "");
  const status = field("status");
  // MCP 工具转到后台的任务，通知里带 <result>（结果原文，失败时以「Task failed: 」开头）；失败时拿它显示原因
  const detail = status === "failed" ? field("result").replace(/^Task failed:\s*/, "") || undefined : undefined;
  const summary = field("summary");
  // 子代理的通知：summary 是 Agent "说明" finished，<result> 是它的最终回复
  const result = /^Agent "/.test(summary) ? field("result") : "";
  return { kind: "task", uuid: `task:${field("task-id")}`, status, text: summary, ...(detail && !result ? { detail } : {}), ...(result ? { result } : {}) };
}

const unescapeXml = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** 只有文字的 isSynthetic 消息（不是工具结果、中断、子代理的消息）：Claude Code 自己插给模型的提示 */
function syntheticPrompt(content: unknown): boolean {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Array<{ type?: unknown }>) : [];
  return blocks.length > 0 && blocks.every((b) => b.type === "text") && !isInterruptNotice(content) && !agentMessage(content);
}

/** 其他 agent 发来的消息前面那句（空闲时、进行中、队友、协调者各有一种说法），见 Item 的 agent */
const AGENT_MESSAGE_LEAD = /^(?:(?:Another Claude session|A peer session|The coordinator) sent a message[^:\n]*:|A message arrived from [^:\n]*:)\s*/;

/** 其他 agent 发来的消息：取 <agent-message> 里的正文，后面给模型看的说明不要；不是这种消息返回 null */
function agentMessage(content: unknown): { from: string; text: string } | null {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === "text" && typeof b.text === "string")
        ? content.map((b: { text: string }) => b.text).join("\n")
        : null;
  if (raw === null) return null;
  const rest = raw.trim().replace(AGENT_MESSAGE_LEAD, "");
  if (!rest.startsWith("<agent-message")) return null;
  const parts = [...rest.matchAll(/<agent-message\b([^>]*)>([\s\S]*?)<\/agent-message>/g)];
  if (!parts.length) return null;
  const from = /\bfrom="([^"]*)"/.exec(parts[0]![1]!)?.[1] ?? "";
  return { from, text: parts.map((m) => m[2]!.trim()).join("\n\n") };
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
  // 输出里可能带终端的颜色控制符（/compact 的是 ESC[2mCompacted ESC[22m）
  // eslint-disable-next-line no-control-regex
  if (out) return out[1]!.replace(/\x1b\[[0-9;]*m/g, "").replace(/`/g, "").trim();
  if (/^<(command-name|command-message|local-command-caveat)>/.test(text.trim())) return "";
  return null;
}

/**
 * Anthropic 的 image 块转成能直接放进 <img> 的地址：base64 → data:，url 原样；
 * 历史消息里网关换成取图地址的（HistoryImageSource）加上接口前缀和令牌
 */
function imageSrc(block: unknown): string | null {
  const b = block as { type?: string; source?: { type?: string; media_type?: string; data?: string; url?: string; path?: string } } | null;
  if (b?.type !== "image" || !b.source) return null;
  if (b.source.type === "base64" && b.source.data) return `data:${b.source.media_type ?? "image/png"};base64,${b.source.data}`;
  if (b.source.type === "gateway" && b.source.path) return withToken(b.source.path);
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
/** 最近一轮（最后一条用户消息或后台任务通知之后）是不是已经有了主线程的回复；还没有任何一轮时算有 */
function turnHasReply(view: SessionView): boolean {
  const start = view.items.findLastIndex((i) => i.kind === "user" || i.kind === "task" || i.kind === "agent");
  return start < 0 || view.items.slice(start + 1).some((i) => i.kind === "assistant");
}

function insertBeforeTurn(view: SessionView, item: Item): void {
  if (view.seen.has(item.uuid)) return;
  view.seen = new Set(view.seen).add(item.uuid);
  const start = view.items.findLastIndex((i) => i.kind === "user" || i.kind === "task" || i.kind === "agent");
  view.items = start < 0 ? [...view.items, item] : [...view.items.slice(0, start), item, ...view.items.slice(start)];
}

/** 主线程一轮的开头：用户消息、后台任务通知、其他 agent 发来的消息、空闲时手动压缩 */
function isTurnStart(item: Item): boolean {
  return item.kind === "user" || item.kind === "task" || item.kind === "agent" || (item.kind === "compact" && Boolean(item.manual));
}

function pushItem(view: SessionView, parent: string | null, item: Item): void {
  if (view.seen.has(item.uuid)) return;
  view.seen = new Set(view.seen).add(item.uuid);
  if (parent) {
    view.children = { ...view.children, [parent]: [...(view.children[parent] ?? []), item] };
    return;
  }
  let items = view.items;
  if (isTurnStart(item)) {
    // 上一个开头之后到的 result 都不属于这一轮，记下这一轮的开头（见 Item 的 result）
    for (let i = items.findLastIndex(isTurnStart) + 1; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind === "result" && !it.beforeUuid) items = items.with(i, { ...it, beforeUuid: item.uuid });
    }
  }
  view.items = [...items, item];
}
