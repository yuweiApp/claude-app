import { open } from "node:fs/promises";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTask } from "../shared/types.js";

interface TaskRecord extends BackgroundTask {
  /** 任务输出文件（后台 Bash 的 tool_result 或完成通知里给出） */
  outputFile?: string;
  /** 前台任务（比如没放后台的子代理）也会发 task_started，只有放到后台的才列出来 */
  backgrounded: boolean;
}

const MAX_REMEMBERED = 200;

/**
 * 一个会话的后台任务（Bash 后台命令、后台子代理等），从 SDK 的 task_* 消息整理出来。
 * SDK 消息里没有时间，开始、结束时间按网关收到的时间记。
 * 跟会话走，不跟子进程走：子进程空闲回收后再 resume，之前的任务记录还在；会话删除时一起丢掉
 */
export class TaskList {
  private readonly tasks = new Map<string, TaskRecord>();
  /** Bash 工具调用的命令：task_started 只带 tool_use_id */
  private readonly commands = new Map<string, string>();

  /** 处理一条 SDK 消息，任务列表有变化时返回 true */
  ingest(message: SDKMessage): boolean {
    switch (message.type) {
      case "assistant":
        for (const block of message.message.content) {
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
    return changed;
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
    return changed;
  }

  private ingestSystem(message: Extract<SDKMessage, { type: "system" }>): boolean {
    switch (message.subtype) {
      case "task_started": {
        // ambient：不算活动的任务（监视器之类），skip_transcript 的也不进对话，都不列
        if (message.ambient || message.skip_transcript) return false;
        const existing = this.tasks.get(message.task_id);
        this.tasks.set(message.task_id, {
          taskId: message.task_id,
          toolUseId: message.tool_use_id,
          type: message.task_type,
          description: message.description,
          command: message.tool_use_id ? this.commands.get(message.tool_use_id) : undefined,
          status: "running",
          startedAt: Date.now(),
          hasOutput: false,
          outputFile: existing?.outputFile,
          backgrounded: Boolean(message.is_backgrounded),
        });
        return true;
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
        const task = this.tasks.get(message.task_id);
        if (!task) return false;
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

  /** 放到后台的 Bash 立即返回一条 tool_result，里面写着输出文件路径（…/tasks/<task_id>.output），运行中就能看输出 */
  private ingestToolResults(content: unknown): boolean {
    if (!Array.isArray(content)) return false;
    let changed = false;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      const task = [...this.tasks.values()].find((t) => t.toolUseId === block.tool_use_id && !t.outputFile);
      if (!task) continue;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      const file = new RegExp(`(/[^\\s"'\\\\]*${task.taskId}\\.output)`).exec(text)?.[1];
      if (file) {
        task.outputFile = file;
        changed = true;
      }
    }
    return changed;
  }
}

function remember(map: Map<string, string>, key: string, value: string): void {
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
