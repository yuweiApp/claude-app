import { stat } from "node:fs/promises";
import path from "node:path";
import type { GoalState, GoalStatusRecord } from "../shared/types.js";
import { sessionRecordDir } from "./scratch.js";
import { scanBackwards } from "./session-records.js";
import { BadRequestError } from "../errors.js";

/**
 * 会话的目标（Claude Code 的 /goal，见 docs/README.md「目标」）。
 * Claude Code 在 SDK 里不发目标状态（active_goal 只在它自己的云端环境里发），网关按它的输出和会话记录自己跟踪：
 * 设定、取消看 /goal 的输出，检查没通过看交给模型的反馈，达成、失败只写在会话记录里（goal_status）
 */

/** 条件最多这么多字（Claude Code 的上限） */
export const GOAL_MAX_LENGTH = 4000;
/** /goal 后面跟这些词是取消（不分大小写），和 Claude Code 认的一样 */
const CLEAR_WORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/**
 * 网页填的条件整理成 /goal 的参数：换行和连续空白合成一个空格（命令参数是一行）。
 * 空的、太长的、正好是取消用的词的，报 400
 */
export function goalCondition(text: string): string {
  const condition = text.replace(/\s+/g, " ").trim();
  if (!condition) throw new BadRequestError("目标条件不能为空");
  if (condition.length > GOAL_MAX_LENGTH) throw new BadRequestError(`目标条件最多 ${GOAL_MAX_LENGTH} 个字（现在 ${condition.length} 个）`);
  if (CLEAR_WORDS.has(condition.toLowerCase())) throw new BadRequestError(`「${condition}」是取消目标用的词，不能当条件`);
  return condition;
}

/** /goal 的输出（Claude Code 发的 model 为 <synthetic> 的 assistant 消息）：设定了、取消了、本来就没有、查看状态 */
export type GoalOutput = { kind: "set"; condition: string } | { kind: "cleared" } | { kind: "none" } | { kind: "status" };

export function goalOutput(text: string): GoalOutput | null {
  const set = /^Goal set: ([\s\S]+)$/.exec(text);
  if (set) return { kind: "set", condition: set[1]!.trim() };
  if (text.startsWith("Goal cleared: ")) return { kind: "cleared" };
  if (text.startsWith("No goal set")) return { kind: "none" };
  if (text.startsWith("Goal active: ")) return { kind: "status" };
  return null;
}

/** 检查没通过时交给模型的反馈（isSynthetic 的 user 消息）「Stop hook feedback:\n[条件]: 理由」里的理由；不是这个目标的返回 undefined */
export function goalFeedback(text: string, condition: string): string | undefined {
  const prefix = `Stop hook feedback:\n[${condition}]: `;
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : undefined;
}

/** 会话记录里的一行 goal_status */
export interface GoalStatusEntry {
  uuid: string;
  /** 记录的时间（毫秒） */
  at: number;
  status: GoalStatusRecord;
}

/** 会话记录里的一行（已经解析的）是主线程的 goal_status 附件时取出来 */
export function goalStatusEntry(entry: unknown): GoalStatusEntry | undefined {
  const e = entry as { type?: unknown; uuid?: unknown; timestamp?: unknown; isSidechain?: unknown; attachment?: { type?: unknown; condition?: unknown } } | null;
  if (e?.type !== "attachment" || e.isSidechain || e.attachment?.type !== "goal_status") return undefined;
  if (typeof e.uuid !== "string" || typeof e.attachment.condition !== "string") return undefined;
  const { type: _type, ...status } = e.attachment as GoalStatusRecord & { type: string };
  const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
  return { uuid: e.uuid, at: Number.isNaN(at) ? Date.now() : at, status };
}

function goalLine(line: string): GoalStatusEntry | undefined {
  if (!line.includes('"goal_status"')) return undefined;
  try {
    return goalStatusEntry(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** 会话记录里的目标：现在的目标（没有是 null），和最后一行 goal_status */
export interface RecordedGoal {
  goal: GoalState | null;
  last?: GoalStatusEntry;
}

/** 按文件大小、修改时间缓存，键是文件路径 */
const cache = new Map<string, { size: number; mtimeMs: number; result: RecordedGoal }>();

/**
 * 从会话记录读目标：最后一行 goal_status 不是达成、失败、取消，目标就还在（Claude Code resume 时也这样恢复目标）。
 * 往前数到设定那一行为止，中间没通过的检查就是 checks。没有目标的会话要读完整个文件，结果按文件缓存
 */
export async function readRecordedGoal(file: string): Promise<RecordedGoal> {
  const info = await stat(file).catch(() => undefined);
  if (!info) return { goal: null };
  const hit = cache.get(file);
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.result;
  let last: GoalStatusEntry | undefined;
  const checks: GoalStatusEntry[] = [];
  const start = await scanBackwards(
    file,
    info.size,
    (line) => {
      const entry = goalLine(line);
      if (!entry) return undefined;
      last ??= entry;
      if (entry.status.sentinel || entry.status.met || entry.status.failed) return entry;
      checks.push(entry);
      return undefined;
    },
    Number.POSITIVE_INFINITY,
  ).catch(() => undefined);
  const active = last && !last.status.met && !last.status.failed;
  const result: RecordedGoal = {
    goal: active
      ? {
          condition: last!.status.condition,
          checks: checks.length,
          ...(checks[0]?.status.reason ? { lastReason: checks[0].status.reason } : {}),
          ...(start?.status.sentinel ? { setAt: start.at } : {}),
        }
      : null,
    ...(last ? { last } : {}),
  };
  cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, result });
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  return result;
}

/** 按会话 id 找记录文件读目标；远程会话读的是同步到本机的副本 */
export async function recordedGoal(sessionId: string): Promise<RecordedGoal> {
  const dir = await sessionRecordDir(sessionId);
  return dir ? readRecordedGoal(path.join(dir, `${sessionId}.jsonl`)) : { goal: null };
}
