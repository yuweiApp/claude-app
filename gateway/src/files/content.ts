import iconv from "iconv-lite";
import type { FileEncoding } from "../shared/types.js";

/** 项目文件的内容：按扩展名给的类型、文本文件的编码、下载和音视频的响应头 */

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};
/** 右侧面板用 <video>、<audio> 播放的，能不能放由浏览器支持的编码决定 */
export const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
};
export const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
};
/** /files/raw 能直接取的 */
export const RAW_TYPES: Record<string, string> = { ...IMAGE_TYPES, ...VIDEO_TYPES, ...AUDIO_TYPES };
/** 网页预览按扩展名给的类型，没列的按 application/octet-stream */
export const PAGE_TYPES: Record<string, string> = {
  ...RAW_TYPES,
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
};
export const ENCODINGS = new Set<FileEncoding>(["utf-8", "gb18030", "utf-16le", "utf-16be"]);
/**
 * 认文本文件的编码，认不出（像二进制）给 null：
 * 有 UTF-16 的 BOM 就按 UTF-16；否则前 8KB 里有 0 字节当二进制；能按 UTF-8 解就是 UTF-8（带不带 BOM 都算）；
 * 都不是按 GB18030 解（GBK、GB2312 是它的子集，Windows 中文环境下生成的文件多是这种）
 */
export function detectEncoding(buf: Buffer): FileEncoding | null {
  if (buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
  if (buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
  if (buf.subarray(0, 8192).includes(0)) return null;
  try {
    utf8.decode(buf);
    return "utf-8";
  } catch {
    return "gb18030";
  }
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** BOM 留在文本里（\uFEFF），保存时原样写回 */
export function decodeText(buf: Buffer, encoding: FileEncoding): string {
  return encoding === "utf-8" ? buf.toString("utf8") : iconv.decode(buf, encoding, { stripBOM: false });
}
export function encodeText(text: string, encoding: FileEncoding): Buffer {
  return encoding === "utf-8" ? Buffer.from(text, "utf8") : iconv.encode(text, encoding, { addBOM: false });
}

/** Content-Disposition：filename 给只有 ASCII 的替代名，filename* 是 UTF-8 的原名（RFC 6266） */
export function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8Name = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8Name}`;
}

/** 单段的 Range 头（bytes=a-b、bytes=a-、bytes=-n），end 含在内；没有或是多段的给 null（整个文件），超出文件给 invalid */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}
