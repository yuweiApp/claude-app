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

/**
 * 逐级建目录（缺的上级目录先建）。不用 mkdir 的 recursive：它在某一级 mkdir 失败、错误又不是 ENOENT、EACCES、EPERM 这几种时，
 * 改报那一级 stat 的结果，目录本来就不存在，报出来的就成了 ENOENT，看不出真正原因。这里报的是失败那一级 mkdir 自己的错误
 */
async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && (await stat(dir).catch(() => null))?.isDirectory()) return;
    if (code !== "ENOENT" || path.dirname(dir) === dir) throw err;
  }
  await ensureDir(path.dirname(dir));
  try {
    await mkdir(dir);
  } catch (err) {
    // 同时有别的上传在建同一级目录
    if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !(await stat(dir).catch(() => null))?.isDirectory()) throw err;
  }
}

/** 保存一个上传文件；stream 被截断（超过大小上限）时删掉并报错 */
export async function saveUpload(filename: string, stream: Readable & { truncated?: boolean }): Promise<Attachment> {
  const id = randomUUID();
  const dir = path.join(attachmentsDir, id);
  const name = safeName(filename);
  const file = path.join(dir, name);
  await ensureDir(dir);
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
export function imageType(a: Attachment) {
  const mediaType = IMAGE_TYPES[path.extname(a.name).toLowerCase()];
  return mediaType && a.size <= MAX_IMAGE_BYTES ? mediaType : null;
}

/** 网页上选中的元素（发消息的请求里的）：网页拼好的 <selected-element> 一段文字，截图是附件 id */
export interface SelectedElementInput {
  text: string;
  screenshot?: string;
}

/** 截图换成了附件 */
export interface SelectedElementContent {
  text: string;
  screenshot?: Attachment;
}

export async function loadElements(inputs: SelectedElementInput[]): Promise<SelectedElementContent[]> {
  return Promise.all(
    inputs.map(async ({ text, screenshot }) => {
      const [image] = screenshot ? await loadAttachments([screenshot]) : [];
      return { text, ...(image ? { screenshot: image } : {}) };
    }),
  );
}

/**
 * 拼用户消息的内容，结构同 Claude 桌面版（会话 jsonl 里用户发的图片就是这样存的）：
 * 图片作为 Anthropic 的 image 块（base64）放在最前面，然后是用户的文字；
 * 网页上选中的元素接在用户的文字后面，每个是截图（image 块）和那段 <selected-element> 文字，同 Claude 桌面版的「选择元素」；
 * 其他文件用一段 <attachments> 列出路径（网页按这个格式还原附件），模型需要时用 Read 读
 */
export async function buildUserContent(
  text: string,
  attachments: Attachment[],
  elements: SelectedElementContent[] = [],
  /** 远程会话：附件上传到远端后的路径（附件 id → 远端路径），模型看到的是它 */
  remotePaths?: Map<string, string>,
): Promise<UserContent> {
  if (!attachments.length && !elements.length) return text;
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
  for (const element of elements) {
    const mediaType = element.screenshot && imageType(element.screenshot);
    if (mediaType) blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: (await readFile(element.screenshot!.path)).toString("base64") } });
    blocks.push({ type: "text", text: element.text });
  }
  if (files.length) blocks.push({ type: "text", text: formatAttachments(files.map((a) => ({ ...a, path: remotePaths?.get(a.id) ?? a.path }))) });
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
