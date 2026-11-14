import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { SFTPWrapper, Stats } from "ssh2";
import type { SshHost } from "./host.js";
import { sshHost } from "./hosts.js";
import { nativePath, parseRemote } from "./location.js";
import { gitFiles, mkdirp, rmrf } from "./remote-ops.js";

const run = promisify(execFile);

/**
 * 右侧面板的文件、新会话的「选择文件夹」用的文件操作：本机直接用 fs，远程会话的工作目录（ssh://…）经 SFTP。
 * 远端的路径是 posix 写法（Windows 远端是 /C:/…，见 location.ts）
 */
export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  /** 同一个文件（大小写不敏感的文件系统上只改大小写时）；远端拿不到，按路径比 */
  id?: string;
}

export interface CopyOptions {
  /** 取消：传到一半停下，报 AbortError，写了一半的文件留给调用方删 */
  signal: AbortSignal;
  /** 已经传了多少字节 */
  onProgress(bytes: number): void;
}

export interface FsDirent {
  name: string;
  isDirectory: boolean;
}

export interface HostFs {
  /** 路径函数：本机是 path，远端是 path.posix */
  path: typeof path.posix;
  /** 用户目录 */
  home(): Promise<string>;
  stat(p: string): Promise<FsStat>;
  readdir(p: string): Promise<FsDirent[]>;
  readFile(p: string): Promise<Buffer>;
  /** exclusive：已经存在就报 EEXIST */
  writeFile(p: string, data: Buffer | string, opts?: { exclusive?: boolean }): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  /** 连同里面的东西删掉 */
  rm(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** range：只读这一段，end 含在内 */
  createReadStream(p: string, range?: { start: number; end: number }): Readable;
  /** 写文件的流，文件打开之后才返回（打不开在这里报错）；exclusive：已经存在就报 EEXIST，否则覆盖 */
  openWriteStream(p: string, opts?: { exclusive?: boolean }): Promise<Writable>;
  /** 网关这台机器上的文件 local 复制到 p（这台机器上）；远端单独开一个 SFTP 通道、同时发多个请求。p 已经存在时覆盖 */
  putFile(local: string, p: string, opts: CopyOptions): Promise<void>;
  /** p（这台机器上）复制到网关这台机器上的 local；同上 */
  getFile(p: string, local: string, opts: CopyOptions): Promise<void>;
  /** git 仓库里的文件（含未跟踪、不含忽略的）；不是 git 仓库时 null */
  gitFiles(cwd: string): Promise<string[] | null>;
}

/** cwd 是本机路径还是 ssh://…；远端的返回去掉前缀的路径 */
/**
 * 给模型看的路径：工作目录在 Windows 远端时，/C:/Users/x 换成 C:\Users\x（模型在那台机器上，按它的写法用）；
 * 本机、macOS、Linux 远端原样。p 是 fsFor 那套写法的路径，cwd 是会话的工作目录（决定是哪台机器）
 */
export function machinePathOf(cwd: string, p: string): string {
  const remote = parseRemote(cwd);
  return remote ? nativePath(sshHost(remote.host).windows, p) : p;
}

export function fsFor(cwd: string): { fs: HostFs; root: string; host?: string } {
  const remote = parseRemote(cwd);
  if (!remote) return { fs: localFs, root: cwd };
  return { fs: remoteFs(sshHost(remote.host)), root: remote.path, host: remote.host };
}

export const localFs: HostFs = {
  path,
  home: async () => os.homedir(),
  async stat(p) {
    const s = await stat(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, id: `${s.dev}:${s.ino}` };
  },
  async readdir(p) {
    return (await readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  },
  readFile: (p) => readFile(p),
  writeFile: (p, data, opts) => writeFile(p, data, opts?.exclusive ? { flag: "wx" } : undefined),
  mkdir: async (p, opts) => {
    await mkdir(p, opts);
  },
  rm: (p) => rm(p, { recursive: true, force: true }),
  rename: (a, b) => rename(a, b),
  createReadStream: (p, range) => createReadStream(p, range),
  async openWriteStream(p, opts) {
    const handle = await open(p, opts?.exclusive ? "wx" : "w");
    return handle.createWriteStream();
  },
  putFile: localCopy,
  getFile: localCopy,
  async gitFiles(cwd) {
    try {
      const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd, maxBuffer: 64 * 1024 * 1024 });
      return stdout.split("\0").filter(Boolean);
    } catch {
      return null;
    }
  },
};

/** 本机上复制，边复制边报进度 */
async function localCopy(from: string, to: string, { signal, onProgress }: CopyOptions): Promise<void> {
  let done = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      onProgress(done);
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(from), count, createWriteStream(to), { signal });
}

/**
 * ssh2 的 fastPut、fastGet：同时有 64 个 32KB 的读写请求在路上（读写流一次只发一个，速度被往返延迟卡住）。
 * 每次单独开一个 SFTP 通道，取消时关掉通道，进行中的请求都会失败、传输结束
 */
async function sftpCopy(host: SshHost, kind: "put" | "get", from: string, to: string, { signal, onProgress }: CopyOptions): Promise<void> {
  signal.throwIfAborted();
  const s = await host.openSftp();
  const stop = () => s.end();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const opts = { concurrency: 64, chunkSize: 32 * 1024, step: (done: number) => onProgress(done) };
      const cb = (err: Error | null | undefined) => (err ? reject(err) : resolve());
      if (kind === "put") s.fastPut(from, to, opts, cb);
      else s.fastGet(from, to, opts, cb);
    });
  } catch (err) {
    signal.throwIfAborted();
    throw kind === "put" ? nodeError(err, to) : nodeError(err, from);
  } finally {
    signal.removeEventListener("abort", stop);
    s.end();
  }
  signal.throwIfAborted();
}

/** 远端读流一次读的大小 */
const READ_CHUNK = 64 * 1024;

const fsCache = new WeakMap<SshHost, HostFs>();

export function remoteFs(host: SshHost): HostFs {
  let fs = fsCache.get(host);
  if (!fs) {
    fs = createRemoteFs(host);
    fsCache.set(host, fs);
  }
  return fs;
}

/** SFTP 的状态码换成 Node 的错误码，报错文字（fsError）按它来 */
function nodeError(err: unknown, p: string): Error {
  const e = err as Error & { code?: number | string };
  const code = e.code === 2 ? "ENOENT" : e.code === 3 ? "EACCES" : e.code === 4 && /exist/i.test(e.message) ? "EEXIST" : typeof e.code === "string" ? e.code : "EIO";
  return Object.assign(new Error(`${e.message}: ${p}`), { code });
}

function call<T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void, p: string): Promise<T> {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(nodeError(err, p)) : resolve(value as T))));
}

function toStat(s: Stats): FsStat {
  return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtime * 1000 };
}

function createRemoteFs(host: SshHost): HostFs {
  const sftp = () => host.sftp();
  return {
    path: path.posix,
    async home() {
      await host.ensureReady();
      return host.env!.home;
    },
    async stat(p) {
      const s = await sftp();
      return toStat(await call<Stats>((cb) => s.stat(p, cb), p));
    },
    async readdir(p) {
      const s = await sftp();
      const list = await call<{ filename: string; attrs: Stats }[]>((cb) => s.readdir(p, cb), p);
      // 符号链接按它指向的算：readdir 给的是链接本身的属性
      return Promise.all(
        list.map(async (e) => {
          let isDirectory = e.attrs.isDirectory();
          if (e.attrs.isSymbolicLink()) isDirectory = await call<Stats>((cb) => s.stat(path.posix.join(p, e.filename), cb), p).then((st) => st.isDirectory(), () => false);
          return { name: e.filename, isDirectory };
        }),
      );
    },
    async readFile(p) {
      const s = await sftp();
      return call<Buffer>((cb) => s.readFile(p, cb), p);
    },
    async writeFile(p, data, opts) {
      const s = await sftp();
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      if (!opts?.exclusive) return call<void>((cb) => s.writeFile(p, buf, cb), p);
      // wx：已存在就失败
      const handle = await call<Buffer>((cb) => s.open(p, "wx", cb), p);
      try {
        let off = 0;
        while (off < buf.length) {
          const n = Math.min(32 * 1024, buf.length - off);
          await call<number>((cb) => s.write(handle, buf, off, n, off, cb), p);
          off += n;
        }
      } finally {
        await call<void>((cb) => s.close(handle, cb), p).catch(() => undefined);
      }
    },
    async mkdir(p, opts) {
      if (opts?.recursive) {
        await mkdirp(host, p);
        return;
      }
      const s = await sftp();
      await call<void>((cb) => s.mkdir(p, cb), p);
    },
    async rm(p) {
      await rmrf(host, p);
    },
    async rename(a, b) {
      const s = await sftp();
      await call<void>((cb) => s.rename(a, b, cb), a);
    },
    createReadStream(p, range) {
      // 不用 ssh2 的 createReadStream：Windows 远端上读完后文件句柄没有关，文件一直删不掉、覆盖不了（预览过的图片、下载过的文件），
      // 要等 SSH 连接断开。这里自己开句柄，读完、出错、提前断开（destroy）都关掉
      let s: SFTPWrapper | undefined;
      let handle: Buffer | null = null;
      let pos = range?.start ?? 0;
      const end = range ? range.end : Infinity;
      return new Readable({
        highWaterMark: READ_CHUNK,
        construct(cb) {
          sftp()
            .then(async (conn) => {
              s = conn;
              handle = await call<Buffer>((done) => conn.open(p, "r", done), p);
            })
            .then(() => cb(), (err: Error) => cb(err));
        },
        read() {
          const len = Math.min(READ_CHUNK, end - pos + 1);
          if (len <= 0 || !s || !handle) return void this.push(null);
          const buf = Buffer.allocUnsafe(len);
          s.read(handle, buf, 0, len, pos, (err, n) => {
            if (err) return void this.destroy(nodeError(err, p));
            if (!n) return void this.push(null);
            pos += n;
            this.push(n < len ? buf.subarray(0, n) : buf);
          });
        },
        destroy(err, cb) {
          const h = handle;
          handle = null;
          if (!s || !h) return cb(err);
          s.close(h, () => cb(err));
        },
      });
    },
    async openWriteStream(p, opts) {
      const s = await sftp();
      const handle = await call<Buffer>((cb) => s.open(p, opts?.exclusive ? "wx" : "w", cb), p);
      return s.createWriteStream(p, { handle });
    },
    putFile: (local, p, opts) => sftpCopy(host, "put", local, p, opts),
    getFile: (p, local, opts) => sftpCopy(host, "get", p, local, opts),
    gitFiles: (cwd) => gitFiles(host, cwd),
  };
}
