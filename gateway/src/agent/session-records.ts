import { createReadStream } from "node:fs";
import { access, open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { config } from "../config.js";

/**
 * 直接读 Claude Code 落盘的会话记录（projects/<目录名>/<会话 id>.jsonl），补 SDK 列会话给不了的：
 * 最后一次 AI 回复的时间和模型、文件中间的自定义标题、开头 64KB 里找不到的工作目录。只读不写
 */

/** 从文件末尾往前每次读这么多 */
const CHUNK = 64 * 1024;
/** 最多往前读这么多还没找到 AI 回复就不找了 */
const MAX_SCAN = 4 * 1024 * 1024;

/**
 * 读文件得出的结果，按文件大小、修改时间缓存（会话在跑、远程会话同步过来，文件都会变），文件没变就不再读；键是文件路径。
 * limit：最多留几个文件的，超过时丢掉最久没用的
 */
export class FileCache<T> {
  private readonly entries = new Map<string, { size: number; mtimeMs: number; value: T }>();

  constructor(private readonly limit = Number.POSITIVE_INFINITY) {}

  /** 没有这个文件、读不了时是 undefined；read 拿到的是这次看到的文件大小 */
  async get(file: string, read: (size: number) => Promise<T>): Promise<T | undefined> {
    const info = await stat(file).catch(() => undefined);
    if (!info) return undefined;
    const hit = this.entries.get(file);
    this.entries.delete(file);
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) {
      this.entries.set(file, hit);
      return hit.value;
    }
    const value = await read(info.size);
    this.entries.set(file, { size: info.size, mtimeMs: info.mtimeMs, value });
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
}

const responseCache = new FileCache<number | undefined>();
const titleCache = new FileCache<string | undefined>();
const forkCache = new FileCache<string | undefined>();
/** 工作目录写进去就不会再变，找到了就一直缓存 */
const cwdCache = new Map<string, string>();
/** 会话记录所在的文件夹：文件还在就不用再遍历 projects/ 下的所有文件夹 */
const dirCache = new Map<string, string>();

/** 会话记录（jsonl）所在的文件夹：Claude Code 按工作目录放在 projects/<目录名>/ 下；没有这个会话的记录时 undefined */
export async function sessionRecordDir(sessionId: string): Promise<string | undefined> {
  const has = (dir: string) => access(path.join(dir, `${sessionId}.jsonl`)).then(() => true, () => false);
  const cached = dirCache.get(sessionId);
  if (cached && (await has(cached))) return cached;
  const projects = path.join(config.claudeConfigDir, "projects");
  for (const name of await readdir(projects).catch(() => [] as string[])) {
    const dir = path.join(projects, name);
    if (await has(dir)) {
      dirCache.set(sessionId, dir);
      return dir;
    }
  }
  dirCache.delete(sessionId);
  return undefined;
}

/** 会话记录文件的路径；没有这个会话的记录时 undefined */
export async function sessionRecordFile(sessionId: string): Promise<string | undefined> {
  const dir = await sessionRecordDir(sessionId);
  return dir && path.join(dir, `${sessionId}.jsonl`);
}

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
export function lastResponseAt(file: string): Promise<number | undefined> {
  return responseCache.get(file, (size) => scanBackwards(file, size, assistantTime).catch(() => undefined));
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
export function lastCustomTitle(file: string): Promise<string | undefined> {
  return titleCache.get(file, async () => {
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
    return title;
  });
}

/**
 * 会话的工作目录：记录里第一条带 cwd 字段的行。SDK 列会话、getSessionInfo 只在文件开头 64KB 里找 cwd，
 * 第一条消息带了图片时（用户消息那行 message 在 cwd 前面，图片是 base64）找不到，给的是 undefined，这里从头逐行读。
 * 写进去的 cwd 不会再变，找到了就一直缓存；键是文件路径
 */
export async function recordedCwd(file: string): Promise<string | undefined> {
  const cached = cwdCache.get(file);
  if (cached) return cached;
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd"')) continue;
      try {
        const entry = JSON.parse(line) as { cwd?: unknown };
        if (typeof entry.cwd === "string" && entry.cwd) {
          cwdCache.set(file, entry.cwd);
          return entry.cwd;
        }
      } catch {
        // 写到一半的行
      }
    }
  } catch {
    // 文件读不了
  } finally {
    lines.close();
    stream.destroy();
  }
  return undefined;
}

/** SDK 分叉时在复制的消息中记录 forkedFrom.sessionId，旧分支和远程副本同样适用 */
export function recordedForkParent(file: string): Promise<string | undefined> {
  return forkCache.get(file, () => readForkParent(file));
}

async function readForkParent(file: string): Promise<string | undefined> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let parent: string | undefined;
  try {
    for await (const line of lines) {
      try {
        const entry = JSON.parse(line) as { type?: string; sessionId?: string; forkedFrom?: { sessionId?: unknown } };
        const source = entry.forkedFrom?.sessionId;
        if (typeof source === "string" && source && source !== entry.sessionId) {
          parent = source;
          break;
        }
        // 普通会话的第一条消息没有来源，无需扫描剩下的记录
        if (entry.type === "user" || entry.type === "assistant") break;
      } catch {
        // 跳过写到一半的行
      }
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
  return parent;
}

/** 从末尾往前一块块读，逐行找最后一条 pick 给出结果的记录；跨块的行拼起来再看。最多往前读 maxScan 字节 */
export async function scanBackwards<T>(file: string, size: number, pick: (line: string) => T | undefined, maxScan = MAX_SCAN): Promise<T | undefined> {
  const handle = await open(file, "r");
  try {
    let end = size;
    // 上一块开头那段不完整的行，接在这一块后面
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < maxScan) {
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
