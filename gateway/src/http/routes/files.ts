import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import type { FileContent, ProjectEntry } from "../../shared/types.js";
import { fsFor, type HostFs } from "../../ssh/host-fs.js";
import { PAGE_PICKER_SCRIPT } from "../page-picker.js";

/** 本机是 path，远程会话（cwd 是 ssh://…，见 ssh/host-fs.ts）是 path.posix */
type PathLib = HostFs["path"];
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
    const at = resolveInProject(req.query.cwd, "");
    const q = (req.query.q ?? "").trim();
    if (!q || q.endsWith("/")) {
      const dir = at.p.resolve(at.root, q);
      if (isInside(at.p, at.root, dir)) {
        const listed = await listDir(at, dir);
        if (listed) return { entries: listed };
      }
    }
    return { entries: search(await projectEntries(at), q) };
  });

  // 右侧面板的文件树：一个文件夹的直接子项（path 相对项目文件夹，空是根）
  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/list", async (req) => {
    const at = resolveInProject(req.query.cwd, req.query.path);
    const { fs, abs } = at;
    const entries = await listDir(at, abs, true);
    if (entries) return { entries };
    // 列不出来：报出原因（不存在、没有权限、不是文件夹）
    const info = await fs.stat(abs).catch((err: NodeJS.ErrnoException) => {
      throw new BadRequestError(fsError(err, "文件夹"));
    });
    if (!info.isDirectory) throw new BadRequestError("不是文件夹");
    await fs.readdir(abs).catch((err: NodeJS.ErrnoException) => {
      throw new BadRequestError(fsError(err, "文件夹"));
    });
    throw new BadRequestError("文件夹读取失败");
  });

  // 右侧面板查看文件：文本直接给内容，图片让网页用 /files/raw 取
  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/read", async (req): Promise<FileContent> => {
    const { fs, p, abs } = resolveInProject(req.query.cwd, req.query.path);
    const info = await fs.stat(abs).catch((err: NodeJS.ErrnoException) => {
      throw new BadRequestError(fsError(err, "文件"));
    });
    if (!info.isFile) throw new BadRequestError(info.isDirectory ? "是文件夹，不是文件" : "不是普通文件");
    const rel = req.query.path ?? "";
    const meta = { path: rel, size: info.size, mtimeMs: info.mtimeMs };
    if (IMAGE_TYPES[p.extname(abs).toLowerCase()]) return { ...meta, kind: "image" };
    if (info.size > MAX_TEXT_BYTES) return { ...meta, kind: "too-large" };
    const buf = await fs.readFile(abs).catch((err: NodeJS.ErrnoException) => {
      throw new BadRequestError(fsError(err, "文件"));
    });
    // 前 8KB 里有 0 字节就当二进制
    if (buf.subarray(0, 8192).includes(0)) return { ...meta, kind: "binary" };
    return { ...meta, kind: "text", text: buf.toString("utf8") };
  });

  // 右侧面板编辑后保存（Ctrl+S）：mtimeMs 是读的时候的修改时间，对不上说明期间被改过（Claude 改了、终端里改了），不覆盖，除非 force
  app.post<{ Body: { cwd?: string; path?: string; text?: string; mtimeMs?: number; force?: boolean } }>("/files/write", async (req, reply) => {
    const { fs, abs } = resolveInProject(req.body?.cwd, req.body?.path);
    if (typeof req.body?.text !== "string") throw new BadRequestError("缺少文件内容");
    const info = await fs.stat(abs).catch(() => null);
    if (!info?.isFile) throw new BadRequestError("文件不存在");
    if (!req.body.force && req.body.mtimeMs !== undefined && Math.abs(info.mtimeMs - req.body.mtimeMs) > 1) {
      return reply.code(409).send({ error: "文件在打开之后被修改过", mtimeMs: info.mtimeMs });
    }
    await fs.writeFile(abs, req.body.text);
    return { mtimeMs: (await fs.stat(abs)).mtimeMs };
  });

  // 文件树右键「新建文件」「新建文件夹」：已经有同名的不覆盖
  app.post<{ Body: { cwd?: string; path?: string; dir?: boolean } }>("/files/create", async (req) => {
    const { key, fs, p, abs } = resolveChild(req.body?.cwd, req.body?.path);
    if (await exists(fs, abs)) throw new BadRequestError("已经有同名的文件或文件夹");
    if (!(await fs.stat(p.dirname(abs)).catch(() => null))?.isDirectory) throw new BadRequestError("所在的文件夹不存在");
    if (req.body.dir) await fs.mkdir(abs);
    else await fs.writeFile(abs, "", { exclusive: true });
    cache.delete(key);
    return {};
  });

  // 文件树右键「删除」：直接删掉（文件夹连同里面的东西），网页上先确认
  app.post<{ Body: { cwd?: string; path?: string } }>("/files/delete", async (req) => {
    const { key, fs, abs } = resolveChild(req.body?.cwd, req.body?.path);
    if (!(await exists(fs, abs))) throw new BadRequestError("文件不存在");
    await fs.rm(abs);
    cache.delete(key);
    return {};
  });

  // 文件树右键「重命名」、拖到别的文件夹：都是改路径；目标已经存在的不覆盖，文件夹不能挪进自己里面
  app.post<{ Body: { cwd?: string; from?: string; to?: string } }>("/files/rename", async (req) => {
    const { key, fs, p, abs: from } = resolveChild(req.body?.cwd, req.body?.from);
    const { abs: to } = resolveChild(req.body?.cwd, req.body?.to);
    if (from === to) return {};
    const src = await fs.stat(from).catch(() => null);
    if (!src) throw new BadRequestError("文件不存在");
    if (isInside(p, from, to)) throw new BadRequestError("不能把文件夹移到它自己里面");
    // 目标存在就不改；但大小写不敏感的文件系统上只改大小写时，目标就是它自己，照样改（远端拿不到 inode，按只差大小写算）
    const dst = await fs.stat(to).catch(() => null);
    const same = src.id ? dst?.id === src.id : from.toLowerCase() === to.toLowerCase();
    if (dst && !same) throw new BadRequestError("目标位置已经有同名的文件或文件夹");
    if (!(await fs.stat(p.dirname(to)).catch(() => null))?.isDirectory) throw new BadRequestError("目标文件夹不存在");
    await fs.rename(from, to);
    cache.delete(key);
    return {};
  });

  // Claude 回复里的行内代码像文件路径时，网页来问是不是工作目录里存在的文件（是就显示成文件链接）；paths 相对项目文件夹
  app.post<{ Body: { cwd?: string; paths?: unknown } }>("/files/exists", async (req) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((p): p is string => typeof p === "string").slice(0, 200) : [];
    const checked = await Promise.all(
      paths.map(async (rel) => {
        try {
          const { fs, abs } = resolveInProject(req.body?.cwd, rel);
          return (await fs.stat(abs)).isFile ? rel : null;
        } catch {
          return null;
        }
      }),
    );
    return { exists: checked.filter((p): p is string => p !== null) };
  });

  // 右侧面板把 HTML 显示成网页：先拿这个文件的预览地址（要鉴权），iframe 再按地址取
  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/page-url", async (req) => {
    const { key, root, p, abs } = resolveInProject(req.query.cwd, req.query.path);
    const rel = p.relative(root, abs).split(p.sep).map(encodeURIComponent).join("/");
    return { url: `${PAGE_PREFIX}${pageId(key)}/${rel}` };
  });

  // 网页预览：不走令牌鉴权（见 app.ts），靠地址里的随机 id，只能读这个项目文件夹里的文件。
  // 和界面同源，用 CSP 的 sandbox 把它放进单独的源（不带 allow-same-origin），脚本碰不到界面的存储和接口。
  // HTML 末尾接上标注用的脚本（见 page-picker.ts）
  app.get<{ Params: { id: string; "*": string } }>(`${PAGE_PREFIX}:id/*`, async (req, reply) => {
    const cwd = pageCwds.get(req.params.id);
    if (!cwd) return reply.code(404).type("text/plain; charset=utf-8").send("预览地址已失效，重新打开文件");
    const at = resolveInProject(cwd, req.params["*"]);
    const { fs, p } = at;
    let abs = at.abs;
    let info = await fs.stat(abs).catch(() => null);
    if (info?.isDirectory) {
      abs = p.join(abs, "index.html");
      info = await fs.stat(abs).catch(() => null);
    }
    if (!info?.isFile) return reply.code(404).type("text/plain; charset=utf-8").send("文件不存在");
    const ext = p.extname(abs).toLowerCase();
    const html = (ext === ".html" || ext === ".htm") && info.size <= MAX_TEXT_BYTES;
    const body = html ? Buffer.concat([await fs.readFile(abs), Buffer.from(`\n<script>${PAGE_PICKER_SCRIPT}</script>\n`)]) : fs.createReadStream(abs);
    // PDF 不加 sandbox：Chromium 在沙箱里不显示 PDF（报被拦截）。PDF 由浏览器自带的查看器显示，PDF 里的脚本碰不到界面
    if (ext !== ".pdf") reply.header("content-security-policy", "sandbox allow-scripts allow-forms allow-modals allow-popups");
    return reply
      .type(PAGE_TYPES[ext] ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      // 沙箱里的页面是单独的源，type="module" 的脚本、fetch 同目录的文件要 CORS
      .header("access-control-allow-origin", "*")
      .header("cache-control", "no-store")
      .send(body);
  });

  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/raw", async (req, reply) => {
    const { fs, p, abs } = resolveInProject(req.query.cwd, req.query.path);
    const info = await fs.stat(abs).catch(() => null);
    if (!info?.isFile) throw new BadRequestError("文件不存在");
    const type = IMAGE_TYPES[p.extname(abs).toLowerCase()];
    if (!type) throw new BadRequestError("只能直接取图片");
    // svg 里可以有脚本，按附件的 CSP 禁掉
    return reply.type(type).header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").send(fs.createReadStream(abs));
  });
}

/** 解析出来的项目里的一个路径：key 是网页传来的 cwd（缓存、预览 id 按它），root 是项目文件夹在那台机器上的路径 */
interface InProject {
  key: string;
  root: string;
  abs: string;
  fs: HostFs;
  p: PathLib;
}

/** 项目里的路径（/ 分隔的相对路径）转成绝对路径，不能跳出项目文件夹；cwd 可以是远程会话的 ssh://… */
function resolveInProject(cwd: string | undefined, rel: string | undefined): InProject {
  if (!cwd) throw new BadRequestError("缺少项目文件夹");
  let at: ReturnType<typeof fsFor>;
  try {
    at = fsFor(cwd);
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : String(err));
  }
  const p = at.fs.path;
  if (!at.root || !p.isAbsolute(at.root)) throw new BadRequestError("缺少项目文件夹");
  const root = p.resolve(at.root);
  const abs = p.resolve(root, rel ?? "");
  if (!isInside(p, root, abs)) throw new BadRequestError("路径不在项目里");
  return { key: cwd, root, abs, fs: at.fs, p };
}

/**
 * abs 是 root 本身或者在它里面（都是解析过的绝对路径）。不用「root + 分隔符」做前缀比较：
 * 根目录（/、C:\、\\server\share\）本身以分隔符结尾，拼出来的前缀多一个分隔符，里面的路径都对不上
 */
function isInside(p: PathLib, root: string, abs: string): boolean {
  const rel = p.relative(root, abs);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

/** 读文件、文件夹失败的原因，显示在右侧面板里；what 是「文件」或「文件夹」 */
function fsError(err: NodeJS.ErrnoException, what: string): string {
  switch (err.code) {
    case "ENOENT":
      return `${what}不存在`;
    case "ENOTDIR":
      return "路径中有一级不是文件夹";
    case "EACCES":
    case "EPERM":
      // macOS 的桌面、文稿、下载、iCloud 等文件夹受隐私保护，没授权的应用读不了（报 EPERM）
      return process.platform === "darwin"
        ? `没有权限读取这个${what}。桌面、文稿、下载等文件夹受 macOS 隐私保护，要在「系统设置 › 隐私与安全性 › 文件与文件夹」（或「完全磁盘访问权限」）里允许运行网关的应用`
        : `没有权限读取这个${what}`;
    default:
      return `${what}读取失败：${err.code ?? err.message}`;
  }
}

/** 同 resolveInProject，但不能是项目文件夹本身（新建、删除、改名用），名字里不能有 \0 */
function resolveChild(cwd: string | undefined, rel: string | undefined): InProject {
  if (!rel || rel.includes("\0")) throw new BadRequestError("缺少路径");
  const resolved = resolveInProject(cwd, rel);
  if (resolved.abs === resolved.root) throw new BadRequestError("不能操作项目文件夹本身");
  return resolved;
}

const exists = (fs: HostFs, abs: string) => fs.stat(abs).then(() => true, () => false);

/** 一个文件夹的直接子项，文件夹在前；不是文件夹时返回 null。withImageInfo：图片文件带上大小和修改时间（目录树的缩略图用） */
async function listDir({ fs, p, root }: InProject, dir: string, withImageInfo = false): Promise<ProjectEntry[] | null> {
  const dirents = await fs.readdir(dir).catch(() => null);
  if (!dirents) return null;
  const entries = await Promise.all(
    dirents
      .filter((d) => d.name !== ".git")
      .map(async (d): Promise<ProjectEntry> => {
        const abs = p.join(dir, d.name);
        const rel = p.relative(root, abs).split(p.sep).join("/");
        if (d.isDirectory) return { path: `${rel}/`, dir: true };
        if (withImageInfo && IMAGE_TYPES[p.extname(d.name).toLowerCase()]) {
          const info = await fs.stat(abs).catch(() => null);
          if (info) return { path: rel, dir: false, size: info.size, mtimeMs: info.mtimeMs };
        }
        return { path: rel, dir: false };
      }),
  );
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
}

function projectEntries(at: InProject): Promise<ProjectEntry[]> {
  const hit = cache.get(at.key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries;
  const entries = listFiles(at).then(withDirs);
  cache.set(at.key, { at: Date.now(), entries });
  entries.catch(() => cache.delete(at.key));
  return entries;
}

/** 项目里的文件（相对路径，/ 分隔）：git 仓库用 git ls-files（含未跟踪、不含忽略的），否则自己遍历 */
async function listFiles({ fs, p, root }: InProject): Promise<string[]> {
  const git = await fs.gitFiles(root);
  if (git) return git;
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const dirents = await fs.readdir(p.join(root, rel)).catch(() => []);
    for (const d of dirents) {
      if (files.length >= MAX_FILES) return;
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory) {
        if (!SKIP.has(d.name)) await walk(child);
      } else files.push(child);
    }
  };
  if (!(await fs.stat(root).catch(() => null))?.isDirectory) throw new BadRequestError(`文件夹不存在：${root}`);
  await walk("");
  return files;
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
