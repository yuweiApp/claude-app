import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSearchHit, SessionSearchResult } from "../shared/types.js";
import { sessionHistory } from "./history.js";
import { FileCache, sessionRecordFile } from "./session-records.js";

/** 一次查找最多返回这么多条 */
const LIMIT = 200;
/** 片段里匹配处前后各留多少字 */
const BEFORE = 40;
const AFTER = 100;

/** 一条可查的消息：主线程里用户写的文字、Claude 回复的文字 */
interface SearchDoc {
  uuid: string;
  role: "user" | "assistant";
  text: string;
  at?: number;
}

/** 各会话抽出来的文字，按记录文件的大小、修改时间缓存（只留文字，比整份历史小得多） */
const docsCache = new FileCache<SearchDoc[]>(256);

/**
 * 在这些会话的记录里查找 query（不分大小写），一条消息一条结果，按传入的会话顺序、会话里按消息先后排。
 * 消息来自 sessionHistory（和网页显示的历史同一份，压缩上下文之前的也在），uuid 和网页里的消息对得上
 */
export async function searchSessions(sessionIds: string[], query: string): Promise<SessionSearchResult> {
  const needle = query.toLowerCase();
  const hits: SessionSearchHit[] = [];
  let truncated = false;
  for (const sessionId of sessionIds) {
    const docs = await sessionDocs(sessionId);
    for (const doc of docs) {
      const lower = doc.text.toLowerCase();
      const first = lower.indexOf(needle);
      if (first < 0) continue;
      if (hits.length >= LIMIT) {
        truncated = true;
        break;
      }
      let count = 0;
      for (let i = first; i >= 0; i = lower.indexOf(needle, i + needle.length)) count++;
      hits.push({ sessionId, uuid: doc.uuid, role: doc.role, snippet: snippet(doc.text, first, needle.length), count, ...(doc.at ? { at: doc.at } : {}) });
    }
    if (truncated) break;
  }
  return { hits, truncated, sessions: sessionIds.length };
}

async function sessionDocs(sessionId: string): Promise<SearchDoc[]> {
  const file = await sessionRecordFile(sessionId);
  if (!file) return [];
  return (await docsCache.get(file, async () => extractDocs(await sessionHistory(sessionId).catch(() => [])))) ?? [];
}

function extractDocs(messages: SessionMessage[]): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const m of messages) {
    if (m.parent_tool_use_id || (m.type !== "user" && m.type !== "assistant")) continue;
    // 压缩上下文的摘要（网页上显示成「上下文已压缩」一行）、Claude Code 自己插的消息（is_meta）不是谁写的对话
    const flags = m as { isCompactSummary?: boolean; is_meta?: boolean };
    if (flags.isCompactSummary || flags.is_meta) continue;
    const content = (m.message as { content?: unknown } | null)?.content;
    const text = m.type === "assistant" ? assistantText(content) : userText(content);
    if (!text) continue;
    const at = Date.parse((m as { timestamp?: string }).timestamp ?? "");
    docs.push({ uuid: m.uuid, role: m.type, text, ...(Number.isFinite(at) ? { at } : {}) });
  }
  return docs;
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: unknown; text?: unknown }>)
    .flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []))
    .join("\n\n")
    .trim();
}

/**
 * 用户消息里用户写的文字。整段包在一对标签里的不算（命令、本地命令输出、后台任务通知、网关拼的附件列表和选中的元素、system-reminder），
 * 技能内容、中断提示、其他会话发来的消息也不算：这些网页上不显示成用户消息
 */
function userText(content: unknown): string {
  const parts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? (content as Array<{ type?: unknown; text?: unknown }>).flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []))
        : [];
  return parts
    .map((t) => withoutAnnotations(t.trim()))
    .filter((t) => t && !WRAPPED.test(t) && !NOT_TYPED.test(t))
    .join("\n\n");
}

/**
 * 网页在消息末尾拼的回复标注（「# Response annotations:」开头，<response-annotations> 里是 JSON，见网页的 responseAnnotations.ts）去掉：
 * 网页上显示成标注的小标签，不在消息正文里
 */
function withoutAnnotations(text: string): string {
  if (!text.endsWith("</response-annotations>")) return text;
  const at = text.lastIndexOf("# Response annotations:");
  return at >= 0 && (at === 0 || text[at - 1] === "\n") ? text.slice(0, at).trim() : text;
}

const WRAPPED = /^<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/i;
const NOT_TYPED =
  /^(?:Base directory for this skill:|Skill \/\S+ is already loaded above|\[Request interrupted by user|(?:Another Claude session|A peer session|The coordinator) sent a message|A message arrived from )/;

/** 第一处匹配前后的一段，空白合成一个空格 */
function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - BEFORE);
  const end = Math.min(text.length, index + length + AFTER);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}
