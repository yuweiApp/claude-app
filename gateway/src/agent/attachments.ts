import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import type { Attachment } from "../shared/types.js";

type UserContent = SDKUserMessage["message"]["content"];
type ContentBlock = Exclude<UserContent, string>[number];

/** 附件存在工作目录里，Claude Code 读工作目录内的文件不用确认 */
export const attachmentsDir = path.join(config.workspaceDir, ".attachments");

const ID_RE = /^[0-9a-f-]{36}$/;

/** 模型直接能看的图片格式（Anthropic 单张图片上限 5 MB） */
const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class AttachmentError extends Error {}

/** 去掉路径部分和控制字符，空名字用 file */
function safeName(name: string): string {
  const base = path.basename(name.replaceAll("\\", "/")).replace(/[\u0000-\u001f]/g, "").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 200) : "file";
}

/** 保存一个上传文件；stream 被截断（超过大小上限）时删掉并报错 */
export async function saveUpload(filename: string, stream: Readable & { truncated?: boolean }): Promise<Attachment> {
  const id = randomUUID();
  const dir = path.join(attachmentsDir, id);
  const name = safeName(filename);
  const file = path.join(dir, name);
  await mkdir(dir, { recursive: true });
  try {
    await pipeline(stream, createWriteStream(file));
    if (stream.truncated) throw new AttachmentError(`文件超过 ${config.maxUploadMb} MB：${name}`);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { id, name, path: file, size: (await stat(file)).size };
}

/** 按 id 找回附件（目录里只有一个文件） */
export async function loadAttachments(ids: string[]): Promise<Attachment[]> {
  return Promise.all(
    ids.map(async (id) => {
      if (!ID_RE.test(id)) throw new AttachmentError(`附件 id 无效：${id}`);
      const dir = path.join(attachmentsDir, id);
      const name = (await readdir(dir).catch(() => []))[0];
      if (!name) throw new AttachmentError(`附件不存在：${id}`);
      const file = path.join(dir, name);
      return { id, name, path: file, size: (await stat(file)).size };
    }),
  );
}

/** 能直接作为 image 块发给模型的图片：常见格式、不超过 5 MB */
function imageType(a: Attachment) {
  const mediaType = IMAGE_TYPES[path.extname(a.name).toLowerCase()];
  return mediaType && a.size <= MAX_IMAGE_BYTES ? mediaType : null;
}

/**
 * 拼用户消息的内容，结构同 Claude 桌面版（会话 jsonl 里用户发的图片就是这样存的）：
 * 图片作为 Anthropic 的 image 块（base64）放在最前面，然后是用户的文字；
 * 其他文件用一段 <attachments> 列出路径（网页按这个格式还原附件），模型需要时用 Read 读
 */
export async function buildUserContent(text: string, attachments: Attachment[]): Promise<UserContent> {
  if (!attachments.length) return text;
  const blocks: ContentBlock[] = [];
  const files: Attachment[] = [];
  for (const a of attachments) {
    const mediaType = imageType(a);
    if (!mediaType) {
      files.push(a);
      continue;
    }
    const data = (await readFile(a.path)).toString("base64");
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  if (text) blocks.push({ type: "text", text });
  if (files.length) blocks.push({ type: "text", text: formatAttachments(files) });
  return blocks;
}

function formatAttachments(attachments: Attachment[]): string {
  return [
    "<attachments>",
    "用户上传了以下文件，已保存在这些路径，需要时用 Read 工具读取：",
    ...attachments.map((a) => `- ${a.path}`),
    "</attachments>",
  ].join("\n");
}
