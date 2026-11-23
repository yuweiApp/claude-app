import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { FileContent, FileEncoding } from "../../shared/types.js";
import { PAGE_PICKER_SCRIPT } from "../../shared/page-picker.js";
import { BadRequestError } from "../../errors.js";
import { attachmentHeader, AUDIO_TYPES, decodeText, detectEncoding, ENCODINGS, encodeText, IMAGE_TYPES, PAGE_TYPES, parseRange, RAW_TYPES, VIDEO_TYPES } from "../../files/content.js";
import { forgetProjectFiles, listDir, projectEntries, search } from "../../files/project-list.js";
import { exists, fsError, isInside, resolveChild, resolveInProject, statOr400 } from "../../files/project-path.js";
import { uploadDir, uploadInto } from "../../files/upload.js";

/** 右侧面板直接显示的文本文件上限 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** 二进制的文档：PDF 和 Office（含老的 .doc、.xls、.ppt），扩展名同网页的 officeKind */
const BINARY_DOCUMENTS = new Set(
  [".pdf", ".doc", ".xls", ".ppt"].concat(
    ["docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "pptx", "pptm", "potx", "potm", "ppsx", "ppsm"].map((e) => `.${e}`),
  ),
);
/** 右侧面板保存 Office 文档（/files/write-bytes）的上限 */
const MAX_BINARY_WRITE_BYTES = 200 * 1024 * 1024;

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

/** 地址里带着文件修改时间的响应：内容变了地址就变 */
const CACHE_FOREVER = "private, max-age=31536000, immutable";

/**
 * GET /files?cwd=&q=：输入框里 @ 引用文件用。
 * q 为空列项目文件夹第一层；q 以 / 结尾且是文件夹时列这个文件夹；否则在整个项目里搜（git 仓库按 .gitignore 过滤）
 */
export function fileRoutes(app: FastifyInstance): void {
  // /files/write-bytes 的请求体：原样的字节
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

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
    const info = await statOr400(fs, abs, "文件夹");
    if (!info.isDirectory) throw new BadRequestError("不是文件夹");
    await fs.readdir(abs).catch((err: NodeJS.ErrnoException) => {
      throw new BadRequestError(fsError(err, "文件夹"));
    });
    throw new BadRequestError("文件夹读取失败");
  });

  // 右侧面板查看文件：文本直接给内容，图片、音视频让网页用 /files/raw 取
  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/read", async (req): Promise<FileContent> => {
    const { fs, p, abs } = resolveInProject(req.query.cwd, req.query.path);
    const info = await statOr400(fs, abs, "文件");
    if (!info.isFile) throw new BadRequestError(info.isDirectory ? "是文件夹，不是文件" : "不是普通文件");
    const rel = req.query.path ?? "";
    const meta = { path: rel, size: info.size, mtimeMs: info.mtimeMs };
    const ext = p.extname(abs).toLowerCase();
    if (IMAGE_TYPES[ext]) return { ...meta, kind: "image" };
    if (VIDEO_TYPES[ext]) return { ...meta, kind: "video" };
    if (AUDIO_TYPES[ext]) return { ...meta, kind: "audio" };
    // PDF、Office 文档网页按扩展名另外取（PDF 用预览地址，Office 用 /files/download），这里不读内容：远程项目整份读一遍要好几秒，读出来也只是被当成乱码文本
    if (BINARY_DOCUMENTS.has(ext)) return { ...meta, kind: "binary" };
    if (info.size > MAX_TEXT_BYTES) return { ...meta, kind: "too-large" };
    const buf = await fs.readFile(abs).catch((err: NodeJS.ErrnoException) => {
      throw new BadRequestError(fsError(err, "文件"));
    });
    const encoding = detectEncoding(buf);
    if (!encoding) return { ...meta, kind: "binary" };
    return { ...meta, kind: "text", text: decodeText(buf, encoding), encoding };
  });

  // 右侧面板编辑后保存（Ctrl+S）：mtimeMs 是读的时候的修改时间，对不上说明期间被改过（Claude 改了、终端里改了），不覆盖，除非 force
  // encoding 是读的时候认出来的编码，按它写回去（GBK 的文件保存后还是 GBK）
  app.post<{ Body: { cwd?: string; path?: string; text?: string; mtimeMs?: number; force?: boolean; encoding?: FileEncoding } }>("/files/write", async (req, reply) => {
    const { fs, abs } = resolveInProject(req.body?.cwd, req.body?.path);
    if (typeof req.body?.text !== "string") throw new BadRequestError("缺少文件内容");
    const info = await fs.stat(abs).catch(() => null);
    if (!info?.isFile) throw new BadRequestError("文件不存在");
    if (!req.body.force && req.body.mtimeMs !== undefined && Math.abs(info.mtimeMs - req.body.mtimeMs) > 1) {
      return reply.code(409).send({ error: "文件在打开之后被修改过", mtimeMs: info.mtimeMs });
    }
    const encoding = req.body.encoding ?? "utf-8";
    if (!ENCODINGS.has(encoding)) throw new BadRequestError("不支持的编码");
    await fs.writeFile(abs, encodeText(req.body.text, encoding));
    const after = await fs.stat(abs);
    return { mtimeMs: after.mtimeMs, size: after.size };
  });

  // 右侧面板改了 Office 文档（docx、xlsx、pptx）后保存：请求体是整个文件的字节（application/octet-stream），参数在地址里，
  // 冲突的规则同 /files/write
  app.post<{ Querystring: { cwd?: string; path?: string; mtimeMs?: string; force?: string } }>("/files/write-bytes", { bodyLimit: MAX_BINARY_WRITE_BYTES }, async (req, reply) => {
    const { fs, abs } = resolveInProject(req.query.cwd, req.query.path);
    const body = req.body;
    if (!Buffer.isBuffer(body)) throw new BadRequestError("缺少文件内容");
    const info = await fs.stat(abs).catch(() => null);
    if (!info?.isFile) throw new BadRequestError("文件不存在");
    const mtimeMs = Number(req.query.mtimeMs);
    if (req.query.force !== "1" && Number.isFinite(mtimeMs) && Math.abs(info.mtimeMs - mtimeMs) > 1) {
      return reply.code(409).send({ error: "文件在打开之后被修改过", mtimeMs: info.mtimeMs });
    }
    await fs.writeFile(abs, body).catch((err: NodeJS.ErrnoException) => {
      // Windows 上文件正被 Word、Excel、PowerPoint 打开着时写不进去
      const locked = err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES";
      throw new BadRequestError(locked ? "文件写不进去：可能正被别的程序打开着，或者没有权限" : `文件写入失败：${err.code ?? err.message}`);
    });
    const after = await fs.stat(abs);
    return { mtimeMs: after.mtimeMs, size: after.size };
  });

  // 文件树右键「新建文件」「新建文件夹」：已经有同名的不覆盖
  app.post<{ Body: { cwd?: string; path?: string; dir?: boolean } }>("/files/create", async (req) => {
    const { key, fs, p, abs } = resolveChild(req.body?.cwd, req.body?.path);
    if (await exists(fs, abs)) throw new BadRequestError("已经有同名的文件或文件夹");
    if (!(await fs.stat(p.dirname(abs)).catch(() => null))?.isDirectory) throw new BadRequestError("所在的文件夹不存在");
    if (req.body.dir) await fs.mkdir(abs);
    else await fs.writeFile(abs, "", { exclusive: true });
    forgetProjectFiles(key);
    return {};
  });

  // 文件树右键「删除」：直接删掉（文件夹连同里面的东西），网页上先确认
  app.post<{ Body: { cwd?: string; path?: string } }>("/files/delete", async (req) => {
    const { key, fs, abs } = resolveChild(req.body?.cwd, req.body?.path);
    if (!(await exists(fs, abs))) throw new BadRequestError("文件不存在");
    await fs.rm(abs);
    forgetProjectFiles(key);
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
    forgetProjectFiles(key);
    return {};
  });

  // 文件树「上传文件」（网页版、网关不在本机时，桌面版连本机网关走 /files/transfers）：multipart，可以一次传多个，
  // 存进 dir（相对项目文件夹，空是根），不受 MAX_UPLOAD_MB 限制。同名的处理见 uploadInto；一个出错后面的不再传，前面传好了的留着
  app.post<{ Querystring: { cwd?: string; dir?: string; overwrite?: string } }>("/files/upload", async (req) => {
    const at = resolveInProject(req.query.cwd, req.query.dir);
    await uploadDir(at);
    const uploaded: string[] = [];
    try {
      for await (const part of req.files({ limits: { fileSize: Infinity, files: 1000 } })) {
        await uploadInto(at, part.filename, req.query.overwrite === "1", async (tmp) => {
          const out = await at.fs.openWriteStream(tmp, { exclusive: true });
          await pipeline(part.file, out);
          // 流写完时文件句柄可能还没关（Windows 上开着的文件改不了名），等它关掉
          if (!out.closed) await once(out, "close");
        });
        uploaded.push(part.filename);
      }
    } finally {
      forgetProjectFiles(at.key);
    }
    return { uploaded };
  });

  // 文件树右键「下载」：整个文件作为附件返回，浏览器存到它的下载位置（桌面版弹出保存对话框）；文件夹不行
  app.get<{ Querystring: { cwd?: string; path?: string } }>("/files/download", async (req, reply) => {
    const { fs, p, abs } = resolveInProject(req.query.cwd, req.query.path);
    const info = await statOr400(fs, abs, "文件");
    if (!info.isFile) throw new BadRequestError(info.isDirectory ? "只能下载文件，不能下载文件夹" : "不是普通文件");
    return reply
      .type("application/octet-stream")
      .header("content-disposition", attachmentHeader(p.basename(abs)))
      .header("content-length", info.size)
      .header("cache-control", "no-store")
      .send(fs.createReadStream(abs));
  });

  // Claude 回复里的行内代码像文件路径时，网页来问是不是工作目录里存在的文件（是就显示成文件链接）；paths 相对项目文件夹
  app.post<{ Body: { cwd: string; paths: string[] } }>("/files/exists", async (req) => {
    const paths = req.body.paths.slice(0, 200);
    const checked = await Promise.all(
      paths.map(async (rel) => {
        try {
          const { fs, abs } = resolveInProject(req.body.cwd, rel);
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
  // HTML 末尾接上标注用的脚本（见 shared/page-picker.ts）
  app.get<{ Params: { id: string; "*": string }; Querystring: { v?: string } }>(`${PAGE_PREFIX}:id/*`, async (req, reply) => {
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
      // PDF 预览的地址带着修改时间（v），同上可以一直缓存；网页（和它引用的文件）不缓存，改了刷新就能看到
      .header("cache-control", ext === ".pdf" && req.query.v ? CACHE_FOREVER : "no-store")
      .send(body);
  });

  app.get<{ Querystring: { cwd?: string; path?: string; v?: string } }>("/files/raw", async (req, reply) => {
    const { fs, p, abs } = resolveInProject(req.query.cwd, req.query.path);
    const info = await fs.stat(abs).catch(() => null);
    if (!info?.isFile) throw new BadRequestError("文件不存在");
    const type = RAW_TYPES[p.extname(abs).toLowerCase()];
    if (!type) throw new BadRequestError("只能直接取图片、音频、视频");
    // svg 里可以有脚本，按附件的 CSP 禁掉
    reply.type(type).header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").header("accept-ranges", "bytes");
    // 地址带着修改时间（v）的（目录树的缩略图、预览的图片）：文件改了地址就变，浏览器可以一直用缓存的，不用每次重新下载
    if (req.query.v) reply.header("cache-control", CACHE_FOREVER);
    // 音视频拖进度条时浏览器按 Range 取一段
    const range = parseRange(req.headers.range, info.size);
    if (range === "invalid") return reply.code(416).header("content-range", `bytes */${info.size}`).send();
    if (range) {
      return reply
        .code(206)
        .header("content-range", `bytes ${range.start}-${range.end}/${info.size}`)
        .header("content-length", range.end - range.start + 1)
        .send(fs.createReadStream(abs, range));
    }
    return reply.header("content-length", info.size).send(fs.createReadStream(abs));
  });
}
