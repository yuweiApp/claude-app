import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";

/**
 * GET /folders?path=：列出网关这台机器上一个文件夹里的子文件夹（不含文件），给新会话的「选择文件夹」浏览用。
 * 不传 path 时是用户主目录；支持 ~。隐藏文件夹（. 开头）排在后面
 */
export function folderRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>("/folders", async (req) => {
    const home = os.homedir();
    const raw = req.query.path?.trim() || home;
    const expanded = raw.replace(/^~(?=$|\/)/, home);
    if (!path.isAbsolute(expanded)) throw new BadRequestError(`请填写绝对路径：${raw}`);
    const dir = path.resolve(expanded);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) throw new BadRequestError(`文件夹不存在：${dir}`);
    const dirents = await readdir(dir, { withFileTypes: true }).catch((err: Error) => {
      throw new BadRequestError(`读不了这个文件夹：${err.message}`);
    });
    const entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
      .sort((a, b) => Number(a.name.startsWith(".")) - Number(b.name.startsWith(".")) || a.name.localeCompare(b.name));
    return { path: dir, parent: dir === path.dirname(dir) ? null : path.dirname(dir), home, entries };
  });
}
