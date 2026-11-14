import { randomBytes } from "node:crypto";
import { stat, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import type { FileTransfer } from "../../shared/types.js";
import { fsError, resolveInProject, uploadDir, uploadInto, type InProject } from "./files.js";

/**
 * 文件树的上传、下载（桌面版连着本机的网关时）：界面给出文件在这台机器上的路径（拖进来的文件、系统的打开/保存对话框），
 * 网关直接在这个路径和项目里的路径之间复制，内容不经过 HTTP。远程会话经 SFTP（HostFs 的 putFile、getFile）。
 * 同一个项目一次传一个，其余排队；记录在内存里，结束了的留着给界面显示，界面关掉（DELETE）或一小时后删掉
 */
interface Entry extends FileTransfer {
  abort: AbortController;
  /** 上传：已经有同名文件时覆盖（界面先问过） */
  overwrite: boolean;
  startedAt?: number;
  endedAt?: number;
}

const transfers = new Map<string, Entry>();
/** 每个项目的队列：上一个传完（不管成败）再开始下一个 */
const queues = new Map<string, Promise<void>>();
const KEEP_MS = 60 * 60 * 1000;

function view(t: Entry): FileTransfer {
  const { abort: _a, overwrite: _o, startedAt, endedAt, ...rest } = t;
  const ms = startedAt ? (endedAt ?? Date.now()) - startedAt : 0;
  return { ...rest, speed: ms > 0 ? Math.round((t.done / ms) * 1000) : 0 };
}

function prune(): void {
  const now = Date.now();
  for (const [id, t] of transfers) if (t.endedAt && now - t.endedAt > KEEP_MS) transfers.delete(id);
}

/** 网关这台机器上的路径：要是绝对路径 */
function localPath(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new BadRequestError("缺少本机路径");
  return path.resolve(value);
}

function errorText(err: unknown): string {
  if (err instanceof BadRequestError) return err.message;
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOSPC") return "磁盘空间不够";
  if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "EPERM") return fsError(e, "文件");
  return e.message || String(err);
}

function enqueue(t: Entry, at: InProject): void {
  transfers.set(t.id, t);
  const prev = queues.get(t.cwd) ?? Promise.resolve();
  const next = prev.then(() => run(t, at));
  queues.set(t.cwd, next);
  void next.finally(() => queues.get(t.cwd) === next && queues.delete(t.cwd));
}

async function run(t: Entry, at: InProject): Promise<void> {
  const { signal } = t.abort;
  if (signal.aborted) return;
  t.state = "running";
  t.startedAt = Date.now();
  const opts = { signal, onProgress: (n: number) => (t.done = n) };
  try {
    if (t.kind === "upload") {
      await uploadInto(at, t.name, t.overwrite, (tmp) => at.fs.putFile(t.local, tmp, opts));
    } else {
      // 先存成同一个文件夹里的 .part，传完再改成要的名字（保存对话框里已经确认过覆盖）
      const tmp = `${t.local}.${randomBytes(4).toString("hex")}.part`;
      try {
        await at.fs.getFile(at.abs, tmp, opts);
        await rename(tmp, t.local);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    }
    t.state = "done";
    t.done = t.total;
  } catch (err) {
    if (signal.aborted) return;
    t.state = "error";
    t.error = errorText(err);
  } finally {
    t.endedAt = Date.now();
  }
}

export function transferRoutes(app: FastifyInstance): void {
  // 上传 { cwd, kind: "upload", dir, locals, overwrite? }：locals 是这台机器上的文件，传进项目里的文件夹 dir（空是根）；不能是文件夹。
  // 下载 { cwd, kind: "download", path, local }：项目里的文件 path 存到这台机器上的 local（已经有的覆盖）。
  // 先返回记录，在后台传，GET 查进度
  app.post<{ Body: { cwd?: string; kind?: string; dir?: string; locals?: unknown; path?: string; local?: unknown; overwrite?: boolean } }>("/files/transfers", async (req) => {
    prune();
    const body = req.body ?? {};
    const cwd = body.cwd ?? "";
    const base = { cwd, state: "queued" as const, done: 0, speed: 0, abort: new AbortController() };
    const created: Entry[] = [];
    if (body.kind === "upload") {
      const at = resolveInProject(body.cwd, body.dir);
      await uploadDir(at);
      const locals = Array.isArray(body.locals) ? body.locals.map(localPath) : [];
      if (!locals.length) throw new BadRequestError("没有要上传的文件");
      const sizes = await Promise.all(
        locals.map(async (local) => {
          const info = await stat(local).catch((err: NodeJS.ErrnoException) => {
            throw new BadRequestError(`${fsError(err, "文件")}：${local}`);
          });
          if (info.isDirectory()) throw new BadRequestError(`不能上传文件夹：${path.basename(local)}`);
          if (!info.isFile()) throw new BadRequestError(`不是普通文件：${local}`);
          return info.size;
        }),
      );
      const dir = at.p.relative(at.root, at.abs).split(at.p.sep).join("/");
      locals.forEach((local, i) => {
        const name = path.basename(local);
        const t: Entry = { ...base, abort: new AbortController(), id: randomBytes(8).toString("hex"), kind: "upload", name, path: dir ? `${dir}/${name}` : name, local, total: sizes[i]!, overwrite: body.overwrite === true };
        created.push(t);
        enqueue(t, at);
      });
    } else if (body.kind === "download") {
      const at = resolveInProject(body.cwd, body.path);
      const local = localPath(body.local);
      const info = await at.fs.stat(at.abs).catch((err: NodeJS.ErrnoException) => {
        throw new BadRequestError(fsError(err, "文件"));
      });
      if (!info.isFile) throw new BadRequestError(info.isDirectory ? "只能下载文件，不能下载文件夹" : "不是普通文件");
      if (!(await stat(path.dirname(local)).catch(() => null))?.isDirectory()) throw new BadRequestError("存到的文件夹不存在");
      const t: Entry = { ...base, id: randomBytes(8).toString("hex"), kind: "download", name: path.basename(local), path: body.path ?? "", local, total: info.size, overwrite: false };
      created.push(t);
      enqueue(t, at);
    } else throw new BadRequestError("kind 要是 upload 或 download");
    return { transfers: created.map(view) };
  });

  // 一个项目的传输（排队的、进行中的、结束了还没关掉的）
  app.get<{ Querystring: { cwd?: string } }>("/files/transfers", async (req) => {
    prune();
    return { transfers: [...transfers.values()].filter((t) => t.cwd === req.query.cwd).map(view) };
  });

  // 取消（排队的、进行中的；写了一半的文件删掉）或者关掉结束了的
  app.delete<{ Params: { id: string } }>("/files/transfers/:id", async (req) => {
    const t = transfers.get(req.params.id);
    if (t) {
      t.abort.abort();
      transfers.delete(t.id);
    }
    return {};
  });
}
