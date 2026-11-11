import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SFTPWrapper } from "ssh2";
import { decodeText, psQuote, shQuote, type SshHost } from "./host.js";
import { nativePath } from "./location.js";

/**
 * 远端的几样文件操作，按远端的系统用 sh 或 PowerShell 写。路径都是 posix 写法（Windows 是 /C:/…，见 location.ts）。
 * Windows 上 PowerShell 从标准输入读数据不可靠（实测偶尔一直读不到，连接断了也不退出），要传数据的都走 SFTP
 */
const win = (p: string) => psQuote(nativePath(true, p));

async function run(host: SshHost, sh: string, ps: string, stdin?: string, timeoutMs = 60_000): Promise<Buffer> {
  const r = await host.exec(host.windows ? ps : sh, { stdin, timeoutMs });
  if (r.code !== 0) throw Object.assign(new Error(r.stderr.trim() || `退出码 ${r.code}`), { code: "EIO" });
  return r.stdout;
}

/** 建目录，连同上级 */
export async function mkdirp(host: SshHost, p: string): Promise<void> {
  await run(host, `mkdir -p -- ${shQuote(p)}`, `New-Item -ItemType Directory -Force -Path ${win(p)} | Out-Null`);
}

/** 连同里面的东西删掉，不存在的跳过 */
export async function rmrf(host: SshHost, ...paths: string[]): Promise<void> {
  if (!paths.length) return;
  await run(
    host,
    `rm -rf -- ${paths.map(shQuote).join(" ")}`,
    paths.map((p) => `if (Test-Path -LiteralPath ${win(p)}) { Remove-Item -LiteralPath ${win(p)} -Recurse -Force }`).join("\n"),
  );
}

/** 删空目录，不空、不存在的跳过，不报错 */
export async function rmdirQuiet(host: SshHost, ...paths: string[]): Promise<void> {
  await run(
    host,
    `rmdir -- ${paths.map(shQuote).join(" ")} 2>/dev/null; true`,
    paths
      .map((p) => `$d = Get-Item -LiteralPath ${win(p)} -Force -ErrorAction SilentlyContinue; if ($d -and $d.PSIsContainer -and -not ($d.GetFileSystemInfos())) { Remove-Item -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue }`)
      .join("\n"),
  ).catch(() => undefined);
}

/** 追加到文件末尾 */
export async function appendText(host: SshHost, p: string, text: string): Promise<void> {
  if (!host.windows) {
    await run(host, `cat >> ${shQuote(p)}`, "", text, 30_000);
    return;
  }
  await sftpAppend(await host.sftp(), p, Buffer.from(text, "utf8"));
}

const sftpCall = <T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))));

/** SFTP 写整个文件（覆盖） */
export function sftpWrite(sftp: SFTPWrapper, p: string, data: Buffer): Promise<void> {
  return sftpCall<void>((cb) => sftp.writeFile(p, data, cb));
}

/** SFTP 追加：按文件现在的大小定位写（不靠 SFTP 的追加标志） */
export async function sftpAppend(sftp: SFTPWrapper, p: string, data: Buffer): Promise<void> {
  const handle = await sftpCall<Buffer>((cb) => sftp.open(p, "r+", cb));
  try {
    const { size } = await sftpCall<{ size: number }>((cb) => sftp.fstat(handle, cb));
    let off = 0;
    while (off < data.length) {
      const n = Math.min(32 * 1024, data.length - off);
      await sftpCall<void>((cb) => sftp.write(handle, data, off, n, size + off, cb));
      off += n;
    }
  } finally {
    await sftpCall<void>((cb) => sftp.close(handle, cb)).catch(() => undefined);
  }
}

/** SFTP 上传一个流 */
export async function sftpUpload(sftp: SFTPWrapper, p: string, source: Readable): Promise<void> {
  await pipeline(source, sftp.createWriteStream(p));
}

/** git 仓库里的文件（含未跟踪、不含忽略的）；不是 git 仓库、没有 git 时 null */
export async function gitFiles(host: SshHost, cwd: string): Promise<string[] | null> {
  const r = await host.exec(
    host.windows
      ? // PowerShell 按行转发原生程序的输出，\0 分隔不可靠：按行分，路径里的中文不转义
        `git -C ${win(cwd)} -c core.quotepath=false ls-files --cached --others --exclude-standard; exit $LASTEXITCODE`
      : `cd -- ${shQuote(cwd)} && git ls-files --cached --others --exclude-standard -z`,
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) return null;
  return decodeText(r.stdout).split(host.windows ? /\r?\n/ : "\0").filter(Boolean);
}
