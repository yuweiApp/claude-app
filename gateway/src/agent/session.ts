import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { EventHub } from "../events/event-hub.js";
import type { ConversationLog } from "../logging/conversation-log.js";
import type { Attachment, GatewayEvent, SessionState } from "../shared/types.js";
import { buildUserContent } from "./attachments.js";
import { InputQueue } from "./input-queue.js";
import { listModels } from "./models.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { BrowserHost } from "../browser/host.js";
import { inappBusy, takeToolResult } from "../browser/tool.js";
import { desktopWriteActive } from "../desktop/guard.js";
import { DESKTOP_RUN_TOOL, describeRun, isReadOnlyRun } from "../desktop/tool.js";
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
  /**
   * AskUserQuestion 的回答：问题原文 → 选中的选项（多选用逗号连接，「其他」是用户写的文字）。
   * 放进 updatedInput.answers 交还 Claude Code，模型读到的就是这些
   */
  answers?: Record<string, string>;
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
  /** 主线程里已经发出、还没拿到结果的工具调用（tool_use 的 id），决定插话用不用 priority now（见 send） */
  private readonly toolsInFlight = new Set<string>();
  /**
   * 这一轮里有转到后台的浏览器工具调用结束了：它的结果会在下一轮交给模型，模型多半还要接着用那个标签页，
   * 所以这一轮结束时先不关内置浏览器的临时标签页，等下一轮结束再关（实测：任务在这一轮结束前 3 秒失败，标签页被关，
   * 下一轮模型接着用 page 时它已经是 undefined）
   */
  private browserTaskEnded = false;
  private readonly done: Promise<void>;
  private closing = false;

  constructor(
    readonly id: string,
    opts: { resume: boolean; cwd: string; model?: string; effort?: EffortLevel; permissionMode: PermissionMode; skills?: string[] },
    private readonly hub: EventHub,
    private readonly log: FastifyBaseLogger,
    private readonly conversationLog: ConversationLog,
    private readonly tasks: TaskList,
    private readonly onClosed: (session: AgentSession) => void,
    terminals?: TerminalManager,
    private readonly browser?: BrowserHost,
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
        skills: opts.skills,
        canUseTool: this.canUseTool,
        terminals,
        browser,
        onDesktopTarget: (target) => this.publish({ type: "desktop_target", target }),
        abortController: this.abortController,
        stderr: (data) => this.log.debug({ sessionId: id, stderr: data.trimEnd() }, "claude stderr"),
      }),
    });
    this.done = this.consume();
  }

  async send(text: string, attachments: Attachment[] = []): Promise<string> {
    const uuid = randomUUID();
    const content = await buildUserContent(text, attachments);
    const now = this.state === "running" && this.toolsInFlight.size > 0 && this.pending.size === 0;
    // 这一轮还在进行时发的，不管 now 还是 next，都要等 Claude Code 交给模型（command_lifecycle started）才知道落在哪里：
    // next 在下一次工具结果之后并进这一轮，或这一轮结束后开始下一轮；now 有时并进这一轮，有时先结束这一轮
    // （result 的 stop_reason 是 tool_use）再用它开始新的一轮（实测两种都有）
    const queued = this.state === "running";
    this.input.push({
      type: "user",
      uuid,
      message: { role: "user", content },
      parent_tool_use_id: null,
      // 用户在网页里输入的：不标时 Claude Code 当作来源不明，严格的 isHuman() 检查会拒绝
      origin: { kind: "human" },
      // 有工具调用正在跑时插话用 now：调用（如等网页结果的 browser_run_code）提前转到后台、不打断，消息马上送到模型，
      // 调用跑完后结果以通知送回来。模型正在生成文字时 now 会打断它（实测写到一半的回答直接丢了），等权限确认时也不用，
      // 这两种情况用 next：不打断（实测写到一半的 952 字回答照常写完），下一次工具结果之后送到，没有工具调用了就等这一轮结束。
      // 以前用 later，要等整轮结束才送到。空闲时消息本来就立刻开始新的一轮
      ...(now ? { priority: "now" as const } : this.state === "running" ? { priority: "next" as const } : {}),
    });
    // 放进队列的：网页先把它显示在最后，这一轮剩下的回复排在它上面，SDK 的 command_lifecycle started（交给模型了）到了再固定位置
    this.publish({ type: "user_message", uuid, content, ...(queued ? { queued: true } : {}) });
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
    // 桌面工具正在操作（或刚操作完）时收到的「允许」不算数：可能是模型经无障碍接口点的，网页版开在用户自己的浏览器里时
    // 按进程号拦不住（见 docs/agent-desktop.md 6.2）。卡片留着，用户再点一次；「拒绝」照常生效
    if (reply.behavior === "allow" && desktopWriteActive()) {
      throw Object.assign(new Error("这次确认发生在 AI 操作桌面期间，没有生效，请再点一次"), { statusCode: 409 });
    }
    if (reply.behavior === "allow") {
      this.resolvePermission(requestId, {
        behavior: "allow",
        updatedInput: reply.answers ? { ...pending.input, answers: reply.answers } : pending.input,
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
    const desktopRun = toolName === DESKTOP_RUN_TOOL;
    // 桌面工具 run 的只读命令（find、list-windows、--help 等）不用确认
    if (desktopRun && Array.isArray(input.args) && isReadOnlyRun(input.args.map(String))) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
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
        title: desktopRun ? "允许执行这条桌面操作？" : options.title,
        // 桌面操作：命令行、ref 指向哪个应用的哪个元素、headed 时会动鼠标
        description: desktopRun ? describeRun(input) : options.description,
        decisionReason: options.decisionReason,
        // 桌面操作不给「总是允许」：规则按工具名放行，放行了就是这个会话以后的所有桌面操作；
        // AskUserQuestion 是向用户提问（网页渲染成选择题），每次都要回答，也不给
        canAlways: Boolean(options.suggestions?.length) && !options.suppressAlwaysAllowRule && !desktopRun && toolName !== "AskUserQuestion",
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

  /** 记主线程里在跑的工具调用：assistant 消息里的 tool_use 加进来，对应的 tool_result 回来（含转后台的占位结果）或一轮结束时去掉 */
  private trackTools(message: SDKMessage): void {
    if (message.type === "result") {
      this.toolsInFlight.clear();
      return;
    }
    if ((message.type !== "assistant" && message.type !== "user") || message.parent_tool_use_id !== null) return;
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (message.type === "assistant" && block.type === "tool_use") this.toolsInFlight.add(block.id);
      if (message.type === "user" && block.type === "tool_result") this.toolsInFlight.delete(block.tool_use_id);
    }
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
        this.trackTools(message);
        let tasksChanged = this.tasks.ingest(message);
        this.publish({ type: "sdk", message });
        // 转到后台的浏览器工具调用结束了：把结果原文补发给网页（通知里只有工具名），失败时显示原因
        if (message.type === "system" && message.subtype === "task_notification" && message.tool_use_id) {
          const result = takeToolResult(message.tool_use_id);
          if (result) {
            this.publish({ type: "task_result", taskId: message.task_id, text: result.text, isError: result.isError });
            tasksChanged = this.tasks.setResult(message.task_id, result.text, result.isError) || tasksChanged;
            this.browserTaskEnded = true;
          }
        }
        if (tasksChanged) this.publish({ type: "tasks", tasks: this.tasks.list() });
        if (message.type === "result") {
          this.setState("idle");
          // 一轮结束：内置浏览器关掉 AI 开的、没留下的临时标签页。还有转到后台的代码在跑（inappBusy），
          // 或者这一轮里有后台浏览器任务结束了（browserTaskEnded），先不关
          const deferred = inappBusy(this.id) || this.browserTaskEnded;
          this.browserTaskEnded = false;
          if (!deferred) this.browser?.turnEnded(this.id);
        }
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
