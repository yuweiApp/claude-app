import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { EventHub } from "../events/event-hub.js";
import type { ConversationLog } from "../logging/conversation-log.js";
import type { Attachment, GatewayEvent, SessionState } from "../shared/types.js";
import { buildUserContent } from "./attachments.js";
import { InputQueue } from "./input-queue.js";
import { listModels } from "./models.js";
import { buildOptions } from "./options.js";
import type { TaskList } from "./tasks.js";

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  timer: NodeJS.Timeout;
}

export interface PermissionReply {
  behavior: "allow" | "deny";
  message?: string;
  /** 以后同类操作都允许（采用 SDK 给的 suggestions） */
  always?: boolean;
}

/** 一个活跃会话：持有一个 claude 子进程，见 docs/README.md「活跃会话」 */
export class AgentSession {
  state: SessionState = "starting";
  model: string | undefined;
  effort: EffortLevel | undefined;
  readonly cwd: string;
  permissionMode: PermissionMode;
  lastActiveAt = Date.now();

  private readonly input = new InputQueue();
  private readonly abortController = new AbortController();
  private readonly query: Query;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly done: Promise<void>;
  private closing = false;

  constructor(
    readonly id: string,
    opts: { resume: boolean; cwd: string; model?: string; effort?: EffortLevel; permissionMode: PermissionMode },
    private readonly hub: EventHub,
    private readonly log: FastifyBaseLogger,
    private readonly conversationLog: ConversationLog,
    private readonly tasks: TaskList,
    private readonly onClosed: (session: AgentSession) => void,
  ) {
    this.model = opts.model ?? config.model;
    this.effort = opts.effort;
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
    this.query = query({
      prompt: this.input,
      options: buildOptions({
        sessionId: id,
        cwd: opts.cwd,
        resume: opts.resume,
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
        canUseTool: this.canUseTool,
        abortController: this.abortController,
        stderr: (data) => this.log.debug({ sessionId: id, stderr: data.trimEnd() }, "claude stderr"),
      }),
    });
    this.done = this.consume();
  }

  async send(text: string, attachments: Attachment[] = []): Promise<string> {
    const uuid = randomUUID();
    const content = await buildUserContent(text, attachments);
    this.input.push({
      type: "user",
      uuid,
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    this.publish({ type: "user_message", uuid, content });
    this.setState("running");
    return uuid;
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt();
  }

  /** 停止后台任务，之后 SDK 会发 status 为 stopped 的 task_notification */
  async stopTask(taskId: string): Promise<void> {
    await this.query.stopTask(taskId);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.query.setPermissionMode(mode);
    this.permissionMode = mode;
    this.publishState();
  }

  /** model 是模型列表里的 value（default / opus 等别名），记下的是它解析出的实际模型名，和 init 消息里的一致 */
  async setModel(model: string | undefined): Promise<void> {
    await this.query.setModel(model);
    const info = model ? (await listModels().catch(() => [])).find((m) => m.value === model) : undefined;
    this.model = info?.resolvedModel?.replace(/\[1m\]$/i, "") ?? model ?? config.model;
    this.publishState();
  }

  /** 推理强度：Query.applyFlagSettings({ effortLevel })，null 回到模型默认 */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.query.applyFlagSettings({ effortLevel: effort });
    this.effort = effort ?? undefined;
    this.publishState();
  }

  replyPermission(requestId: string, reply: PermissionReply): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if (reply.behavior === "allow") {
      this.resolvePermission(requestId, {
        behavior: "allow",
        updatedInput: pending.input,
        ...(reply.always && pending.suggestions ? { updatedPermissions: pending.suggestions } : {}),
      });
    } else {
      this.resolvePermission(requestId, { behavior: "deny", message: reply.message || "用户拒绝了这次操作" });
    }
    return true;
  }

  /** 结束输入，等子进程退出 */
  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.closing = true;
    this.input.close();
    this.query.close();
    await this.done;
  }

  private canUseTool: CanUseTool = (toolName, input, options) => {
    const requestId = randomUUID();
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(
        () => this.resolvePermission(requestId, { behavior: "deny", message: "等待确认超时，已自动拒绝" }),
        config.permissionTimeoutMs,
      );
      this.pending.set(requestId, { resolve, input, suggestions: options.suggestions, timer });
      options.signal.addEventListener(
        "abort",
        () => this.resolvePermission(requestId, { behavior: "deny", message: "已取消" }),
        { once: true },
      );
      this.publish({
        type: "permission_request",
        requestId,
        toolName,
        toolUseId: options.toolUseID,
        input,
        title: options.title,
        description: options.description,
        decisionReason: options.decisionReason,
        canAlways: Boolean(options.suggestions?.length) && !options.suppressAlwaysAllowRule,
      });
    });
  };

  private resolvePermission(requestId: string, result: PermissionResult): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
    this.publish({ type: "permission_resolved", requestId, behavior: result.behavior });
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.lastActiveAt = Date.now();
        if (message.type === "system" && message.subtype === "init") {
          this.model = message.model;
          this.permissionMode = message.permissionMode;
          if (this.state === "starting") this.setState("idle");
          else this.publishState();
        }
        // 排队的消息可能在上一轮的 result 之后直接开始下一轮
        if ((message.type === "assistant" || message.type === "stream_event") && this.state === "idle") {
          this.setState("running");
        }
        const tasksChanged = this.tasks.ingest(message);
        this.publish({ type: "sdk", message });
        if (tasksChanged) this.publish({ type: "tasks", tasks: this.tasks.list() });
        if (message.type === "result") this.setState("idle");
      }
    } catch (err) {
      if (!this.closing && !this.abortController.signal.aborted) {
        const text = err instanceof Error ? err.message : String(err);
        this.log.error({ sessionId: this.id, err }, "claude 会话异常结束");
        this.publish({ type: "error", message: text });
      }
    } finally {
      for (const requestId of [...this.pending.keys()]) {
        this.resolvePermission(requestId, { behavior: "deny", message: "会话已结束" });
      }
      if (this.tasks.processExited()) this.publish({ type: "tasks", tasks: this.tasks.list() });
      this.setState("closed");
      this.onClosed(this);
    }
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.lastActiveAt = Date.now();
    this.publishState();
  }

  private publishState(): void {
    this.publish({ type: "state", state: this.state, model: this.model, effort: this.effort, permissionMode: this.permissionMode });
  }

  private publish(event: GatewayEvent): void {
    this.hub.publish(this.id, event);
    this.conversationLog.record(this.id, event);
  }
}
