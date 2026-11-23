import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { deleteSession, getSessionInfo, renameSession } from "@anthropic-ai/claude-agent-sdk";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { Attachment } from "../shared/types.js";
import type { SshHost } from "../ssh/host.js";
import { remoteFs } from "../ssh/host-fs.js";
import { existingHost, readyHost, sshHost } from "../ssh/hosts.js";
import { fromWindowsPath, nativePath, parseRemote, remoteUri } from "../ssh/location.js";
import { uploadAttachments } from "../ssh/remote-attachments.js";
import { rmdirQuiet } from "../ssh/remote-ops.js";
import { expandHome } from "../ssh/ssh-config.js";
import { appendRemote, deleteRemoteSession, forkUploaded, registerRemoteSession, remoteProjectShared, remoteSessionHost, syncSession, uploadForkedSession } from "../ssh/transcripts.js";
import { imageType } from "./attachments.js";
import { createScratchDir, isScratchIn, newScratchName, removeScratchDirIfEmpty } from "./scratch.js";
import { sessionRecordDir } from "./session-records.js";

/**
 * 会话在哪台机器上：本机会话的 claude 在本机跑，记录就是本机 Claude Code 配置目录里的；
 * 远程会话（docs/README.md「SSH 远程开发」）的 claude 经 SSH 在远端跑，记录以远端为准，本机有一份副本（ssh/transcripts.ts），
 * 读之前先同步过来，写的时候写远端。SessionManager、AgentSession 经这里分本机、远程，自己不再判断
 */
export interface SessionHome {
  /** 远程会话所在的 SSH 连接 id；本机会话是 undefined */
  readonly hostId: string | undefined;
  /** 记录里的工作目录 → 会话的 cwd（远程会话写成 ssh://<连接 id><远端路径>） */
  cwd(recorded: string): string;
  /** 读本机的记录（历史、目标）之前：远程会话连着时把远端的记录同步过来，没连着用本机已有的副本 */
  refresh(): Promise<void>;
  /** resume 之前：远程会话等分叉的记录传完、连上主机（连不上报 400）、同步记录 */
  prepareResume(): Promise<void>;
  /** 写自定义标题：本机会话交给 SDK；远程会话追加到远端的记录里（格式同 Claude Code 写的） */
  writeTitle(title: string): Promise<void>;
  /** 分叉：run 在本机的记录上分叉，返回新会话 id。远程会话先连上、同步，分叉后把新记录传到远端，传不上删掉本机这份再报错 */
  fork(run: () => Promise<string>): Promise<string>;
  /** /clear 换了新的会话 id：远程会话登记新 id、同步它的记录 */
  adopt(newId: string): Promise<void>;
  /**
   * 删掉会话记录（wasRunning：刚关掉子进程，它退出时还会往记录里写几行）；没有记录也没在运行报 404。
   * 返回的函数在会话的终端、浏览器等都关掉之后调用：普通会话的 scratch 目录空了就删掉
   */
  deleteRecord(cwd: string | null, wasRunning: boolean): Promise<() => Promise<void>>;
  /** 任务输出文件在本机能读的路径：远程会话取回本机临时文件（tail：只取最后 64 KB），取不到是 null */
  outputFile(file: string, tail: boolean): Promise<string | null>;
  /** 发消息带的附件：远程会话把非图片的传到远端，返回附件 id → 远端路径（模型看到的是它）；本机是 undefined */
  uploadAttachments(attachments: Attachment[]): Promise<Map<string, string> | undefined>;
}

/** cwd 给了时按它（活跃会话的工作目录），否则按记下的远程会话清单 */
export function sessionHome(sessionId: string, cwd?: string): SessionHome {
  const hostId = cwd === undefined ? remoteSessionHost(sessionId) : parseRemote(cwd)?.host;
  return hostId ? remoteHome(sessionId, hostId) : localHome(sessionId);
}

/**
 * 新会话的工作目录：选了文件夹的要是已经有的目录（支持 ~）；没选的新建一个 scratch 目录（同 Claude 桌面版），不和别的普通会话共用。
 * 远程会话（ssh://<连接 id>[路径]）在远端找、在远端建，并登记到远程会话清单
 */
export async function placeNewSession(sessionId: string, requested: string | undefined): Promise<string> {
  const remote = parseRemote(requested);
  if (!remote) return requested ? resolveLocalDir(requested) : createScratchDir();
  const host = await readyHost(remote.host);
  const dir = remote.path ? await resolveRemoteDir(host, remote.path) : await createRemoteScratch(host);
  registerRemoteSession(sessionId, remote.host);
  return remoteUri(remote.host, dir);
}

function localHome(sessionId: string): SessionHome {
  return {
    hostId: undefined,
    cwd: (recorded) => recorded,
    refresh: async () => {},
    prepareResume: async () => {},
    writeTitle: (title) => renameSession(sessionId, title),
    fork: (run) => run(),
    adopt: async () => {},
    async deleteRecord(cwd, wasRunning) {
      const info = await getSessionInfo(sessionId);
      const recordDir = info ? await sessionRecordDir(sessionId) : undefined;
      // 刚建的会话第一轮还没落盘时只有子进程，没有文件可删
      if (info) await deleteSession(sessionId);
      else if (!wasRunning) throw new NotFoundError(`会话不存在：${sessionId}`);
      // close() 只等到消息流结束，子进程退出时还会往 jsonl 写最后几条记录，把删掉的文件又建出来，所以再查几次
      if (wasRunning) {
        for (let i = 0; i < 6; i++) {
          await sleep(250);
          if (await getSessionInfo(sessionId)) await deleteSession(sessionId);
        }
      }
      return () => removeScratchDirIfEmpty(cwd ?? undefined, recordDir);
    },
    outputFile: async (file) => file,
    uploadAttachments: async () => undefined,
  };
}

function remoteHome(sessionId: string, hostId: string): SessionHome {
  const sync = (host: SshHost, id = sessionId) => syncSession(host, id).catch(() => undefined);
  return {
    hostId,
    cwd: (recorded) => remoteUri(hostId, recorded),
    async refresh() {
      const host = existingHost(hostId);
      if (host?.isReady) await sync(host);
    },
    async prepareResume() {
      // 分叉出的会话：远端的记录传完了才能 resume
      await forkUploaded(sessionId);
      await sync(await readyHost(hostId));
    },
    async writeTitle(title) {
      await appendRemote(await readyHost(hostId), sessionId, [{ type: "custom-title", customTitle: title, sessionId }]);
    },
    async fork(run) {
      const host = await readyHost(hostId);
      await sync(host);
      const forkedId = await run();
      try {
        await uploadForkedSession(host, sessionId, forkedId);
      } catch (err) {
        // 远端没写成：本机这份也删掉，不留一个 resume 不了的会话
        await deleteSession(forkedId).catch(() => undefined);
        throw err;
      }
      return forkedId;
    },
    async adopt(newId) {
      registerRemoteSession(newId, hostId);
      await sync(await readyHost(hostId), newId);
    },
    async deleteRecord(cwd, wasRunning) {
      const host = await readyHost(hostId);
      // 子进程退出时还会往记录里写几行，等一下再删
      if (wasRunning) await sleep(1500);
      // 还有别的会话用着同一个工作目录（分叉、清空出来的）：scratch 目录留着
      const shared = remoteProjectShared(sessionId);
      await deleteRemoteSession(host, sessionId);
      return async () => {
        const dir = parseRemote(cwd)?.path;
        if (dir && !shared && host.env && isScratchIn(dir, host.env.workspace)) await rmdirQuiet(host, dir);
      };
    },
    outputFile: async (file, tail) => fetchRemoteOutput(await readyHost(hostId), file, tail),
    // 图片照旧放进消息，其他文件传到远端
    uploadAttachments: (attachments) => uploadAttachments(sshHost(hostId), attachments.filter((a) => !imageType(a))),
  };
}

/** 本机的文件夹：支持 ~，必须是已存在的目录 */
async function resolveLocalDir(dir: string): Promise<string> {
  const expanded = expandHome(dir.trim());
  if (!path.isAbsolute(expanded)) throw new BadRequestError(`请填写绝对路径：${dir}`);
  const resolved = path.resolve(expanded);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new BadRequestError(`文件夹不存在：${resolved}`);
  return resolved;
}

/** 远端的文件夹：支持 ~，必须是已存在的目录 */
async function resolveRemoteDir(host: SshHost, dir: string): Promise<string> {
  const fs = remoteFs(host);
  const home = await fs.home();
  const expanded = dir.trim().replace(/^~(?=$|\/)/, home);
  if (!expanded.startsWith("/")) throw new BadRequestError(`请填写绝对路径：${dir}`);
  const resolved = path.posix.resolve(expanded);
  const info = await fs.stat(resolved).catch(() => null);
  if (!info?.isDirectory) throw new BadRequestError(`远端文件夹不存在：${nativePath(host.windows, resolved)}`);
  return resolved;
}

/** 远端的普通会话目录：~/.claude-app/workspace/scratch-日期-随机串 */
async function createRemoteScratch(host: SshHost): Promise<string> {
  const dir = `${host.env!.workspace}/${newScratchName()}`;
  await remoteFs(host).mkdir(dir, { recursive: true });
  return dir;
}

/** 远端的任务输出文件取回本机临时文件；tail：只取最后 64 KB */
async function fetchRemoteOutput(host: SshHost, file: string, tail: boolean): Promise<string | null> {
  const fs = remoteFs(host);
  // Windows 上的 claude 报的是 C:\Users\…\xx.output，SFTP 要 /C:/Users/…/xx.output（C:\… 会被当成相对用户目录的路径）
  const remote = fromWindowsPath(file);
  const size = (await fs.stat(remote).catch(() => null))?.size;
  if (!size) return null;
  const local = path.join(os.tmpdir(), `claude-app-ssh-${createHash("sha1").update(`${host.id}:${remote}`).digest("hex").slice(0, 16)}`);
  const start = tail ? Math.max(0, size - 64 * 1024) : 0;
  // 经 HostFs 读：ssh2 自带的读流在 Windows 远端读完不关句柄（见 host-fs.ts）
  await pipeline(fs.createReadStream(remote, { start, end: size - 1 }), createWriteStream(local, { mode: 0o600 }));
  return local;
}
