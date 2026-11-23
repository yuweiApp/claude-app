import { fsFor, type HostFs } from "../ssh/host-fs.js";
import { BadRequestError } from "../errors.js";

/** 本机是 path，远程会话（cwd 是 ssh://…，见 ssh/host-fs.ts）是 path.posix */
type PathLib = HostFs["path"];

/** 解析出来的项目里的一个路径：key 是网页传来的 cwd（缓存、预览 id 按它），root 是项目文件夹在那台机器上的路径 */
export interface InProject {
  key: string;
  root: string;
  abs: string;
  fs: HostFs;
  p: PathLib;
}

/** 项目里的路径（/ 分隔的相对路径）转成绝对路径，不能跳出项目文件夹；cwd 可以是远程会话的 ssh://… */
export function resolveInProject(cwd: string | undefined, rel: string | undefined): InProject {
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
export function isInside(p: PathLib, root: string, abs: string): boolean {
  const rel = p.relative(root, abs);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

/** 读文件、文件夹失败的原因，显示在右侧面板里；what 是「文件」或「文件夹」 */
export function fsError(err: NodeJS.ErrnoException, what: string): string {
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

/** 同 resolveInProject，但不能是项目文件夹本身（新建、删除、改名用） */
export function resolveChild(cwd: string | undefined, rel: string | undefined): InProject {
  if (!rel) throw new BadRequestError("缺少路径");
  const resolved = resolveInProject(cwd, rel);
  if (resolved.abs === resolved.root) throw new BadRequestError("不能操作项目文件夹本身");
  return resolved;
}

export const exists = (fs: HostFs, abs: string) => fs.stat(abs).then(() => true, () => false);

/** stat 一个路径，不存在、没有权限等报 400（原因见 fsError） */
export function statOr400(fs: HostFs, abs: string, what: string) {
  return fs.stat(abs).catch((err: NodeJS.ErrnoException) => {
    throw new BadRequestError(fsError(err, what));
  });
}
