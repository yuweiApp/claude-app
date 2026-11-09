import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import type { FileContent, ProjectEntry } from "../../shared/types.js";
import { PAGE_PICKER_SCRIPT } from "../page-picker.js";

const run = promisify(execFile);
const LIMIT = 50;
/** 不是 git 仓库时自己遍历，跳过这些文件夹，最多收这么多个文件 */
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target", ".cache"]);
const MAX_FILES = 20000;
/** 输入 @ 后每敲一个字都会来查，文件列表缓存一会儿 */
const CACHE_MS = 10_000;
/** 右侧面板直接显示的文本文件上限 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};
const cache = new Map<string, { at: number; entries: Promise<ProjectEntry[]> }>();
/** 网页预览按扩展名给的类型，没列的按 application/octet-stream */
const PAGE_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
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
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};
/**
 * 网页预览的地址是「/files/page/<项目文件夹的随机 id>/<相对路径>」，网页里的相对路径（样式、脚本、图片）照常按目录解析，不用带令牌。
 * id 只在内存里，网关重启后旧地址失效
 */
const pageIds = new Map<string, string>();
const pageCwds = new Map<string, string>();
function pageId(cwd: string): string {
  let id = pageIds.get(cwd);
  if (!id) {
    id = randomBytes(18).toString("base64url");
    pageIds.set(cwd, id);
    pageCwds.set(id, cwd);
  }
  return id;
}
export const PAGE_PREFIX = "/files/page/";

/**
 * GET /files?cwd=&q=：输入框里 @ 引用文件用。
 * q 为空列项目文件夹第一层；q 以 / 结尾且是文件夹时列这个文件夹；否则在整个项目里搜（git 仓库按 .gitignore 过滤）
 */
export function fileRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { cwd?: string; q?: string } }>("/files", async (req) => {
    const cwd = req.query.cwd;
    if (!cwd || !path.isAbsolute(cwd)) throw new BadRequestError("缺少项目文件夹");
    const q = (req.query.q ?? "").trim();
    if (!q || q.endsWith("/")) {
      const dir = path.resolve(cwd, q);
      if (dir === cwd || dir.startsWith(cwd + path.sep)) {
        const listed = await listDir(cwd, dir);
        if (listed) return { entries: listed };
      }
    }
    return { entries: search(await projectEntries(cwd), q) };
  });

  // 右侧面板的文件树：一个文件夹的直接子项（path 相对项目文件夹，空是根）
  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/list", async (req) => {
    const { cwd, abs } = resolveInProject(req.query.cwd, req.query.path);
    const entries = await listDir(cwd, abs, true);
    if (!entries) throw new BadRequestError("不是文件夹");
    return { entries };
  });

  // 右侧面板查看文件：文本直接给内容，图片让网页用 /files/raw 取
  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/read", async (req): Promise<FileContent> => {
    const { abs } = resolveInProject(req.query.cwd, req.query.path);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new BadRequestError("文件不存在");
    const rel = req.query.path ?? "";
    const meta = { path: rel, size: info.size, mtimeMs: info.mtimeMs };
    if (IMAGE_TYPES[path.extname(abs).toLowerCase()]) return { ...meta, kind: "image" };
    if (info.size > MAX_TEXT_BYTES) return { ...meta, kind: "too-large" };
    const handle = await open(abs, "r");
    try {
      const buf = await handle.readFile();
      // 前 8KB 里有 0 字节就当二进制
      if (buf.subarray(0, 8192).includes(0)) return { ...meta, kind: "binary" };
      return { ...meta, kind: "text", text: buf.toString("utf8") };
    } finally {
      await handle.close();
    }
  });

  // 右侧面板编辑后保存（Ctrl+S）：mtimeMs 是读的时候的修改时间，对不上说明期间被改过（Claude 改了、终端里改了），不覆盖，除非 force
  app.post<{ Body: { cwd?: string; path?: string; text?: string; mtimeMs?: number; force?: boolean } }>("/files/write", async (req, reply) => {
    const { abs } = resolveInProject(req.body?.cwd, req.body?.path);
    if (typeof req.body?.text !== "string") throw new BadRequestError("缺少文件内容");
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new BadRequestError("文件不存在");
    if (!req.body.force && req.body.mtimeMs !== undefined && Math.abs(info.mtimeMs - req.body.mtimeMs) > 1) {
      return reply.code(409).send({ error: "文件在打开之后被修改过", mtimeMs: info.mtimeMs });
    }
    await writeFile(abs, req.body.text, "utf8");
    return { mtimeMs: (await stat(abs)).mtimeMs };
  });

  // 文件树右键「新建文件」「新建文件夹」：已经有同名的不覆盖
  app.post<{ Body: { cwd?: string; path?: string; dir?: boolean } }>("/files/create", async (req) => {
    const { cwd, abs } = resolveChild(req.body?.cwd, req.body?.path);
    if (await exists(abs)) throw new BadRequestError("已经有同名的文件或文件夹");
    if (!(await stat(path.dirname(abs)).catch(() => null))?.isDirectory()) throw new BadRequestError("所在的文件夹不存在");
    if (req.body.dir) await mkdir(abs);
    else await writeFile(abs, "", { flag: "wx" });
    cache.delete(cwd);
    return {};
  });

  // 文件树右键「删除」：直接删掉（文件夹连同里面的东西），网页上先确认
  app.post<{ Body: { cwd?: string; path?: string } }>("/files/delete", async (req) => {
    const { cwd, abs } = resolveChild(req.body?.cwd, req.body?.path);
    if (!(await exists(abs))) throw new BadRequestError("文件不存在");
    await rm(abs, { recursive: true, force: true });
    cache.delete(cwd);
    return {};
  });

  // 文件树右键「重命名」、拖到别的文件夹：都是改路径；目标已经存在的不覆盖，文件夹不能挪进自己里面
  app.post<{ Body: { cwd?: string; from?: string; to?: string } }>("/files/rename", async (req) => {
    const { cwd, abs: from } = resolveChild(req.body?.cwd, req.body?.from);
    const { abs: to } = resolveChild(req.body?.cwd, req.body?.to);
    if (from === to) return {};
    const src = await stat(from).catch(() => null);
    if (!src) throw new BadRequestError("文件不存在");
    if (to.startsWith(from + path.sep)) throw new BadRequestError("不能把文件夹移到它自己里面");
    // 目标存在就不改；但大小写不敏感的文件系统上只改大小写时，目标就是它自己，照样改
    const dst = await stat(to).catch(() => null);
    if (dst && !(dst.ino === src.ino && dst.dev === src.dev)) throw new BadRequestError("目标位置已经有同名的文件或文件夹");
    if (!(await stat(path.dirname(to)).catch(() => null))?.isDirectory()) throw new BadRequestError("目标文件夹不存在");
    await rename(from, to);
    cache.delete(cwd);
    return {};
  });

  // 右侧面板把 HTML 显示成网页：先拿这个文件的预览地址（要鉴权），iframe 再按地址取
  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/page-url", async (req) => {
    const { cwd, abs } = resolveInProject(req.query.cwd, req.query.path);
    const rel = path.relative(cwd, abs).split(path.sep).map(encodeURIComponent).join("/");
    return { url: `${PAGE_PREFIX}${pageId(cwd)}/${rel}` };
  });

  // 网页预览：不走令牌鉴权（见 app.ts），靠地址里的随机 id，只能读这个项目文件夹里的文件。
  // 和界面同源，用 CSP 的 sandbox 把它放进单独的源（不带 allow-same-origin），脚本碰不到界面的存储和接口。
  // HTML 末尾接上标注用的脚本（见 page-picker.ts）
  app.get<{ Params: { id: string; "*": string } }>(`${PAGE_PREFIX}:id/*`, async (req, reply) => {
    const cwd = pageCwds.get(req.params.id);
    if (!cwd) return reply.code(404).type("text/plain; charset=utf-8").send("预览地址已失效，重新打开文件");
    let { abs } = resolveInProject(cwd, req.params["*"]);
    let info = await stat(abs).catch(() => null);
    if (info?.isDirectory()) {
      abs = path.join(abs, "index.html");
      info = await stat(abs).catch(() => null);
    }
    if (!info?.isFile()) return reply.code(404).type("text/plain; charset=utf-8").send("文件不存在");
    const ext = path.extname(abs).toLowerCase();
    const html = (ext === ".html" || ext === ".htm") && info.size <= MAX_TEXT_BYTES;
    const body = html ? Buffer.concat([await readFile(abs), Buffer.from(`\n<script>${PAGE_PICKER_SCRIPT}</script>\n`)]) : createReadStream(abs);
    return reply
      .type(PAGE_TYPES[ext] ?? "application/octet-stream")
      .header("content-security-policy", "sandbox allow-scripts allow-forms allow-modals allow-popups")
      .header("x-content-type-options", "nosniff")
      // 沙箱里的页面是单独的源，type="module" 的脚本、fetch 同目录的文件要 CORS
      .header("access-control-allow-origin", "*")
      .header("cache-control", "no-store")
      .send(body);
  });

  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/raw", async (req, reply) => {
    const { abs } = resolveInProject(req.query.cwd, req.query.path);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new BadRequestError("文件不存在");
    const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    if (!type) throw new BadRequestError("只能直接取图片");
    // svg 里可以有脚本，按附件的 CSP 禁掉
    return reply.type(type).header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").send(createReadStream(abs));
  });
}

/** 项目里的路径（/ 分隔的相对路径）转成绝对路径，不能跳出项目文件夹 */
function resolveInProject(cwd: string | undefined, rel: string | undefined): { cwd: string; abs: string } {
  if (!cwd || !path.isAbsolute(cwd)) throw new BadRequestError("缺少项目文件夹");
  const root = path.resolve(cwd);
  const abs = path.resolve(root, rel ?? "");
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new BadRequestError("路径不在项目里");
  return { cwd: root, abs };
}

/** 同 resolveInProject，但不能是项目文件夹本身（新建、删除、改名用），名字里不能有 \0 */
function resolveChild(cwd: string | undefined, rel: string | undefined): { cwd: string; abs: string } {
  if (!rel || rel.includes("\0")) throw new BadRequestError("缺少路径");
  const resolved = resolveInProject(cwd, rel);
  if (resolved.abs === resolved.cwd) throw new BadRequestError("不能操作项目文件夹本身");
  return resolved;
}

const exists = (abs: string) => stat(abs).then(() => true, () => false);

/** 一个文件夹的直接子项，文件夹在前；不是文件夹时返回 null。withImageInfo：图片文件带上大小和修改时间（目录树的缩略图用） */
async function listDir(cwd: string, dir: string, withImageInfo = false): Promise<ProjectEntry[] | null> {
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!dirents) return null;
  const entries = await Promise.all(
    dirents
      .filter((d) => d.name !== ".git")
      .map(async (d): Promise<ProjectEntry> => {
        const abs = path.join(dir, d.name);
        const rel = path.relative(cwd, abs).split(path.sep).join("/");
        const isDir = d.isDirectory();
        if (isDir) return { path: `${rel}/`, dir: true };
        if (withImageInfo && IMAGE_TYPES[path.extname(d.name).toLowerCase()]) {
          const info = await stat(abs).catch(() => null);
          if (info) return { path: rel, dir: false, size: info.size, mtimeMs: info.mtimeMs };
        }
        return { path: rel, dir: false };
      }),
  );
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
}

function projectEntries(cwd: string): Promise<ProjectEntry[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries;
  const entries = listFiles(cwd).then(withDirs);
  cache.set(cwd, { at: Date.now(), entries });
  entries.catch(() => cache.delete(cwd));
  return entries;
}

/** 项目里的文件（相对路径，/ 分隔）：git 仓库用 git ls-files（含未跟踪、不含忽略的），否则自己遍历 */
async function listFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split("\0").filter(Boolean);
  } catch {
    const files: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      const dirents = await readdir(path.join(cwd, rel), { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        if (files.length >= MAX_FILES) return;
        const child = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (!SKIP.has(d.name)) await walk(child);
        } else files.push(child);
      }
    };
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new BadRequestError(`文件夹不存在：${cwd}`);
    await walk("");
    return files;
  }
}

/** 文件列表补上中间的文件夹 */
function withDirs(files: string[]): ProjectEntry[] {
  const dirs = new Set<string>();
  for (const file of files) {
    for (let i = file.indexOf("/"); i !== -1; i = file.indexOf("/", i + 1)) dirs.add(file.slice(0, i + 1));
  }
  return [...[...dirs].map((p) => ({ path: p, dir: true })), ...files.map((p) => ({ path: p, dir: false }))];
}

/** 按名字匹配排序：名字相同 > 名字开头 > 名字包含 > 路径包含 > 名字按顺序含这些字；同档短路径在前 */
function search(entries: ProjectEntry[], q: string): ProjectEntry[] {
  const needle = q.toLowerCase();
  const scored: { entry: ProjectEntry; score: number }[] = [];
  for (const entry of entries) {
    const full = entry.path.toLowerCase();
    const trimmed = entry.dir ? full.slice(0, -1) : full;
    const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    const score =
      name === needle ? 0
      : name.startsWith(needle) ? 1
      : name.includes(needle) ? 2
      : full.includes(needle) ? 3
      : isSubsequence(needle, name) ? 4
      : -1;
    if (score >= 0) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, LIMIT)
    .map((s) => s.entry);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
}
