import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { GatewayEvent } from "../shared/types.js";

export interface ConversationLogOptions {
  enabled: boolean;
  dir: string;
  /** 单个文件的上限，超过换下一个文件 */
  maxFileBytes: number;
  /** 所有日志的总量上限，超过从最旧的文件开始删 */
  maxTotalBytes: number;
  /** 保留天数，更早的文件删掉 */
  retentionDays: number;
  /** 单条记录的上限，超过只留开头一段 */
  maxEntryBytes: number;
}

const FILE_NAME = /^conversation-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const IMAGE_DIR = "images";
const IMAGE_NAME = /^[0-9a-f]{32}\.[a-z0-9]+$/;
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
const SWEEP_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** 排查问题用得上的 system 消息；其他（init、status、task_started 等）太多，不记 */
const SYSTEM_SUBTYPES = new Set([
  "api_retry",
  "compact_boundary",
  "task_notification",
  "permission_denied",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "mirror_error",
]);

/** 记用户消息、模型的完整消息、工具结果、一轮的结果、权限确认和错误；stream_event 是同一份内容的逐字片段，不记 */
function shouldRecord(event: GatewayEvent): boolean {
  switch (event.type) {
    case "user_message":
    case "permission_request":
    case "permission_resolved":
    case "error":
      return true;
    case "sdk": {
      const { message } = event;
      if (message.type === "assistant" || message.type === "user" || message.type === "result") return true;
      return message.type === "system" && SYSTEM_SUBTYPES.has(message.subtype);
    }
    default:
      return false;
  }
}

/** Anthropic 消息里的 base64 内容：{ type: "base64", media_type, data } */
function isBase64Source(value: unknown): value is { type: "base64"; media_type: string; data: string } {
  const v = value as { type?: unknown; media_type?: unknown; data?: unknown } | null;
  return typeof v === "object" && v !== null && v.type === "base64" && typeof v.media_type === "string" && typeof v.data === "string";
}

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 对话日志：用户发的原始内容和模型的实际响应，排查问题用，和 Fastify 的运行日志分开。
 * 每行一条 JSON，文件名 conversation-日期[.序号].jsonl：按天分文件，单文件超限换下一个序号。
 * 图片的 base64 存成 images/<内容哈希>.<扩展名>，日志里写文件的绝对路径，同一张图只存一份。
 * 定时删掉超过保留天数的文件，总量（含图片）超限时从最旧的删。写失败只记运行日志，不影响会话
 */
export class ConversationLog {
  /** 写入和清理排队执行，保证顺序、不抢文件 */
  private queue: Promise<void> = Promise.resolve();
  private current: { date: string; index: number; size: number } | null = null;
  private readonly sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: ConversationLogOptions,
    private readonly log: FastifyBaseLogger,
  ) {
    if (!options.enabled) return;
    this.enqueue(() => this.sweep());
    this.sweeper = setInterval(() => this.enqueue(() => this.sweep()), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  record(sessionId: string, event: GatewayEvent): void {
    if (!this.options.enabled || !shouldRecord(event)) return;
    const images = new Map<string, Buffer>();
    const line = this.format(sessionId, event, images);
    this.enqueue(async () => {
      for (const [file, data] of images) await this.saveImage(file, data);
      await this.write(line);
    });
  }

  /** 等排队的写入完成（关闭网关时） */
  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await this.queue;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => this.log.warn({ err }, "写对话日志失败"));
  }

  /** 序列化一条记录：base64 内容换成文件路径，要写的文件放进 images */
  private format(sessionId: string, event: GatewayEvent, images: Map<string, Buffer>): string {
    const time = new Date().toISOString();
    const text = JSON.stringify({ time, sessionId, event }, (key, value: unknown) => {
      if (isBase64Source(value)) {
        const data = Buffer.from(value.data, "base64");
        const hash = createHash("sha256").update(data).digest("hex").slice(0, 32);
        const file = path.join(this.options.dir, IMAGE_DIR, `${hash}.${EXTENSIONS[value.media_type] ?? "bin"}`);
        images.set(file, data);
        return { type: "file", media_type: value.media_type, file };
      }
      // Read 读图片时 tool_use_result 里还有一份同样的内容，消息里已经有文件路径了
      if ((key === "data" || key === "base64") && typeof value === "string" && value.length > 1024) return `<已省略 ${value.length} 字符>`;
      return value;
    });
    const bytes = Buffer.byteLength(text);
    if (bytes <= this.options.maxEntryBytes) return `${text}\n`;
    const preview = Buffer.from(text).subarray(0, Math.floor(this.options.maxEntryBytes * 0.8)).toString();
    return `${JSON.stringify({ time, sessionId, type: event.type, truncated: true, originalBytes: bytes, preview })}\n`;
  }

  /** 同一张图再次出现时更新时间，免得它比引用它的新日志先被清理 */
  private async saveImage(file: string, data: Buffer): Promise<void> {
    const now = new Date();
    try {
      await utimes(file, now, now);
    } catch {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, data, { mode: 0o600 });
    }
  }

  private filePath(date: string, index: number): string {
    return path.join(this.options.dir, `conversation-${date}${index ? `.${index}` : ""}.jsonl`);
  }

  private async write(line: string): Promise<void> {
    const date = localDate(new Date());
    if (this.current?.date !== date) this.current = await this.open(date);
    const bytes = Buffer.byteLength(line);
    if (this.current.size > 0 && this.current.size + bytes > this.options.maxFileBytes) {
      this.current = { date, index: this.current.index + 1, size: 0 };
      await this.sweep();
    }
    await appendFile(this.filePath(date, this.current.index), line, { mode: 0o600 });
    this.current.size += bytes;
  }

  /** 接着写当天序号最大的文件（网关重启后） */
  private async open(date: string): Promise<{ date: string; index: number; size: number }> {
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    let index = 0;
    for (const name of await readdir(this.options.dir)) {
      const match = FILE_NAME.exec(name);
      if (match?.[1] === date) index = Math.max(index, Number(match[2] ?? 0));
    }
    const size = await stat(this.filePath(date, index)).then((s) => s.size, () => 0);
    return { date, index, size };
  }

  private async sweep(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const logs = (await readdir(this.options.dir)).filter((name) => FILE_NAME.test(name));
    const imageDir = path.join(this.options.dir, IMAGE_DIR);
    const images = (await readdir(imageDir).catch(() => [] as string[])).filter((name) => IMAGE_NAME.test(name));
    const paths = [...logs.map((name) => path.join(this.options.dir, name)), ...images.map((name) => path.join(imageDir, name))];
    const files = await Promise.all(
      paths.map(async (file) => {
        const info = await stat(file);
        return { file, size: info.size, mtime: info.mtimeMs };
      }),
    );
    files.sort((a, b) => a.mtime - b.mtime);
    const writing = this.current && this.filePath(this.current.date, this.current.index);
    const cutoff = Date.now() - this.options.retentionDays * DAY_MS;
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const file of files) {
      if (file.file === writing || (file.mtime >= cutoff && total <= this.options.maxTotalBytes)) continue;
      await unlink(file.file);
      total -= file.size;
      this.log.info({ file: file.file }, "清理对话日志");
    }
  }
}
