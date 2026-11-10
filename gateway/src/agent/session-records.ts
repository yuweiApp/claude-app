import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

/**
 * 直接读 Claude Code 落盘的会话记录（projects/<目录名>/<会话 id>.jsonl），补 SDK 列会话给不了的：
 * 最后一次 AI 回复的时间和模型、文件中间的自定义标题。只读不写
 */

/** 从文件末尾往前每次读这么多 */
const CHUNK = 64 * 1024;
/** 最多往前读这么多还没找到 AI 回复就不找了 */
const MAX_SCAN = 4 * 1024 * 1024;

/** 按文件大小、修改时间缓存，文件没变就不再读；键是文件路径 */
const responseCache = new Map<string, { size: number; mtimeMs: number; at: number | undefined }>();
const titleCache = new Map<string, { size: number; mtimeMs: number; title: string | undefined }>();

/** 所有会话的记录文件，键是 sessionId */
export async function sessionRecordFiles(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const projects = path.join(config.claudeConfigDir, "projects");
  const dirs = await readdir(projects).catch(() => [] as string[]);
  await Promise.all(
    dirs.map(async (name) => {
      const dir = path.join(projects, name);
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files) if (f.endsWith(".jsonl")) result.set(f.slice(0, -".jsonl".length), path.join(dir, f));
    }),
  );
  return result;
}

/**
 * 最后一次 AI 回复的时间（最后一条 assistant 行的 timestamp）；没回复过、读不到时 undefined。
 * 不用文件修改时间：子进程退出时 Claude Code 还会往末尾补写元数据（last-prompt、cost-state 等），和有没有新回复无关
 */
export async function lastResponseAt(file: string): Promise<number | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info) return undefined;
  const cached = responseCache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.at;
  const at = await scanBackwards(file, info.size, assistantTime).catch(() => undefined);
  responseCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, at });
  return at;
}

/**
 * 最后一次 AI 回复用的模型（最后一条主线程 assistant 行的 message.model，跳过 <synthetic> 这类不是模型回的）；
 * 没回复过、读不到时 undefined。会话子进程回收后 resume 时沿用它，网页按历史推出的模型也是这个
 */
export async function lastResponseModel(file: string): Promise<string | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info) return undefined;
  return scanBackwards(file, info.size, assistantModel).catch(() => undefined);
}

/** 记录文件里最后一次设的自定义标题（custom-title 行）；整个文件都读，只在 SDK 和网关都给不了标题时用 */
export async function lastCustomTitle(file: string): Promise<string | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info) return undefined;
  const cached = titleCache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.title;
  const text = await readFile(file, "utf8").catch(() => "");
  let title: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"custom-title"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; customTitle?: string };
      if (entry.type === "custom-title" && entry.customTitle?.trim()) title = entry.customTitle.trim();
    } catch {
      // 写到一半的行
    }
  }
  titleCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, title });
  return title;
}

/** 从末尾往前一块块读，逐行找最后一条 pick 给出结果的记录；跨块的行拼起来再看 */
async function scanBackwards<T>(file: string, size: number, pick: (line: string) => T | undefined): Promise<T | undefined> {
  const handle = await open(file, "r");
  try {
    let end = size;
    // 上一块开头那段不完整的行，接在这一块后面
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < MAX_SCAN) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      await handle.read(buf, 0, buf.length, start);
      const data = Buffer.concat([buf, carry]);
      // 没读到文件开头时第一个换行之前可能是半行（字节也可能切在一个字的中间），按字节留给下一块
      const cut = start > 0 ? data.indexOf(10) : -1;
      if (start > 0 && cut < 0) {
        carry = data;
        end = start;
        continue;
      }
      const lines = data.subarray(cut + 1).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const found = pick(lines[i] ?? "");
        if (found !== undefined) return found;
      }
      carry = data.subarray(0, Math.max(cut, 0));
      end = start;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

function assistantTime(line: string): number | undefined {
  if (!line.includes('"assistant"')) return undefined;
  try {
    const entry = JSON.parse(line) as { type?: string; timestamp?: string; isSidechain?: boolean };
    if (entry.type !== "assistant" || entry.isSidechain || !entry.timestamp) return undefined;
    const at = Date.parse(entry.timestamp);
    return Number.isNaN(at) ? undefined : at;
  } catch {
    return undefined;
  }
}

function assistantModel(line: string): string | undefined {
  if (!line.includes('"assistant"')) return undefined;
  try {
    const entry = JSON.parse(line) as { type?: string; isSidechain?: boolean; message?: { model?: unknown } };
    if (entry.type !== "assistant" || entry.isSidechain) return undefined;
    const model = entry.message?.model;
    return typeof model === "string" && model && !model.startsWith("<") ? model : undefined;
  } catch {
    return undefined;
  }
}
