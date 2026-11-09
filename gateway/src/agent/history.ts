import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSessionMessages, type SessionMessage, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { sessionRecordDir } from "./scratch.js";

/**
 * 会话的历史消息，给网页显示用。
 * getSessionMessages 从最新一条消息顺着 parentUuid 往前找，到压缩上下文的分界（system/compact_boundary，parentUuid 为空）就停了，
 * 压缩前的消息读不到（会话文件里都还在）。所以每个分界前面那段再单独读一次：把会话文件截到分界之前，通过 sessionStore 交给
 * getSessionMessages，读到的就是压缩前那一刻的对话（它自己再往前若有分界，也到那里为止）。各段按时间先后接起来。
 * 压缩时保留下来的最近几条消息，在压缩前那段末尾和摘要后面各出现一次，按 uuid 只留前面的
 */
export async function sessionHistory(sessionId: string): Promise<SessionMessage[]> {
  const current = await getSessionMessages(sessionId);
  const dir = await sessionRecordDir(sessionId);
  const text = dir ? await readFile(path.join(dir, `${sessionId}.jsonl`), "utf8").catch(() => "") : "";
  if (!text.includes('"compact_boundary"')) return current;

  const entries: SessionStoreEntry[] = [];
  const boundaries: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionStoreEntry;
      if (entry.type === "system" && entry.subtype === "compact_boundary") boundaries.push(entries.length);
      entries.push(entry);
    } catch {
      // 写到一半的行（会话正在运行）跳过
    }
  }

  const segments: SessionMessage[][] = [];
  for (const end of boundaries) {
    const prefix = entries.slice(0, end);
    segments.push(await getSessionMessages(sessionId, { sessionStore: { append: async () => {}, load: async () => prefix } }));
  }
  segments.push(current);

  const seen = new Set<string>();
  return segments.flat().filter((m) => !seen.has(m.uuid) && seen.add(m.uuid));
}
