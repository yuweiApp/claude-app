import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  listSessions,
  renameSession,
  type EffortLevel,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { EventHub } from "../events/event-hub.js";
import type { ConversationLog } from "../logging/conversation-log.js";
import type { BackgroundTask, SessionListItem, TaskOutput } from "../shared/types.js";
import { loadAttachments, loadElements, type SelectedElementInput, type SessionExport } from "./attachments.js";
import { enabledSkillNames } from "./capabilities.js";
import { disabledSkills } from "./extensions.js";
import { AgentSession } from "./session.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { BrowserHost } from "../browser/host.js";
import { generateTitle } from "./title.js";
import { readAgentTranscript, readOutputTail, TaskList } from "./tasks.js";
import { disposeRepls } from "../browser/tool.js";
import { disposeDesktopSession } from "../desktop/tool.js";
import { sessionHistory } from "./history.js";
import { exportSession, SESSION_MENTION } from "./session-export.js";
import { lastCustomTitle, lastResponseAt, lastResponseModel, recordedCwd, sessionRecordFiles } from "./session-records.js";
import { createScratchDir, isChatCwd, isScratchIn, newScratchName, removeScratchDirIfEmpty, sessionRecordDir } from "./scratch.js";
import { fromWindowsPath, nativePath, parseRemote, remoteUri } from "../ssh/location.js";
import { existingHost, sshHost } from "../ssh/hosts.js";
import type { SshHost } from "../ssh/host.js";
import { rmdirQuiet } from "../ssh/remote-ops.js";
import { remoteFs } from "../ssh/host-fs.js";
import { appendRemote, deleteRemoteSession, registerRemoteSession, remoteSessionHost, syncHost, syncSession, uploadForkedSession } from "../ssh/transcripts.js";
import { listConnections } from "../ssh/connections.js";
import type { SessionContextInfo } from "../shared/types.js";
import { compactedSinceReply, forgetSession, savedUsage, saveUsage } from "./context-usage.js";

/** 活跃会话表：新建、按需 resume、空闲回收；历史会话直接读 Claude Code 落盘的 jsonl */
export class SessionManager {
  private readonly active = new Map<string, AgentSession>();
  /**
   * 会话的自定义标题（生成、改名时，列表里读到时记下）。SDK 列会话只读记录文件开头和结尾各 64 KB 找标题，
   * 标题那一行在文件开头之后，网页快照、截图、工具结果把文件撑大，它就不在结尾那段里了。网关设的标题 Claude Code 不一定补写到末尾
   * （实测 Windows 上 718 KB 的会话，标题在第 125 KB，一直没补写，网关重启后显示成第一条提问）。
   * 列表里优先用这里记的；网关没记着（重启过）、SDK 也读不到时，从整个记录文件里找最后一次设的标题再记下。不往记录文件里补写
   */
  private readonly titles = new Map<string, string>();
  /**
   * 子进程回收时会话用着的模型和推理强度，resume 时沿用（不传的话 Claude Code 用默认模型，切换过的模型就丢了）。
   * 网关重启后没有这里的记录，模型按记录文件里最后一次回复用的，推理强度回到默认
   */
  private readonly lastSettings = new Map<string, { model?: string; effort?: EffortLevel }>();
  /** 每个会话的后台任务，子进程回收后还留着；记录写在 claude-home/gateway-tasks/<会话 id>.json，网关重启后读回来 */
  private readonly tasks = new Map<string, TaskList>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly hub: EventHub,
    private readonly log: FastifyBaseLogger,
    private readonly conversationLog: ConversationLog,
    /** 右侧面板的终端，给模型用（读终端、往终端里写命令） */
    private readonly terminals?: TerminalManager,
    /** 桌面版的内置浏览器，给模型用（browser/tool.ts 的浏览器工具） */
    private readonly browser?: BrowserHost,
  ) {
    mkdirSync(config.workspaceDir, { recursive: true });
    mkdirSync(config.claudeConfigDir, { recursive: true });
    this.sweeper = setInterval(() => void this.sweepIdle(), 60_000);
    this.sweeper.unref();
  }

  get(sessionId: string): AgentSession | undefined {
    return this.active.get(sessionId);
  }

  /** 新建会话并发送第一条消息 */
  async create(
    text: string,
    opts: { cwd?: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; attachments?: string[] },
  ): Promise<AgentSession> {
    rejectDisabledSkill(text);
    const remote = parseRemote(opts.cwd);
    const sessionId = randomUUID();
    let cwd: string;
    if (remote) {
      // 远程会话：工作目录写成 ssh://<连接 id><远端路径>；只有连接 id 时在远端新建 scratch 目录
      const host = await readyHost(remote.host);
      cwd = remoteUri(remote.host, remote.path ? await resolveRemoteDir(host, remote.path) : await createRemoteScratch(host));
      registerRemoteSession(sessionId, remote.host);
    } else {
      // 没选文件夹：给这个会话新建一个工作目录（同 Claude 桌面版），不和别的普通会话共用
      cwd = opts.cwd ? await resolveDir(opts.cwd) : await createScratchDir();
    }
    const attachments = [...(await loadAttachments(opts.attachments ?? [])), ...(await this.referencedSessions(text))];
    const session = await this.launch(sessionId, false, { ...opts, cwd });
    await session.send(text, attachments);
    void this.nameSession(session.id, text || (attachments[0]?.name ?? ""));
    return session;
  }

  /** 新会话的第一条消息生成简短标题，写成自定义标题（之后不再变）；第一条消息落盘后才能改名，所以多试几次 */
  private async nameSession(sessionId: string, text: string): Promise<void> {
    if (!text) return;
    const title = await generateTitle(text);
    for (let i = 0; i < 20; i++) {
      try {
        await this.writeTitle(sessionId, title);
        this.titles.set(sessionId, title);
        this.hub.publish(sessionId, { type: "title", title });
        return;
      } catch {
        await sleep(500);
      }
    }
    this.log.warn({ sessionId }, "给新会话设置标题失败");
  }

  /** 发送消息；会话不活跃时先 resume */
  async send(sessionId: string, text: string, attachmentIds: string[] = [], elementInputs: SelectedElementInput[] = []): Promise<string> {
    rejectDisabledSkill(text);
    const attachments = [...(await loadAttachments(attachmentIds)), ...(await this.referencedSessions(text))];
    const elements = await loadElements(elementInputs);
    return (await this.activate(sessionId)).send(text, attachments, elements);
  }

  /** 活跃会话直接返回；子进程已回收的用原来的工作目录 resume。远程会话先连上主机、同步一下记录 */
  async activate(sessionId: string): Promise<AgentSession> {
    const session = this.active.get(sessionId);
    if (session) return session;
    const hostId = remoteSessionHost(sessionId);
    if (hostId) await syncSession(await readyHost(hostId), sessionId).catch(() => undefined);
    const info = await getSessionInfo(sessionId);
    if (!info) throw new NotFoundError(`会话不存在：${sessionId}`);
    const settings = this.lastSettings.get(sessionId) ?? { model: await this.recordedModel(sessionId) };
    const recorded = await this.infoCwd(info);
    if (hostId && !recorded) throw new NotFoundError(`远程会话的记录里没有工作目录：${sessionId}`);
    return this.launch(sessionId, true, { cwd: hostId ? remoteUri(hostId, recorded!) : recorded || config.workspaceDir, ...settings });
  }

  /** 写自定义标题：本机会话交给 SDK；远程会话追加到远端的记录里（格式同 Claude Code 写的），再同步回来 */
  private async writeTitle(sessionId: string, title: string): Promise<void> {
    const hostId = remoteSessionHost(sessionId);
    if (!hostId) return renameSession(sessionId, title);
    await appendRemote(await readyHost(hostId), sessionId, [{ type: "custom-title", customTitle: title, sessionId }]);
  }

  /** 记录文件里最后一次回复用的模型 */
  private async recordedModel(sessionId: string): Promise<string | undefined> {
    const dir = await sessionRecordDir(sessionId);
    return dir ? lastResponseModel(path.join(dir, `${sessionId}.jsonl`)) : undefined;
  }

  /** 会话的工作目录；没有这个会话时 null */
  async cwd(sessionId: string): Promise<string | null> {
    const session = this.active.get(sessionId);
    if (session) return session.cwd;
    const info = await getSessionInfo(sessionId);
    const cwd = info && (await this.infoCwd(info));
    if (!cwd) return null;
    const hostId = remoteSessionHost(sessionId);
    return hostId ? remoteUri(hostId, cwd) : cwd;
  }

  /**
   * SDK 给的会话工作目录；它没读出来时（只看记录文件开头 64KB，第一条消息带了图片就不在这段里）从记录文件里找。
   * 不补的话项目会话会被当成普通会话列到「会话」里，子进程回收后 resume 也会跑到默认工作目录
   */
  private async infoCwd(info: { sessionId: string; cwd?: string }, file?: string): Promise<string | undefined> {
    if (info.cwd) return info.cwd;
    if (!file) {
      const dir = await sessionRecordDir(info.sessionId);
      if (!dir) return undefined;
      file = path.join(dir, `${info.sessionId}.jsonl`);
    }
    return recordedCwd(file);
  }

  async list(): Promise<SessionListItem[]> {
    // 连着的远程主机先把会话记录同步过来（最多等 3 秒，没同步完的下次再列）；没连着的用本机已有的副本
    const syncs = listConnections().map((c) => existingHost(c.id)).filter((h): h is SshHost => Boolean(h?.isReady)).map((h) => syncHost(h).catch(() => undefined));
    if (syncs.length) await Promise.race([Promise.all(syncs), sleep(3000)]);
    // 不传 dir：所有工作目录（项目）的会话
    const [infos, files] = await Promise.all([listSessions(), sessionRecordFiles()]);
    const stored: SessionListItem[] = await Promise.all(
      infos.map(async (info) => {
        const file = files.get(info.sessionId);
        // SDK 读到的可能是开头那段里的旧标题（改过名），网关记着的更新
        let customTitle = this.titles.get(info.sessionId) || info.customTitle;
        if (!customTitle && file) {
          customTitle = await lastCustomTitle(file);
          if (customTitle) this.titles.set(info.sessionId, customTitle);
        }
        const responded = file ? await lastResponseAt(file) : undefined;
        const recorded = await this.infoCwd(info, file);
        const hostId = remoteSessionHost(info.sessionId);
        const cwd = hostId && recorded ? remoteUri(hostId, recorded) : recorded;
        return {
          ...info,
          ...(customTitle ? { customTitle } : {}),
          ...(cwd ? { cwd } : {}),
          chat: isChatCwd(cwd),
          state: this.active.get(info.sessionId)?.state,
          tasksRunning: this.active.get(info.sessionId)?.tasksRunning || undefined,
          lastResponseAt: responded ?? info.createdAt ?? info.lastModified,
        };
      }),
    );
    // 刚建的会话第一轮还没落盘时也要出现在列表里，字段按 SDKSessionInfo 补
    for (const session of this.active.values()) {
      if (!stored.some((s) => s.sessionId === session.id)) {
        const customTitle = this.titles.get(session.id);
        stored.push({ sessionId: session.id, summary: customTitle ?? "", ...(customTitle ? { customTitle } : {}), lastModified: session.lastActiveAt, lastResponseAt: session.lastActiveAt, cwd: session.cwd, chat: isChatCwd(session.cwd), state: session.state, tasksRunning: session.tasksRunning || undefined });
      }
    }
    return stored.sort((a, b) => b.lastResponseAt - a.lastResponseAt);
  }

  /** 历史消息：压缩上下文之前的也接上（见 history.ts）。远程会话连着时先同步一下记录 */
  async messages(sessionId: string) {
    const hostId = remoteSessionHost(sessionId);
    const host = hostId ? existingHost(hostId) : undefined;
    if (host?.isReady) await syncSession(host, sessionId).catch(() => undefined);
    return sessionHistory(sessionId);
  }

  /** 消息里引用的会话（@session[标题](session:会话 id)，同一个只算一次）：每个导出成一份 Markdown 附件，导出的是发送这一刻的内容 */
  private async referencedSessions(text: string): Promise<SessionExport[]> {
    const ids = new Set([...text.matchAll(SESSION_MENTION)].map((m) => m[1]!));
    return Promise.all([...ids].map((id) => this.exportForReference(id)));
  }

  /** 引用会话：历史消息导出成 Markdown 附件（见 session-export.ts） */
  private async exportForReference(sessionId: string): Promise<SessionExport> {
    const messages = await this.messages(sessionId);
    const info = await getSessionInfo(sessionId);
    if (!info && !messages.length) throw new NotFoundError(`会话不存在：${sessionId}`);
    const title = this.titles.get(sessionId) ?? info?.customTitle ?? info?.summary ?? sessionId;
    return exportSession({ sessionId, title, cwd: await this.cwd(sessionId) }, messages);
  }

  /** 用户改标题：写成自定义标题，打开这个会话的页面通过 title 事件跟着变 */
  async rename(sessionId: string, title: string): Promise<void> {
    await this.writeTitle(sessionId, title);
    this.titles.set(sessionId, title);
    this.hub.publish(sessionId, { type: "title", title });
  }

  /**
   * 从某条消息分叉：新会话的记录是源会话到这条消息为止（含）的部分（SDK 的 forkSession，消息换成新的 uuid），
   * 工作目录、模型和推理强度跟源会话一样，标题是源会话的加「（分叉）」。新会话不拉起子进程，发消息时再 resume。
   * 远程会话在本机副本上分叉，再把新记录传到远端
   */
  async fork(sessionId: string, upToMessageId: string): Promise<string> {
    const hostId = remoteSessionHost(sessionId);
    const host = hostId ? await readyHost(hostId) : undefined;
    if (host) await syncSession(host, sessionId).catch(() => undefined);
    const info = await getSessionInfo(sessionId);
    if (!info) throw new NotFoundError(`会话不存在：${sessionId}`);
    const source = this.titles.get(sessionId) || info.customTitle || info.summary;
    const title = source ? `${source}（分叉）` : "分叉的会话";
    const forked = await forkSession(sessionId, { upToMessageId, title }).catch((err: Error) => {
      throw /not found/i.test(err.message) ? new BadRequestError("会话记录里没有这条消息") : err;
    });
    await restoreForkTime(sessionId, forked.sessionId).catch((err: Error) => this.log.warn({ err, sessionId }, "分叉记录的时间没改回来"));
    if (host) {
      try {
        await uploadForkedSession(host, sessionId, forked.sessionId);
      } catch (err) {
        // 远端没写成：本机这份也删掉，不留一个 resume 不了的会话
        await deleteSession(forked.sessionId).catch(() => undefined);
        throw err;
      }
    }
    this.titles.set(forked.sessionId, title);
    const active = this.active.get(sessionId);
    const settings = active ? { model: active.model, effort: active.effort } : this.lastSettings.get(sessionId);
    if (settings) this.lastSettings.set(forked.sessionId, settings);
    return forked.sessionId;
  }

  /** 输入框上下文圆环要的：最后一次取到的用量。不拉起子进程 */
  contextInfo(sessionId: string): SessionContextInfo {
    return { usage: savedUsage(sessionId) };
  }

  /** 压缩上下文：子进程回收了的先 resume */
  async compact(sessionId: string): Promise<void> {
    (await this.activate(sessionId)).compact();
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.active.get(sessionId)?.close();
  }

  /** 删除会话：先关掉子进程，再删 Claude Code 落盘的会话记录（jsonl 和子代理记录），事件缓冲一起清掉 */
  async delete(sessionId: string): Promise<void> {
    const session = this.active.get(sessionId);
    await session?.close();
    const hostId = remoteSessionHost(sessionId);
    if (hostId) return this.deleteRemote(sessionId, hostId, session);
    const info = await getSessionInfo(sessionId);
    const cwd = session?.cwd ?? (info ? await this.infoCwd(info) : undefined);
    const recordDir = info ? await sessionRecordDir(sessionId) : undefined;
    // 刚建的会话第一轮还没落盘时只有子进程，没有文件可删
    this.titles.delete(sessionId);
    this.lastSettings.delete(sessionId);
    forgetSession(sessionId);
    if (info) await deleteSession(sessionId);
    else if (!session) throw new NotFoundError(`会话不存在：${sessionId}`);
    // close() 只等到消息流结束，子进程退出时还会往 jsonl 写最后几条记录，把删掉的文件又建出来，所以再查几次
    if (session) {
      for (let i = 0; i < 6; i++) {
        await sleep(250);
        if (await getSessionInfo(sessionId)) await deleteSession(sessionId);
      }
    }
    this.disposeSession(sessionId);
    await removeScratchDirIfEmpty(cwd, recordDir);
  }

  /** 删远程会话：远端的记录和本机的副本；它的 scratch 目录是空的就一起删（要连得上远端） */
  private async deleteRemote(sessionId: string, hostId: string, session: AgentSession | undefined): Promise<void> {
    const host = await readyHost(hostId);
    const cwd = session?.cwd ?? (await this.cwd(sessionId));
    // 子进程退出时还会往记录里写几行，等一下再删
    if (session) await sleep(1500);
    await deleteRemoteSession(host, sessionId);
    this.titles.delete(sessionId);
    this.lastSettings.delete(sessionId);
    forgetSession(sessionId);
    this.disposeSession(sessionId);
    const dir = parseRemote(cwd)?.path;
    if (dir && host.env && isScratchIn(dir, host.env.workspace)) await rmdirQuiet(host, dir);
  }

  private disposeSession(sessionId: string): void {
    this.hub.remove(sessionId);
    this.taskList(sessionId).dispose();
    this.tasks.delete(sessionId);
    // 浏览器工具的 REPL（browser_run_code 的变量、当前标签页）按会话留在网关里，删会话时一起删
    disposeRepls(sessionId);
    // 桌面工具的快照（agent-desktop 的状态目录里这个会话的命名空间）和网关记下的 ref
    disposeDesktopSession(sessionId);
    // 内置浏览器里这个会话的标签页也关掉：AI 留下的、用户开的不会自动关，不关的话会一直留在桌面版后台（会话没了，面板里也看不到）
    this.browser?.closeSession(sessionId);
  }

  listTasks(sessionId: string): BackgroundTask[] {
    return this.taskList(sessionId).list();
  }

  /** 任务输出的最后一段（子代理是整理过的对话记录）；只能读这个会话自己记下的任务的输出文件 */
  async taskOutput(sessionId: string, taskId: string): Promise<TaskOutput> {
    const output = this.taskList(sessionId).output(taskId);
    if (!output) throw new NotFoundError("这个任务没有输出");
    // 远程会话的输出文件在远端：取回来放进本机的临时文件再读
    const hostId = remoteSessionHost(sessionId);
    const file = hostId ? await fetchRemoteOutput(await readyHost(hostId), output.file, !output.agent) : output.file;
    if (!file) return { text: "", truncated: false };
    return (output.agent ? readAgentTranscript(file) : readOutputTail(file)).catch(() => ({ text: "", truncated: false }));
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const session = this.active.get(sessionId);
    if (!session) throw new NotFoundError("会话不在运行");
    await session.stopTask(taskId);
  }

  /** 开着的会话都重连这个 MCP 服务器（登录之后）；没有这个服务器的会话报错，忽略 */
  reconnectMcpServer(name: string): void {
    for (const session of this.active.values()) {
      session.reconnectMcpServer(name).catch((err: Error) => this.log.debug({ sessionId: session.id, name, err: err.message }, "重连 MCP 服务器失败"));
    }
  }

  /** 清掉已经结束的后台任务 */
  clearFinishedTasks(sessionId: string): void {
    const list = this.taskList(sessionId);
    if (list.clearFinished()) this.hub.publish(sessionId, { type: "tasks", tasks: list.list() });
  }

  private taskList(sessionId: string): TaskList {
    let list = this.tasks.get(sessionId);
    if (!list) {
      // 会话 id 来自请求路径，只收 uuid 形式的，免得拼出别的路径
      const file = /^[\w-]+$/.test(sessionId) ? path.join(config.claudeConfigDir, "gateway-tasks", `${sessionId}.json`) : undefined;
      list = new TaskList(file);
      this.tasks.set(sessionId, list);
    }
    return list;
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.active.values()].map((s) => s.close()));
    await this.conversationLog.close();
  }

  private async launch(
    sessionId: string,
    resume: boolean,
    opts: { cwd: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode },
  ): Promise<AgentSession> {
    await this.makeRoom();
    const session = new AgentSession(
      sessionId,
      {
        resume,
        cwd: opts.cwd,
        model: opts.model,
        compacted: compactedSinceReply(sessionId),
        onContext: (usage) => saveUsage(sessionId, usage),
        effort: opts.effort ?? config.defaultEffort,
        permissionMode: opts.permissionMode ?? config.defaultPermissionMode,
        // 远程会话不管技能（远端只有 Claude Code 自带的和项目里的）
        skills: parseRemote(opts.cwd) ? undefined : await enabledSkillNames(opts.cwd),
      },
      this.hub,
      this.log,
      this.conversationLog,
      this.taskList(sessionId),
      (closed) => {
        if (this.active.get(closed.id) === closed) this.active.delete(closed.id);
        this.lastSettings.set(closed.id, { model: closed.modelOption, effort: closed.effort });
      },
      this.terminals,
      this.browser,
    );
    this.active.set(sessionId, session);
    this.log.info({ sessionId, resume, cwd: opts.cwd }, "启动 claude 会话");
    return session;
  }

  /** 活跃会话到上限时，关掉最久没用的空闲会话（有后台子代理在跑的不算空闲） */
  private async makeRoom(): Promise<void> {
    if (this.active.size < config.maxActiveSessions) return;
    const idle = [...this.active.values()]
      .filter((s) => s.state === "idle" && !s.agentsRunning)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
    if (!idle) throw new BusyError(`同时运行的会话已达上限（${config.maxActiveSessions}），请等其中一个结束`);
    await idle.close();
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const session of this.active.values()) {
      if (session.state === "idle" && !session.agentsRunning && now - session.lastActiveAt > config.sessionIdleMs) {
        this.log.info({ sessionId: session.id }, "会话空闲，关闭 claude 子进程");
        await session.close();
      }
    }
  }
}

/** SDK 的 skills 名单只拦模型调用 Skill 工具，用户在消息开头写 /技能名 还是会执行，所以这里拦 */
function rejectDisabledSkill(text: string): void {
  const name = /^\/(\S+)/.exec(text.trim())?.[1];
  if (name && disabledSkills().includes(name)) throw new BadRequestError(`技能「${name}」已停用，可以在设置里启用`);
}

/** 新会话选的文件夹：支持 ~，必须是已存在的目录 */
async function resolveDir(dir: string): Promise<string> {
  const expanded = dir.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(expanded)) throw new BadRequestError(`请填写绝对路径：${dir}`);
  const resolved = path.resolve(expanded);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new BadRequestError(`文件夹不存在：${resolved}`);
  return resolved;
}

/** 远程主机连上、准备好；连不上时报给网页 */
async function readyHost(hostId: string): Promise<SshHost> {
  const host = sshHost(hostId);
  try {
    await host.ensureReady();
  } catch (err) {
    throw new BadRequestError(`连接远程主机「${host.connection.name}」失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return host;
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
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const { createHash } = await import("node:crypto");
  const sftp = await host.sftp();
  // Windows 上的 claude 报的是 C:\Users\…\xx.output，SFTP 要 /C:/Users/…/xx.output（C:\… 会被当成相对用户目录的路径）
  file = fromWindowsPath(file);
  const size = await new Promise<number | null>((resolve) => sftp.stat(file, (err, s) => resolve(err ? null : s.size)));
  if (size === null) return null;
  const local = path.join(os.tmpdir(), `claude-app-ssh-${createHash("sha1").update(`${host.id}:${file}`).digest("hex").slice(0, 16)}`);
  const start = tail ? Math.max(0, size - 64 * 1024) : 0;
  if (size === 0) return null;
  await pipeline(sftp.createReadStream(file, { start, end: size - 1 }), createWriteStream(local, { mode: 0o600 }));
  return local;
}

/**
 * forkSession 把新记录最后一条消息的时间改成了分叉的时刻，网页按它算那一轮的用时（历史里没有 result），
 * 列表里的最后回复时间也按它：改回原记录里那条消息的时间（每行的 forkedFrom 指着原消息）
 */
async function restoreForkTime(sourceId: string, forkedId: string): Promise<void> {
  const [sourceDir, forkedDir] = await Promise.all([sessionRecordDir(sourceId), sessionRecordDir(forkedId)]);
  if (!sourceDir || !forkedDir) return;
  const file = path.join(forkedDir, `${forkedId}.jsonl`);
  const lines = (await readFile(file, "utf8")).split("\n");
  const index = lines.findLastIndex((l) => l.includes('"forkedFrom"'));
  if (index < 0) return;
  const entry = JSON.parse(lines[index]!) as { timestamp?: string; forkedFrom?: { messageUuid?: string } };
  const uuid = entry.forkedFrom?.messageUuid;
  if (!uuid) return;
  const source = (await readFile(path.join(sourceDir, `${sourceId}.jsonl`), "utf8")).split("\n").find((l) => l.includes(`"uuid":"${uuid}"`));
  const original = source ? (JSON.parse(source) as { uuid?: string; timestamp?: string }) : undefined;
  if (original?.uuid !== uuid || !original.timestamp || original.timestamp === entry.timestamp) return;
  lines[index] = JSON.stringify({ ...entry, timestamp: original.timestamp });
  await writeFile(file, lines.join("\n"));
}

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}
export class BusyError extends Error {}

