import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTask } from "../shared/types.js";

interface TaskRecord extends BackgroundTask {
  /** 任务输出文件（后台 Bash 的 tool_result 或完成通知里给出） */
  outputFile?: string;
  /** 前台任务（比如没放后台的子代理）也会发 task_started，只有放到后台的才列出来 */
  backgrounded: boolean;
}

const MAX_REMEMBERED = 200;
/** 记下的工具结果最多这么多字，免得截图之外的大段页面结构把记录文件撑大 */
const MAX_RESULT_CHARS = 20_000;

/**
 * 一个会话的后台任务（Bash 后台命令、后台子代理等），从 SDK 的 task_* 消息整理出来。
 * SDK 消息里没有时间，开始、结束时间按网关收到的时间记。
 * 跟会话走，不跟子进程走：子进程空闲回收后再 resume，之前的任务记录还在；会话删除时一起丢掉。
 * 记录写在 file 里（有变化时），网关重启后读回来：重启前还在跑的任务跟着旧子进程结束了，记成已停止，记录不删
 */
export class TaskList {
  private readonly tasks = new Map<string, TaskRecord>();
  private saveTimer?: NodeJS.Timeout;
  /** Bash 工具调用的命令：task_started 只带 tool_use_id */
  private readonly commands = new Map<string, string>();
  /** browser_run_code 调用的代码（input.code）：转到后台后 task_started 只带 tool_use_id */
  private readonly codes = new Map<string, string>();
  /** 转到了后台的工具调用（tool_use_id）：结果里写着 moved to the background */
  private readonly backgroundedCalls = new Map<string, true>();
  /** 工具调用发出的时间：跑久了才转到后台的（MCP 调用跑满 20 秒），开始时间按调用发出时算，不按转后台的时候 */
  private readonly toolStarts = new Map<string, number>();
  /**
   * 最近一条 background_tasks_changed 里的任务（SDK 说它是当前所有在跑的后台任务的完整列表）。
   * 转到后台的 MCP 调用（mcp_task，比如 browser_run_code 跑满 20 秒）发的 task_started 不带 is_backgrounded，
   * 只靠它认出来；它比 task_started 先到，所以记着，task_started 时再查
   */
  private liveBackground = new Set<string>();

  constructor(private readonly file?: string) {
    if (!file) return;
    let saved: TaskRecord[] = [];
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as TaskRecord[];
    } catch {
      return;
    }
    const now = Date.now();
    for (const task of saved) {
      if (task.status === "running") {
        task.status = "stopped";
        task.endedAt = now;
      }
      this.tasks.set(task.taskId, task);
    }
  }

  /** 处理一条 SDK 消息，任务列表有变化时返回 true */
  ingest(message: SDKMessage): boolean {
    return this.changed(this.ingestMessage(message));
  }

  /** 转到后台的网关工具调用结束：记下结果原文（SDK 的通知里只有工具名） */
  setResult(taskId: string, text: string, isError: boolean): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.result = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…（后面还有 ${text.length - MAX_RESULT_CHARS} 字）` : text;
    task.resultIsError = isError;
    return this.changed(true);
  }

  /** 会话删除时删掉记录文件 */
  dispose(): void {
    clearTimeout(this.saveTimer);
    if (this.file) rmSync(this.file, { force: true });
  }

  private changed(changed: boolean): boolean {
    if (changed && this.file && !this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        const file = this.file!;
        mkdirSync(path.dirname(file), { recursive: true });
        void writeFile(file, JSON.stringify([...this.tasks.values()])).catch(() => undefined);
      }, 300);
    }
    return changed;
  }

  private ingestMessage(message: SDKMessage): boolean {
    switch (message.type) {
      case "assistant":
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            remember(this.toolStarts, block.id, Date.now());
            const code = (block.input as { code?: unknown } | null)?.code;
            if (typeof code === "string") remember(this.codes, block.id, code);
          }
          if (block.type === "tool_use" && block.name === "Bash") {
            const command = (block.input as { command?: unknown }).command;
            if (typeof command === "string") remember(this.commands, block.id, command);
          }
        }
        return false;
      case "user":
        return this.ingestToolResults(message.message.content);
      case "system":
        return this.ingestSystem(message);
      default:
        return false;
    }
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.backgrounded)
      .map(({ outputFile, backgrounded: _, ...task }) => ({ ...task, hasOutput: Boolean(outputFile) && task.type === "local_bash" }));
  }

  outputFile(taskId: string): string | undefined {
    const task = this.tasks.get(taskId);
    return task?.type === "local_bash" ? task.outputFile : undefined;
  }

  /** 清掉已经结束的任务（界面上的「清除」） */
  clearFinished(): boolean {
    let changed = false;
    for (const [id, task] of this.tasks) {
      if (task.status !== "running") changed = this.tasks.delete(id) || changed;
    }
    return this.changed(changed);
  }

  /** 子进程退出时它拉起的后台任务也跟着结束 */
  processExited(): boolean {
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.status = "stopped";
      task.endedAt = Date.now();
      changed = true;
    }
    return this.changed(changed);
  }

  private ingestSystem(message: Extract<SDKMessage, { type: "system" }>): boolean {
    switch (message.subtype) {
      case "task_started": {
        // ambient：不算活动的任务（监视器之类），skip_transcript 的也不进对话，都不列
        if (message.ambient || message.skip_transcript) return false;
        const task = this.ensure(message.task_id, message.tool_use_id, message.description, message.task_type);
        if (task.status !== "running") {
          // 结束过又开始（恢复的子代理）：重新算一次
          Object.assign(task, { status: "running", startedAt: Date.now(), endedAt: undefined, summary: undefined, result: undefined, resultIsError: undefined, exitCode: undefined });
        }
        if (message.is_backgrounded || this.liveBackground.has(message.task_id)) task.backgrounded = true;
        return true;
      }
      case "background_tasks_changed": {
        // 完整的在跑列表（SDK 说 task_started 这类边沿消息可能漏掉，以它为准）：没登记过的也补上
        const live = message.tasks.filter((t) => !t.ambient);
        this.liveBackground = new Set(live.map((t) => t.task_id));
        let changed = false;
        for (const t of live) {
          const known = this.tasks.get(t.task_id);
          if (known?.backgrounded) continue;
          this.ensure(t.task_id, undefined, t.description, t.task_type).backgrounded = true;
          changed = true;
        }
        return changed;
      }
      case "task_updated": {
        const task = this.tasks.get(message.task_id);
        if (!task) return false;
        const { status, description, end_time, is_backgrounded } = message.patch;
        if (status === "completed" || status === "failed") task.status = status;
        else if (status === "killed") task.status = "stopped";
        if (end_time) task.endedAt = end_time;
        if (description) task.description = description;
        if (is_backgrounded !== undefined) task.backgrounded = is_backgrounded;
        return true;
      }
      case "task_notification": {
        // 没收到过开始消息的，按通知补上（转到后台的工具调用，tool_use_id 对得上调用发出的时间和代码）
        if (message.skip_transcript) return false;
        const known = this.tasks.get(message.task_id);
        const task = known ?? this.ensure(message.task_id, message.tool_use_id, message.summary);
        if (!known && (this.liveBackground.has(message.task_id) || (message.tool_use_id && this.backgroundedCalls.has(message.tool_use_id)))) {
          task.backgrounded = true;
        }
        task.status = message.status;
        task.summary = message.summary;
        task.outputFile = message.output_file || task.outputFile;
        task.endedAt ??= Date.now();
        const exit = /exit code (-?\d+)/.exec(message.summary);
        if (exit) task.exitCode = Number(exit[1]);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * 登记一个任务（已经有了就补上缺的字段，不改状态）。开始时间按工具调用发出的时间，没有就是现在
   */
  private ensure(taskId: string, toolUseId: string | undefined, description: string, type?: string): TaskRecord {
    let task = this.tasks.get(taskId);
    if (!task) {
      task = { taskId, description, status: "running", startedAt: Date.now(), hasOutput: false, backgrounded: false };
      this.tasks.set(taskId, task);
    }
    if (type) task.type ??= type;
    if (toolUseId && !task.toolUseId) {
      task.toolUseId = toolUseId;
      task.startedAt = this.toolStarts.get(toolUseId) ?? task.startedAt;
      task.command ??= this.commands.get(toolUseId);
      task.code ??= this.codes.get(toolUseId);
    }
    return task;
  }

  /**
   * 工具调用的结果：
   * - 跑久了转到后台的 MCP 调用先返回「… was moved to the background as task <id> …」，据此登记（不依赖 task_started）；
   * - 放到后台的 Bash 立即返回一条 tool_result，里面写着输出文件路径（…/tasks/<task_id>.output），运行中就能看输出
   */
  private ingestToolResults(content: unknown): boolean {
    if (!Array.isArray(content)) return false;
    let changed = false;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      // 结果是内容块数组时按原文找（JSON 里的引号被转义了）
      const plain = Array.isArray(block.content)
        ? (block.content as Array<{ type?: unknown; text?: unknown }>).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("\n")
        : text;
      const moved = /MCP tool "([^"]+)" is still running[\s\S]*?moved to the background as task (\w+)/.exec(plain);
      if (moved && typeof block.tool_use_id === "string") {
        remember(this.backgroundedCalls, block.tool_use_id, true);
        const task = this.ensure(moved[2]!, block.tool_use_id, moved[1]!, "mcp_task");
        if (!task.backgrounded) {
          task.backgrounded = true;
          changed = true;
        }
      }
      const task = [...this.tasks.values()].find((t) => t.toolUseId === block.tool_use_id && !t.outputFile);
      if (!task) continue;
      const file = new RegExp(`(/[^\\s"'\\\\]*${task.taskId}\\.output)`).exec(text)?.[1];
      if (file) {
        task.outputFile = file;
        changed = true;
      }
    }
    return changed;
  }
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value!);
}

/** 读输出文件的最后一段（运行中的任务文件还在增长） */
export async function readOutputTail(file: string, maxBytes = 64 * 1024): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8"), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
