import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  deleteSession,
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
import type { BackgroundTask, SessionListItem } from "../shared/types.js";
import { loadAttachments } from "./attachments.js";
import { enabledSkillNames } from "./capabilities.js";
import { disabledSkills } from "./extensions.js";
import { AgentSession } from "./session.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { BrowserHost } from "../browser/host.js";
import { generateTitle } from "./title.js";
import { readOutputTail, TaskList } from "./tasks.js";
import { disposeRepls } from "../browser/tool.js";
import { disposeDesktopSession } from "../desktop/guard.js";
import { sessionHistory } from "./history.js";
import { lastCustomTitle, lastResponseAt, sessionRecordFiles } from "./session-records.js";
import { createScratchDir, isChatCwd, removeScratchDirIfEmpty, sessionRecordDir } from "./scratch.js";

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
    // 没选文件夹：给这个会话新建一个工作目录（同 Claude 桌面版），不和别的普通会话共用
    const cwd = opts.cwd ? await resolveDir(opts.cwd) : await createScratchDir();
    const attachments = await loadAttachments(opts.attachments ?? []);
    const session = await this.launch(randomUUID(), false, { ...opts, cwd });
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
        await renameSession(sessionId, title);
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
  async send(sessionId: string, text: string, attachmentIds: string[] = []): Promise<string> {
    rejectDisabledSkill(text);
    const attachments = await loadAttachments(attachmentIds);
    return (await this.activate(sessionId)).send(text, attachments);
  }

  /** 活跃会话直接返回；子进程已回收的用原来的工作目录 resume */
  async activate(sessionId: string): Promise<AgentSession> {
    const session = this.active.get(sessionId);
    if (session) return session;
    const info = await getSessionInfo(sessionId);
    if (!info) throw new NotFoundError(`会话不存在：${sessionId}`);
    return this.launch(sessionId, true, { cwd: info.cwd || config.workspaceDir });
  }

  /** 会话的工作目录；没有这个会话时 null */
  async cwd(sessionId: string): Promise<string | null> {
    const session = this.active.get(sessionId);
    if (session) return session.cwd;
    return (await getSessionInfo(sessionId))?.cwd || null;
  }

  async list(): Promise<SessionListItem[]> {
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
        return {
          ...info,
          ...(customTitle ? { customTitle } : {}),
          chat: isChatCwd(info.cwd),
          state: this.active.get(info.sessionId)?.state,
          lastResponseAt: responded ?? info.createdAt ?? info.lastModified,
        };
      }),
    );
    // 刚建的会话第一轮还没落盘时也要出现在列表里，字段按 SDKSessionInfo 补
    for (const session of this.active.values()) {
      if (!stored.some((s) => s.sessionId === session.id)) {
        const customTitle = this.titles.get(session.id);
        stored.push({ sessionId: session.id, summary: customTitle ?? "", ...(customTitle ? { customTitle } : {}), lastModified: session.lastActiveAt, lastResponseAt: session.lastActiveAt, cwd: session.cwd, chat: isChatCwd(session.cwd), state: session.state });
      }
    }
    return stored.sort((a, b) => b.lastResponseAt - a.lastResponseAt);
  }

  /** 历史消息：压缩上下文之前的也接上（见 history.ts） */
  async messages(sessionId: string) {
    return sessionHistory(sessionId);
  }

  /** 用户改标题：写成自定义标题，打开这个会话的页面通过 title 事件跟着变 */
  async rename(sessionId: string, title: string): Promise<void> {
    await renameSession(sessionId, title);
    this.titles.set(sessionId, title);
    this.hub.publish(sessionId, { type: "title", title });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.active.get(sessionId)?.close();
  }

  /** 删除会话：先关掉子进程，再删 Claude Code 落盘的会话记录（jsonl 和子代理记录），事件缓冲一起清掉 */
  async delete(sessionId: string): Promise<void> {
    const session = this.active.get(sessionId);
    await session?.close();
    const info = await getSessionInfo(sessionId);
    const cwd = session?.cwd ?? info?.cwd;
    const recordDir = info ? await sessionRecordDir(sessionId) : undefined;
    // 刚建的会话第一轮还没落盘时只有子进程，没有文件可删
    this.titles.delete(sessionId);
    if (info) await deleteSession(sessionId);
    else if (!session) throw new NotFoundError(`会话不存在：${sessionId}`);
    // close() 只等到消息流结束，子进程退出时还会往 jsonl 写最后几条记录，把删掉的文件又建出来，所以再查几次
    if (session) {
      for (let i = 0; i < 6; i++) {
        await sleep(250);
        if (await getSessionInfo(sessionId)) await deleteSession(sessionId);
      }
    }
    this.hub.remove(sessionId);
    this.taskList(sessionId).dispose();
    this.tasks.delete(sessionId);
    // 浏览器工具的 REPL（browser_run_code 的变量、当前标签页）按会话留在网关里，删会话时一起删
    disposeRepls(sessionId);
    // 桌面工具的快照（agent-desktop 的状态目录里这个会话的命名空间）和网关记下的 ref
    disposeDesktopSession(sessionId);
    // 内置浏览器里这个会话的标签页也关掉：AI 留下的、用户开的不会自动关，不关的话会一直留在桌面版后台（会话没了，面板里也看不到）
    this.browser?.closeSession(sessionId);
    await removeScratchDirIfEmpty(cwd, recordDir);
  }

  listTasks(sessionId: string): BackgroundTask[] {
    return this.taskList(sessionId).list();
  }

  /** 任务输出的最后一段；只能读这个会话自己记下的任务的输出文件 */
  async taskOutput(sessionId: string, taskId: string): Promise<{ text: string; truncated: boolean }> {
    const file = this.taskList(sessionId).outputFile(taskId);
    if (!file) throw new NotFoundError("这个任务没有输出");
    return readOutputTail(file).catch(() => ({ text: "", truncated: false }));
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
        effort: opts.effort ?? config.defaultEffort,
        permissionMode: opts.permissionMode ?? config.defaultPermissionMode,
        skills: await enabledSkillNames(opts.cwd),
      },
      this.hub,
      this.log,
      this.conversationLog,
      this.taskList(sessionId),
      (closed) => {
        if (this.active.get(closed.id) === closed) this.active.delete(closed.id);
      },
      this.terminals,
      this.browser,
    );
    this.active.set(sessionId, session);
    this.log.info({ sessionId, resume, cwd: opts.cwd }, "启动 claude 会话");
    return session;
  }

  /** 活跃会话到上限时，关掉最久没用的空闲会话 */
  private async makeRoom(): Promise<void> {
    if (this.active.size < config.maxActiveSessions) return;
    const idle = [...this.active.values()]
      .filter((s) => s.state === "idle")
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
    if (!idle) throw new BusyError(`同时运行的会话已达上限（${config.maxActiveSessions}），请等其中一个结束`);
    await idle.close();
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const session of this.active.values()) {
      if (session.state === "idle" && now - session.lastActiveAt > config.sessionIdleMs) {
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

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}
export class BusyError extends Error {}

