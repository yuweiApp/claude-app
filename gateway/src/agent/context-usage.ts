import path from "node:path";
import { config } from "../config.js";
import { readJson, writeJson } from "../json-file.js";
import type { ContextUsage } from "../shared/types.js";

/**
 * 每个会话最后一次取到的上下文用量，记在 claude-home/gateway-context.json：子进程回收、网关重启后输入框的上下文圆环照样有数
 */

interface SessionRecord {
  usage?: ContextUsage;
}

const file = path.join(config.claudeConfigDir, "gateway-context.json");
const { sessions } = readJson<{ sessions: Record<string, SessionRecord> }>(file, { sessions: {} });

function save(): void {
  try {
    writeJson(file, { sessions });
  } catch {
    // 写不了只是重启后没有圆环的数，不影响会话
  }
}

/** 上次记下的用量是刚压缩过、模型还没回复过的（重启子进程后接着这么标，见 ContextUsage.compacted） */
export function compactedSinceReply(sessionId: string): boolean {
  return Boolean(sessions[sessionId]?.usage?.compacted);
}

export function savedUsage(sessionId: string): ContextUsage | null {
  return sessions[sessionId]?.usage ?? null;
}

export function saveUsage(sessionId: string, usage: ContextUsage): void {
  sessions[sessionId] = { usage };
  save();
}

export function forgetSession(sessionId: string): void {
  if (!(sessionId in sessions)) return;
  delete sessions[sessionId];
  save();
}
