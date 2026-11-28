import { readFile } from "node:fs/promises";
import { getSessionMessages, type SessionMessage, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { HistoryImageSource } from "../shared/types.js";
import { goalStatusEntry, type GoalStatusEntry } from "./goal.js";
import { FileCache, sessionRecordFile } from "./session-records.js";
import { mcpAppsEnabled } from "../config-file.js";

/** 最近读过的几个会话的结果 */
const cache = new FileCache<SessionMessage[]>(4);

/**
 * 会话的历史消息，给网页显示用。返回的数组可能是缓存里的同一个，调用方不要改它。
 * getSessionMessages 从最新一条消息顺着 parentUuid 往前找，到压缩上下文的分界（system/compact_boundary，parentUuid 为空）就停了，
 * 压缩前的消息读不到（会话文件里都还在）。所以每个分界前面那段再单独读一次：把会话文件截到分界之前，通过 sessionStore 交给
 * getSessionMessages，读到的就是压缩前那一刻的对话（它自己再往前若有分界，也到那里为止）。各段按时间先后接起来。
 * 压缩时保留下来的最近几条消息，在压缩前那段末尾和摘要后面各出现一次，按 uuid 只留前面的。
 * 会话文件只读、只解析一遍，各段都从解析好的内容里取
 */
export async function sessionHistory(sessionId: string): Promise<SessionMessage[]> {
  const file = await sessionRecordFile(sessionId);
  return (file ? await cache.get(file, () => readHistory(sessionId, file)) : undefined) ?? getSessionMessages(sessionId);
}

async function readHistory(sessionId: string, file: string): Promise<SessionMessage[]> {
  const text = await readFile(file, "utf8");
  const entries: SessionStoreEntry[] = [];
  const boundaries: number[] = [];
  const goals: GoalStatusEntry[] = [];
  /** MCP 工具结果的原始 structuredContent、_meta（会话文件里那一行的 mcpMeta），按消息 uuid */
  const mcpMetas = new Map<string, unknown>();
  /** 用户这次请求选择的模型（会话文件里 assistant 行的 requestedModel）；getSessionMessages 会丢掉这个字段 */
  const requestedModels = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionStoreEntry;
      if (entry.type === "system" && entry.subtype === "compact_boundary") boundaries.push(entries.length);
      const goal = entry.type === "attachment" ? goalStatusEntry(entry) : undefined;
      if (goal && !goal.status.sentinel) goals.push(goal);
      const mcpMeta = (entry as { mcpMeta?: unknown }).mcpMeta;
      if (mcpAppsEnabled && mcpMeta && typeof mcpMeta === "object" && typeof entry.uuid === "string") mcpMetas.set(entry.uuid, mcpMeta);
      const requestedModel = (entry as { requestedModel?: unknown; requested_model?: unknown }).requestedModel ?? (entry as { requested_model?: unknown }).requested_model;
      if (entry.type === "assistant" && typeof entry.uuid === "string" && typeof requestedModel === "string") requestedModels.set(entry.uuid, requestedModel);
      entries.push(entry);
    } catch {
      // 写到一半的行（会话正在运行）跳过
    }
  }

  const read = (list: SessionStoreEntry[]) => getSessionMessages(sessionId, { sessionStore: { append: async () => {}, load: async () => list } });
  const segments: SessionMessage[][] = [];
  for (const end of boundaries) segments.push(await read(entries.slice(0, end)));
  segments.push(await read(entries));

  const seen = new Set<string>();
  const messages = segments.flat().filter((m) => !seen.has(m.uuid) && seen.add(m.uuid));
  // MCP Apps 的界面要工具结果的 structuredContent、_meta：getSessionMessages 不返回会话文件里的 mcpMeta，补成 mcp_meta（只在开了 mcpApps 时）
  // requestedModel 同理：代理可能把实际请求映射到另一个上游模型，message.model 不能代表用户选择的模型。
  const withMeta = messages.map((m) => {
    const meta = mcpAppsEnabled && mcpMetas.has(m.uuid) ? { mcp_meta: mcpMetas.get(m.uuid) } : {};
    const requestedModel = requestedModels.get(m.uuid);
    return Object.keys(meta).length || requestedModel ? { ...m, ...meta, ...(requestedModel ? { requestedModel } : {}) } : m;
  });
  return withGoalStatus(sessionId, withMeta, goals);
}

/**
 * 目标的检查结果（没通过、达成、判定做不到）是会话记录里的 goal_status 附件，getSessionMessages 不返回：
 * 转成 type 为 system 的消息（message 是 { type: "goal_status", ...GoalStatusRecord }），按时间插进去。
 * 设定、取消不用：消息里有 /goal 命令本身的记录
 */
function withGoalStatus(sessionId: string, messages: SessionMessage[], goals: GoalStatusEntry[]): SessionMessage[] {
  if (!goals.length) return messages;
  const out: SessionMessage[] = [];
  const toMessage = (g: GoalStatusEntry) =>
    ({
      type: "system",
      uuid: g.uuid,
      session_id: sessionId,
      message: { type: "goal_status", ...g.status },
      parent_tool_use_id: null,
      parent_agent_id: null,
      timestamp: new Date(g.at).toISOString(),
    }) as SessionMessage;
  let next = 0;
  for (const m of messages) {
    const at = Date.parse((m as { timestamp?: string }).timestamp ?? "");
    while (next < goals.length && goals[next]!.at < at) out.push(toMessage(goals[next++]!));
    out.push(m);
  }
  while (next < goals.length) out.push(toMessage(goals[next++]!));
  return out;
}

/** 网页显示用的历史，按 sessionHistory 返回的数组缓存（缓存命中时是同一个数组） */
const slimmed = new WeakMap<SessionMessage[], SessionMessage[]>();

type Block = Record<string, unknown>;

/**
 * 给网页显示的历史（GET /sessions/:id/messages）：
 * - base64 图片换成取图地址（source 是 HistoryImageSource，见 shared/types.ts），图片单独走 GET /sessions/:id/images/:uuid/:key。
 *   截图、贴图往往占了历史的大半体积，<img> 按需加载
 * - 思考块的内容清空：网页不显示。块本身留着，内容块的序号和实时事件里的一样
 * 不改 messages 里的对象，只复制改到的消息
 */
export function historyForDisplay(sessionId: string, messages: SessionMessage[]): SessionMessage[] {
  const hit = slimmed.get(messages);
  if (hit) return hit;
  const out = messages.map((m) => {
    const message = m.message as { content?: unknown } | null;
    if (!message || !Array.isArray(message.content)) return m;
    let changed = false;
    const content = (message.content as Block[]).map((b, i) => {
      const next = slimBlock(sessionId, m.uuid, String(i), b);
      if (next !== b) changed = true;
      return next;
    });
    return changed ? { ...m, message: { ...message, content } } : m;
  });
  slimmed.set(messages, out);
  return out;
}

function slimBlock(sessionId: string, uuid: string, key: string, b: Block): Block {
  if (b.type === "image") {
    const source = b.source as { type?: string; media_type?: string } | undefined;
    if (source?.type !== "base64") return b;
    const ref: HistoryImageSource = { type: "gateway", path: `/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(uuid)}/${key}`, media_type: source.media_type };
    return { ...b, source: ref };
  }
  if (b.type === "thinking" && b.thinking) return { ...b, thinking: "", signature: "" };
  if (b.type === "redacted_thinking" && b.data) return { ...b, data: "" };
  if (b.type === "tool_result" && Array.isArray(b.content)) {
    let changed = false;
    const content = (b.content as Block[]).map((c, j) => {
      const next = slimBlock(sessionId, uuid, `${key}.${j}`, c);
      if (next !== c) changed = true;
      return next;
    });
    return changed ? { ...b, content } : b;
  }
  return b;
}

/** historyForDisplay 换掉的图片：key 是内容块的序号，tool_result 里的是「块序号.结果里的序号」 */
export function historyImage(messages: SessionMessage[], uuid: string, key: string): { mediaType: string; data: Buffer } | undefined {
  const message = messages.find((m) => m.uuid === uuid)?.message as { content?: unknown } | undefined;
  let block: unknown = { content: message?.content };
  for (const index of key.split(".")) {
    const content = (block as { content?: unknown } | undefined)?.content;
    block = Array.isArray(content) ? content[Number(index)] : undefined;
  }
  const b = block as { type?: string; source?: { type?: string; media_type?: string; data?: string } } | undefined;
  if (b?.type !== "image" || b.source?.type !== "base64" || !b.source.data) return undefined;
  return { mediaType: b.source.media_type ?? "image/png", data: Buffer.from(b.source.data, "base64") };
}
