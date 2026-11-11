import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Stats } from "ssh2";
import { config } from "../config.js";
import type { SshHost } from "./host.js";
import { appendText, rmdirQuiet, rmrf, sftpWrite } from "./remote-ops.js";

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
      const owner = m.sessions[sessionId];
      // 同一个 id 已经是别的主机（或本机）的会话：不覆盖
      if (owner && owner.host !== host.id) continue;
      if (!owner && existsSync(path.join(PROJECTS, project.filename, f.filename))) continue;
      seen.add(sessionId);
      if (!owner || owner.project !== project.filename) {
        m.sessions[sessionId] = { host: host.id, project: project.filename };
        changed = true;
      }
      await syncFile(host, `${root}/${project.filename}/${f.filename}`, project.filename, f.filename, f.attrs.size).catch(() => undefined);
    }
  }
  // 远端已经没有的（别处删了）：本机的副本也删掉；刚建、还没落盘的（没有 project）留着
  for (const [sessionId, v] of Object.entries(m.sessions)) {
    if (v.host !== host.id || !v.project || seen.has(sessionId)) continue;
    await removeMirror(sessionId);
    delete m.sessions[sessionId];
    changed = true;
  }
  if (changed) save();
}

/** 一个会话的记录同步到本机（打开会话、一轮结束时）；没连着就跳过，用本机已有的副本 */
export async function syncSession(host: SshHost, sessionId: string): Promise<void> {
  if (!host.isReady) return;
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

async function syncFile(host: SshHost, remote: string, project: string, name: string, size: number): Promise<void> {
  const dir = path.join(PROJECTS, project);
  const local = path.join(dir, name);
  const have = (await stat(local).catch(() => null))?.size ?? 0;
  if (have === size) return;
  await mkdir(dir, { recursive: true });
  const sftp = await host.sftp();
  // 只会追加；变短了说明被改写过，整个重取
  const start = size > have ? have : 0;
  await pipeline(sftp.createReadStream(remote, { start, end: size - 1 }), createWriteStream(local, { flags: start ? "a" : "w", mode: 0o600 }));
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
 * 远端的 claude resume 时读的是远端那份
 */
export async function uploadForkedSession(host: SshHost, sourceId: string, sessionId: string): Promise<void> {
  const project = load().sessions[sourceId]?.project;
  if (!project) throw new Error("远端还没有这个会话的记录");
  const data = await readFile(path.join(PROJECTS, project, `${sessionId}.jsonl`));
  await sftpWrite(await host.sftp(), `${remoteProjects(host)}/${project}/${sessionId}.jsonl`, data).catch((err: Error) => {
    throw new Error(`写远端会话记录失败：${err.message}`);
  });
  load().sessions[sessionId] = { host: host.id, project };
  save();
}

/** 删远程会话：远端的记录（jsonl 和同名文件夹）和本机的副本 */
export async function deleteRemoteSession(host: SshHost, sessionId: string): Promise<void> {
  const project = load().sessions[sessionId]?.project;
  if (project && host.env) {
    const base = `${remoteProjects(host)}/${project}/${sessionId}`;
    const dir = `${remoteProjects(host)}/${project}`;
    // 项目目录里没有别的会话了就删掉；Claude Code 会建一个空的 memory 文件夹，空的先删（rmdir 只删空目录）
    await rmrf(host, `${base}.jsonl`, base);
    await rmdirQuiet(host, `${dir}/memory`, dir);
  }
  await removeMirror(sessionId);
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

async function removeMirror(sessionId: string): Promise<void> {
  const project = load().sessions[sessionId]?.project;
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
