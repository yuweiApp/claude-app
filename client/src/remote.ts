/**
 * 远程会话的工作目录写成 ssh://<连接 id><远端路径>（网关的 gateway/src/ssh/location.ts），网页大多数地方把它当普通的 cwd 传；
 * 要显示、要和模型写的绝对路径比的地方用这里的函数拆开。
 * Windows 远端的路径在 ssh:// 里是 /C:/Users/x 的写法（同 SFTP），显示、复制、和模型写的路径比时换成 C:\Users\x（machinePath）
 */
export const SSH_PREFIX = "ssh://";

export interface RemoteCwd {
  host: string;
  /** 远端的绝对路径；ssh://<id> 时是空串 */
  path: string;
}

export function parseRemote(cwd: string | null | undefined): RemoteCwd | null {
  if (!cwd?.startsWith(SSH_PREFIX)) return null;
  const rest = cwd.slice(SSH_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? { host: rest, path: "" } : { host: rest.slice(0, slash), path: rest.slice(slash) };
}

export const isRemote = (cwd: string | null | undefined) => Boolean(cwd?.startsWith(SSH_PREFIX));

/** 那台机器上的路径：远程的去掉 ssh://<id>（Windows 远端换成 C:\… 的写法），本机的原样 */
export const machinePath = (cwd: string) => {
  const remote = parseRemote(cwd);
  if (!remote) return cwd;
  const m = /^\/([A-Za-z]:)(\/.*)?$/.exec(remote.path);
  return m ? `${m[1]!.toUpperCase()}${(m[2] ?? "/").replaceAll("/", "\\")}` : remote.path;
};

/** path 可以是 Windows 的写法（C:\…、C:/…），换成 /C:/… */
export const remoteUri = (host: string, path = "") => {
  const win = /^[A-Za-z]:(?=$|[\\/])/.test(path);
  const p = win ? `/${path[0]!.toUpperCase()}:${path.slice(2).replaceAll("\\", "/").replace(/\/+$/, "") || "/"}` : path;
  return `${SSH_PREFIX}${host}${p}`;
};
