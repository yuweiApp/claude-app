import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { SFTPWrapper, Stats } from "ssh2";
import { config } from "../config.js";
import type { SshHost } from "./host.js";
import { appendText, killRemoteClaude, rmdirQuiet, rmrf, sftpWrite } from "./remote-ops.js";

/**
 * 远程会话的记录（jsonl）由远端的 claude 写在远端的配置目录里。网关把它们按原样同步到本机配置目录的 projects/ 下（同样的目录名、文件名），
 * 会话列表、历史消息、标题、最后回复时间这些读本机记录的代码不用改，远端没连上时也能列出、查看。
 * 同步是单向的（远端 → 本机）：记录只会在末尾追加，只取新增的部分；远端的比本机短了（被改写过）就整个重新取。
 * 哪些会话是哪台主机的记在 gateway-ssh-sessions.json
 */
interface Manifest {
  sessions: Record<string, { host: string; project?: string }>;
}

const MANIFEST = path.join(config.claudeConfigDir, "gateway-ssh-sessions.json");
const PROJECTS = path.join(config.claudeConfigDir, "projects");
const SESSION_FILE = /^[0-9a-f-]{36}\.jsonl$/;
/** SFTP 的状态码：文件不存在 */
const NO_SUCH_FILE = 2;
/** 列会话时整台主机同步一次的最短间隔 */
const HOST_SYNC_MS = 3_000;

let manifest: Manifest | null = null;
/**
 * 分叉出来、正在传到远端的会话：远端还没有它的记录，整台主机同步时不能当成别处删了。
 * 记着上传用的 SFTP 通道：传的时候删会话要先停掉它，Windows 上远端的文件写着时删不掉
 */
const uploading = new Map<string, { cancel: () => void; done?: Promise<void> }>();
/**
 * 正在删除的会话：删除要先在远端找进程、再删文件，要好几秒；这期间同步不能碰它——
 * 不能把远端还在的记录当成新会话收回来、重新下载，下载时远端的文件开着，Windows 上删不掉
 */
const deleting = new Set<string>();
/** 分叉的记录传完的时刻：整台主机同步开始列目录之后才传完的，列出来的结果里可能没有它，也不能当成别处删了 */
const uploadedAt = new Map<string, number>();

function load(): Manifest {
  if (!manifest) {
    try {
      manifest = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest) : { sessions: {} };
      manifest.sessions ??= {};
    } catch {
      manifest = { sessions: {} };
    }
  }
  return manifest;
}

function save(): void {
  writeFileSync(MANIFEST, `${JSON.stringify(load(), null, 2)}\n`, { mode: 0o600 });
}

/** 远程会话所在的 SSH 连接 id；本机会话是 undefined */
export function remoteSessionHost(sessionId: string): string | undefined {
  return load().sessions[sessionId]?.host;
}

export function remoteSessionIds(hostId: string): string[] {
  return Object.entries(load().sessions).filter(([, v]) => v.host === hostId).map(([id]) => id);
}

/** 这台主机上还有别的会话的记录和它在同一个目录里（同一个工作目录：分叉、清空出来的会话） */
export function remoteProjectShared(sessionId: string): boolean {
  const own = load().sessions[sessionId];
  if (!own?.project) return false;
  return Object.entries(load().sessions).some(([id, v]) => id !== sessionId && v.host === own.host && v.project === own.project);
}

/** 新建远程会话时先记下来（第一轮还没落盘时列表里也要知道它在哪台主机） */
export function registerRemoteSession(sessionId: string, hostId: string): void {
  load().sessions[sessionId] = { host: hostId };
  save();
}

const remoteProjects = (host: SshHost) => `${host.env!.configDir}/projects`;

const hostSyncs = new Map<string, { at: number; running: Promise<void> | null }>();

/** 整台主机的会话记录同步到本机；没连着的不连，跳过 */
export function syncHost(host: SshHost): Promise<void> {
  if (!host.isReady) return Promise.resolve();
  const state = hostSyncs.get(host.id) ?? { at: 0, running: null };
  hostSyncs.set(host.id, state);
  if (state.running) return state.running;
  if (Date.now() - state.at < HOST_SYNC_MS) return Promise.resolve();
  state.running = doSyncHost(host).finally(() => {
    state.at = Date.now();
    state.running = null;
  });
  return state.running;
}

async function doSyncHost(host: SshHost): Promise<void> {
  const started = Date.now();
  const sftp = await host.sftp();
  const root = remoteProjects(host);
  // 读不出来（比如正好断开）不能当成远端没有会话，不然本机的副本会被当成「别处删了」一起删掉；只有目录不存在才算空的
  const projects = await readdir(sftp, root).catch((err: { code?: unknown }) => (err.code === NO_SUCH_FILE ? [] : null));
  if (!projects) return;
  const seen = new Set<string>();
  const m = load();
  let changed = false;
  for (const project of projects) {
    if (!project.attrs.isDirectory()) continue;
    const files = await readdir(sftp, `${root}/${project.filename}`).catch(() => null);
    if (!files) {
      // 这个目录读不出来：它下面记着的会话不动
      for (const [id, v] of Object.entries(m.sessions)) if (v.host === host.id && v.project === project.filename) seen.add(id);
      continue;
    }
    for (const f of files) {
      if (!SESSION_FILE.test(f.filename) || !f.attrs.isFile()) continue;
      const sessionId = f.filename.slice(0, -".jsonl".length);
      if (deleting.has(sessionId)) {
        seen.add(sessionId);
        continue;
      }
      const owner = m.sessions[sessionId];
      // 同一个 id 已经是别的主机（或本机）的会话：不覆盖
      if (owner && owner.host !== host.id) continue;
      if (!owner && existsSync(path.join(PROJECTS, project.filename, f.filename))) continue;
      seen.add(sessionId);
      // 正在上传的分叉会话：远端这份可能还没写完，不拿它覆盖本机的
      if (uploading.has(sessionId)) continue;
      if (!owner || owner.project !== project.filename) {
        m.sessions[sessionId] = { host: host.id, project: project.filename };
        changed = true;
      }
      await syncFile(host, `${root}/${project.filename}/${f.filename}`, project.filename, f.filename, f.attrs.size).catch(() => undefined);
    }
  }
  // 这台主机的同步一次只有一个在跑：比这次早传完的，这次列目录时已经在了
  for (const [id, at] of uploadedAt) if (at < started && m.sessions[id]?.host === host.id) uploadedAt.delete(id);
  // 远端已经没有的（别处删了）：本机的副本也删掉；刚建、还没落盘的（没有 project）留着
  for (const [sessionId, v] of Object.entries(m.sessions)) {
    if (v.host !== host.id || !v.project || seen.has(sessionId) || uploading.has(sessionId) || (uploadedAt.get(sessionId) ?? 0) >= started) continue;
    await removeMirror(sessionId);
    delete m.sessions[sessionId];
    changed = true;
  }
  if (changed) save();
}

/** 一个会话的记录同步到本机（打开会话、一轮结束时）；没连着就跳过，用本机已有的副本 */
export async function syncSession(host: SshHost, sessionId: string): Promise<void> {
  // 正在上传的分叉会话：远端的还没写完，本机的就是最新的
  if (!host.isReady || uploading.has(sessionId) || deleting.has(sessionId)) return;
  const m = load();
  let project = m.sessions[sessionId]?.project;
  const file = `${sessionId}.jsonl`;
  const sftp = await host.sftp();
  if (!project) {
    // 还不知道在哪个目录：在远端找
    project = await findProject(sftp, remoteProjects(host), file);
    if (!project) return;
    m.sessions[sessionId] = { host: host.id, project };
    save();
  }
  const remote = `${remoteProjects(host)}/${project}/${file}`;
  const attrs = await new Promise<Stats | null>((resolve) => sftp.stat(remote, (err, s) => resolve(err ? null : s)));
  if (attrs) await syncFile(host, remote, project, file, attrs.size);
}

/** 正在同步的文件（本机路径）：同一个文件同时只同步一次，两个同步一起往本机副本里写会写乱 */
const fileSyncs = new Map<string, Promise<void>>();
/** 正在读的远端记录（按本机路径）：删会话时先停掉，Windows 上远端的文件开着就删不掉 */
const reading = new Map<string, AbortController>();

/**
 * 远端的一份记录同步到本机。size 是调用方看到的远端大小（列目录、stat 时的），和本机的一样就不用取。
 * 不一样时再 stat 一次取当前的大小：列目录到轮到这个文件之间远端可能又变了（比如分叉的记录刚传完），
 * 拿旧的大小会把「远端变长了」当成「远端变短了、被改写过」，把本机副本清空、整个重新下载
 */
function syncFile(host: SshHost, remote: string, project: string, name: string, size: number): Promise<void> {
  const local = path.join(PROJECTS, project, name);
  const running = fileSyncs.get(local);
  // 前一个同步完再看要不要取（多半已经一样了）
  // 排着队的时候会话开始删了：不取
  const next = (running ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => (deleting.has(path.basename(name, ".jsonl")) ? undefined : doSyncFile(host, remote, local, size)));
  fileSyncs.set(local, next);
  void next.finally(() => {
    if (fileSyncs.get(local) === next) fileSyncs.delete(local);
  }).catch(() => undefined);
  return next;
}

async function doSyncFile(host: SshHost, remote: string, local: string, listed: number): Promise<void> {
  const have = (await stat(local).catch(() => null))?.size ?? 0;
  if (have === listed) return;
  const sftp = await host.sftp();
  const size = await new Promise<number | null>((resolve) => sftp.stat(remote, (err, s) => resolve(err ? null : s.size)));
  if (size === null || size === have) return;
  await mkdir(path.dirname(local), { recursive: true });
  // 只会追加；变短了说明被改写过，整个重取
  const start = size > have ? have : 0;
  const abort = new AbortController();
  reading.set(local, abort);
  try {
    await pipeline(sftp.createReadStream(remote, { start, end: size - 1 }), createWriteStream(local, { flags: start ? "a" : "w", mode: 0o600 }), { signal: abort.signal });
  } finally {
    reading.delete(local);
  }
}

/** 在远端会话记录末尾追加几行（改标题），再同步回本机 */
export async function appendRemote(host: SshHost, sessionId: string, entries: unknown[]): Promise<void> {
  await syncSession(host, sessionId);
  const project = load().sessions[sessionId]?.project;
  if (!project) throw new Error("远端还没有这个会话的记录");
  const text = entries.map((e) => `${JSON.stringify(e)}\n`).join("");
  await appendText(host, `${remoteProjects(host)}/${project}/${sessionId}.jsonl`, text).catch((err: Error) => {
    throw new Error(`写远端会话记录失败：${err.message}`);
  });
  await syncSession(host, sessionId);
}

/**
 * 分叉出来的远程会话：本机副本旁边新建的记录（forkSession 写在源会话的同一个目录里）原样传到远端的同一个目录，
 * 远端的 claude resume 时读的是远端那份。
 * 上传前先记成这台主机的会话：上传要好几秒，这期间列会话不能把它当成本机会话。传失败了去掉
 */
export function uploadForkedSession(host: SshHost, sourceId: string, sessionId: string): Promise<void> {
  const project = load().sessions[sourceId]?.project;
  if (!project) return Promise.reject(new Error("远端还没有这个会话的记录"));
  load().sessions[sessionId] = { host: host.id, project };
  save();
  // 删会话时取消：关掉上传的通道。通道关了 writeFile 不会再回调，上传要靠这里结束
  let cancel = (): void => undefined;
  let cancelledByDelete = false;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      cancelledByDelete = true;
      reject(new Error("分叉出的会话已经删除"));
    };
  });
  cancelled.catch(() => undefined);
  let channel: SFTPWrapper | undefined;
  const upload: { cancel: () => void; done?: Promise<void> } = {
    cancel: () => {
      cancel();
      channel?.end();
    },
  };
  uploading.set(sessionId, upload);
  upload.done = (async () => {
    try {
      const data = await readFile(path.join(PROJECTS, project, `${sessionId}.jsonl`));
      // 单独开一个 SFTP 通道，传完关掉：几 MB 的记录在慢的链路上要传好几分钟（实测 art 上 8MB 约 3 分钟），
      // 共用的通道上打开会话、同步记录不用排在它后面
      const opening = host.openSftp();
      const sftp = await Promise.race([opening, cancelled]).catch((err: unknown) => {
        // 通道还没开好就取消了：开好后关掉
        void opening.then((s) => s.end(), () => undefined);
        throw err;
      });
      channel = sftp;
      try {
        const write = sftpWrite(sftp, `${remoteProjects(host)}/${project}/${sessionId}.jsonl`, data).catch((err: Error) => {
          throw new Error(`写远端会话记录失败：${err.message}`);
        });
        await Promise.race([write, cancelled]);
      } finally {
        sftp.end();
      }
      uploadedAt.set(sessionId, Date.now());
    } catch (err) {
      // 不是删除取消的（比如断线）：远端写了一半的记录也删掉（删不掉就算了），不然整台主机同步时会把它当成一个会话收回来，
      // 记录不完整，标题（在最后一行）也没了
      if (!cancelledByDelete) await rmrf(host, `${remoteProjects(host)}/${project}/${sessionId}.jsonl`).catch(() => undefined);
      delete load().sessions[sessionId];
      save();
      throw err;
    } finally {
      uploading.delete(sessionId);
    }
  })();
  return upload.done;
}

/**
 * 分叉出的会话的记录还在往远端传：等它传完，传失败了抛错。
 * 本机副本一写好列表里就有这个会话，上传要好几秒到几分钟，这期间可能已经在给它发消息；
 * Windows 远端上 SFTP 以写方式开着的文件别的进程读不了，这时拉起的 claude 读不了记录（EBUSY），resume 失败
 */
export async function forkUploaded(sessionId: string): Promise<void> {
  await uploading.get(sessionId)?.done?.catch((err: Error) => {
    throw new Error(`分叉的会话记录没有传到远端：${err.message}`);
  });
}

/** 删远程会话：远端的记录（jsonl 和同名文件夹）和本机的副本 */
export async function deleteRemoteSession(host: SshHost, sessionId: string): Promise<void> {
  deleting.add(sessionId);
  try {
    await doDeleteRemoteSession(host, sessionId);
  } finally {
    deleting.delete(sessionId);
  }
}

async function doDeleteRemoteSession(host: SshHost, sessionId: string): Promise<void> {
  const project = load().sessions[sessionId]?.project;
  // 分叉的记录还在往远端传：关掉上传的 SFTP 通道，等它停下（停下后这个会话就从清单里去掉了，project 要在这之前取）
  const upload = uploading.get(sessionId);
  if (upload) {
    upload.cancel();
    await upload.done?.catch(() => undefined);
  }
  // Windows 远端上关掉通道后 claude 可能还在跑（有后台任务时），开着记录删不掉：先结束它
  if (host.env) await killRemoteClaude(host, host.env.bin, sessionId);
  if (project && host.env) {
    // 这边还在下载它的记录（链路慢时一份要好几分钟）：先停掉
    const local = path.join(PROJECTS, project, `${sessionId}.jsonl`);
    reading.get(local)?.abort();
    // 等它真的停下（远端的文件关掉）
    await fileSyncs.get(local)?.catch(() => undefined);
    const base = `${remoteProjects(host)}/${project}/${sessionId}`;
    const dir = `${remoteProjects(host)}/${project}`;
    // 项目目录里没有别的会话了就删掉；Claude Code 会建一个空的 memory 文件夹，空的先删（rmdir 只删空目录）
    await rmrf(host, `${base}.jsonl`, base);
    await rmdirQuiet(host, `${dir}/memory`, dir);
  }
  await removeMirror(sessionId, project);
  delete load().sessions[sessionId];
  save();
}

/** 删 SSH 连接时：本机的副本都删掉（远端的记录不动） */
export async function forgetHost(hostId: string): Promise<void> {
  for (const sessionId of remoteSessionIds(hostId)) {
    await removeMirror(sessionId);
    delete load().sessions[sessionId];
  }
  save();
}

async function removeMirror(sessionId: string, project = load().sessions[sessionId]?.project): Promise<void> {
  if (!project) return;
  const dir = path.join(PROJECTS, project);
  await rm(path.join(dir, `${sessionId}.jsonl`), { force: true });
  await rm(path.join(dir, sessionId), { recursive: true, force: true });
  await rmdir(dir).catch(() => undefined);
}

/** 会话记录在 projects 下哪个目录里 */
async function findProject(sftp: Awaited<ReturnType<SshHost["sftp"]>>, root: string, file: string): Promise<string | undefined> {
  const projects = await readdir(sftp, root).catch(() => []);
  for (const p of projects) {
    if (!p.attrs.isDirectory()) continue;
    const found = await new Promise<boolean>((resolve) => sftp.stat(`${root}/${p.filename}/${file}`, (err) => resolve(!err)));
    if (found) return p.filename;
  }
  return undefined;
}

function readdir(sftp: Awaited<ReturnType<SshHost["sftp"]>>, p: string): Promise<{ filename: string; attrs: Stats }[]> {
  return new Promise((resolve, reject) => sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list))));
}
