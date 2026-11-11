import path from "node:path";

/**
 * 远程会话的工作目录写成 ssh://<连接 id><远端绝对路径>，网页、会话列表、文件和终端接口都把它当普通的 cwd 传。
 * 只有连接 id、没有路径（ssh://<id>）是新建那台主机上的普通会话。
 * 路径都是 posix 写法：Windows 远端写成 SFTP 的样子（/C:/Users/x），交给远端的 claude、PowerShell 时才换成 C:\Users\x（nativePath）
 */
export const SSH_PREFIX = "ssh://";

/** 连接 id：8 个小写字母、数字 */
export const CONNECTION_ID = /^[a-z0-9]{8}$/;

export interface RemoteLocation {
  /** SSH 连接的 id */
  host: string;
  /** 远端的绝对路径（posix，规范化过）；ssh://<id> 时是空串 */
  path: string;
}

/** 不是 ssh:// 开头的返回 null；格式不对的抛错 */
export function parseRemote(cwd: string | undefined | null): RemoteLocation | null {
  if (!cwd?.startsWith(SSH_PREFIX)) return null;
  const rest = cwd.slice(SSH_PREFIX.length);
  const slash = rest.indexOf("/");
  const host = slash === -1 ? rest : rest.slice(0, slash);
  if (!CONNECTION_ID.test(host)) throw new Error(`远程工作目录的格式不对：${cwd}`);
  // Windows 的盘符统一大写（SFTP 不分大小写，/c:/x 和 /C:/x 是同一个目录）
  const p = slash === -1 ? "" : path.posix.normalize(rest.slice(slash)).replace(/^\/([a-z]):(?=$|\/)/, (_, d: string) => `/${d.toUpperCase()}:`);
  return { host, path: p === "/" || !p ? p : p.replace(/\/+$/, "") };
}

/** remotePath 可以是 Windows 写法（远端 claude 记录里的工作目录），换成 /C:/… */
export function remoteUri(host: string, remotePath: string): string {
  return `${SSH_PREFIX}${host}${fromWindowsPath(remotePath)}`;
}

const WIN_DRIVE = /^[A-Za-z]:(?=$|[\\/])/;

/** C:\Users\x → /C:/Users/x；不是盘符开头的原样返回 */
export function fromWindowsPath(p: string): string {
  if (!WIN_DRIVE.test(p)) return p;
  const rest = p.slice(2).replace(/\\/g, "/").replace(/\/+$/, "");
  return `/${p[0]!.toUpperCase()}:${rest || "/"}`;
}

/** /C:/Users/x → C:\Users\x；windows 为假（远端是 macOS、Linux）时原样返回 */
export function nativePath(windows: boolean, p: string): string {
  if (!windows) return p;
  const m = /^\/([A-Za-z]:)(\/.*)?$/.exec(p);
  if (!m) return p.replace(/\//g, "\\");
  return `${m[1]!.toUpperCase()}${(m[2] ?? "/").replace(/\//g, "\\")}`;
}

export const isRemote = (cwd: string | undefined | null): boolean => Boolean(cwd?.startsWith(SSH_PREFIX));
