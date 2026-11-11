import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import { remoteFs } from "../../ssh/host-fs.js";
import { sshHost } from "../../ssh/hosts.js";
import { fromWindowsPath, nativePath, parseRemote, remoteUri } from "../../ssh/location.js";

/**
 * GET /folders?path=：列出网关这台机器上一个文件夹里的子文件夹（不含文件），给新会话的「选择文件夹」浏览用。
 * 不传 path 时是用户主目录；支持 ~。隐藏文件夹（. 开头）排在后面。
 * path 是 ssh://<连接 id>[路径] 时列远端的（连上那台主机），返回的路径也都是 ssh://… 的写法；没有路径时是连接设置里的默认目录或远端用户目录。
 * Windows 远端的 / 列出的是各个盘符（SFTP 就是这样给的）
 */
export function folderRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>("/folders", async (req) => {
    const remote = parseRemoteOrThrow(req.query.path);
    if (remote) return remoteFolders(remote.host, remote.path);
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

function parseRemoteOrThrow(p: string | undefined) {
  try {
    return parseRemote(p?.trim());
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : String(err));
  }
}

async function remoteFolders(hostId: string, requested: string) {
  const host = sshHost(hostId);
  try {
    await host.ensureReady();
  } catch (err) {
    throw new BadRequestError(`连接远程主机「${host.connection.name}」失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const fs = remoteFs(host);
  const home = await fs.home();
  // 默认目录是用户在设置页填的，Windows 远端可能是 C:\… 的写法
  const raw = requested || fromWindowsPath(host.connection.startDirectory ?? "") || home;
  const expanded = raw.replace(/^~(?=$|\/)/, home);
  if (!expanded.startsWith("/")) throw new BadRequestError(`请填写绝对路径：${raw}`);
  const dir = path.posix.resolve(expanded);
  const info = await fs.stat(dir).catch(() => null);
  if (!info?.isDirectory) throw new BadRequestError(`远端文件夹不存在：${nativePath(host.windows, dir)}`);
  const dirents = await fs.readdir(dir).catch((err: Error) => {
    throw new BadRequestError(`读不了这个文件夹：${err.message}`);
  });
  const entries = dirents
    .filter((d) => d.isDirectory)
    .map((d) => ({ name: d.name, path: remoteUri(hostId, path.posix.join(dir, d.name)) }))
    .sort((a, b) => Number(a.name.startsWith(".")) - Number(b.name.startsWith(".")) || a.name.localeCompare(b.name));
  const parent = dir === "/" ? null : remoteUri(hostId, path.posix.dirname(dir));
  return { path: remoteUri(hostId, dir), parent, home: remoteUri(hostId, home), entries };
}
