import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { forkSession, getSessionInfo, listSessions, type EffortLevel, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { EventHub } from "../events/event-hub.js";
import type { ConversationLog } from "../logging/conversation-log.js";
import type { BackgroundTask, MessagePriority, SessionContextInfo, SessionListItem, SessionSearchResult, TaskOutput } from "../shared/types.js";
import { searchSessions } from "./session-search.js";
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
import { placeNewSession, sessionHome } from "./session-home.js";
import { lastCustomTitle, lastResponseAt, lastResponseModel, recordedCwd, recordedForkParent, sessionRecordFile, sessionRecordFiles } from "./session-records.js";
import { isChatCwd } from "./scratch.js";
import { parseRemote } from "../ssh/location.js";
import { existingHost } from "../ssh/hosts.js";
import type { SshHost } from "../ssh/host.js";
import { syncHost } from "../ssh/transcripts.js";
import { listConnections } from "../ssh/connections.js";
import { compactedSinceReply, forgetSession, savedUsage, saveUsage } from "./context-usage.js";
import { goalCondition, recordedGoal } from "./goal.js";
import { onProxyChange, proxyEnvKey } from "../net/proxy.js";
import { BadRequestError, BusyError, ConflictError, NotFoundError } from "../errors.js";

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
  /** 本机会话的子进程启动时的代理环境变量（net/proxy.ts 的 proxyEnvKey）；远程会话不带代理变量，不记 */
  private readonly proxyKeys = new WeakMap<AgentSession, string>();

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
    onProxyChange(() => void this.recycleProxyStale());
  }

  get(sessionId: string): AgentSession | undefined {
    return this.active.get(sessionId);
  }

  /** 灵宠悬停卡片用：取指定会话里正在跑的这一轮的最新回复与当前动作 */
  liveReplies(ids: string[]): { sessionId: string; text: string; activity: string; startedAt: number }[] {
    return ids.slice(0, 20).flatMap((sessionId) => {
      const peek = this.active.get(sessionId)?.peek();
      return peek ? [{ sessionId, ...peek }] : [];
    });
  }

  /** 新建会话并发送第一条消息。opts.goal：不发消息，新会话一开始就设定这个目标（见 AgentSession.setGoal），text 不用 */
  async create(
    text: string,
    opts: { cwd?: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; attachments?: string[]; goal?: string },
  ): Promise<AgentSession> {
    // 条件不对先报错，不留一个空会话
    const goal = opts.goal === undefined ? undefined : goalCondition(opts.goal);
    if (goal === undefined) rejectDisabledSkill(text);
    const sessionId = randomUUID();
    const cwd = await placeNewSession(sessionId, opts.cwd);
    const attachments = [...(await loadAttachments(opts.attachments ?? [])), ...(await this.referencedSessions(text))];
    const session = await this.launch(sessionId, false, { ...opts, cwd });
    if (goal !== undefined) {
      session.setGoal(goal);
      void this.nameSession(session.id, goal);
      return session;
    }
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
        await sessionHome(sessionId).writeTitle(title);
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
  async send(
    sessionId: string,
    text: string,
    attachmentIds: string[] = [],
    elementInputs: SelectedElementInput[] = [],
    priority?: MessagePriority,
    draft?: unknown,
  ): Promise<string> {
    rejectDisabledSkill(text);
    const attachments = [...(await loadAttachments(attachmentIds)), ...(await this.referencedSessions(text))];
    const elements = await loadElements(elementInputs);
    return (await this.activate(sessionId)).send(text, attachments, elements, priority, draft);
  }

  /** 活跃会话直接返回；子进程已回收的用原来的工作目录 resume。远程会话先等分叉的记录传完、连上主机、同步一下记录 */
  async activate(sessionId: string): Promise<AgentSession> {
    const session = this.active.get(sessionId);
    // 子进程是按旧的代理设置启动的：能关就关掉再 resume，这条消息就走新的代理
    if (session && this.proxyStale(session) && reclaimable(session)) {
      this.log.info({ sessionId }, "网络代理设置改了，换掉 claude 子进程");
      await session.close();
    } else if (session) return session;
    const home = sessionHome(sessionId);
    await home.prepareResume();
    const info = await getSessionInfo(sessionId);
    if (!info) throw new NotFoundError(`会话不存在：${sessionId}`);
    const settings = this.lastSettings.get(sessionId) ?? { model: await this.recordedModel(sessionId) };
    const recorded = await this.infoCwd(info);
    if (home.hostId && !recorded) throw new NotFoundError(`远程会话的记录里没有工作目录：${sessionId}`);
    return this.launch(sessionId, true, { cwd: recorded ? home.cwd(recorded) : config.workspaceDir, ...settings });
  }

  /** 记录文件里最后一次回复用的模型 */
  private async recordedModel(sessionId: string): Promise<string | undefined> {
    const file = await sessionRecordFile(sessionId);
    return file && lastResponseModel(file);
  }

  /** 会话的工作目录；没有这个会话时 null */
  async cwd(sessionId: string): Promise<string | null> {
    const session = this.active.get(sessionId);
    if (session) return session.cwd;
    const info = await getSessionInfo(sessionId);
    const cwd = info && (await this.infoCwd(info));
    return cwd ? sessionHome(sessionId).cwd(cwd) : null;
  }

  /**
   * SDK 给的会话工作目录；它没读出来时（只看记录文件开头 64KB，第一条消息带了图片就不在这段里）从记录文件里找。
   * 不补的话项目会话会被当成普通会话列到「会话」里，子进程回收后 resume 也会跑到默认工作目录
   */
  private async infoCwd(info: { sessionId: string; cwd?: string }, file?: string): Promise<string | undefined> {
    if (info.cwd) return info.cwd;
    file ??= await sessionRecordFile(info.sessionId);
    return file && recordedCwd(file);
  }

  /** sync：先同步连着的远程主机的会话记录；false 时直接列本机已有的（查找用，网页每 10 秒列一次会话，记录已经跟着同步了） */
  async list(sync = true): Promise<SessionListItem[]> {
    // 连着的远程主机先把会话记录同步过来（最多等 3 秒，没同步完的下次再列）；没连着的用本机已有的副本
    const syncs = !sync ? [] : listConnections().map((c) => existingHost(c.id)).filter((h): h is SshHost => Boolean(h?.isReady)).map((h) => syncHost(h).catch(() => undefined));
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
        const forkedFromSessionId = file ? await recordedForkParent(file) : undefined;
        const recorded = await this.infoCwd(info, file);
        const cwd = recorded && sessionHome(info.sessionId).cwd(recorded);
        return {
          ...info,
          ...(customTitle ? { customTitle } : {}),
          ...(cwd ? { cwd } : {}),
          ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
          chat: isChatCwd(cwd),
          state: this.active.get(info.sessionId)?.state,
          tasksRunning: this.active.get(info.sessionId)?.backgroundBusy || undefined,
          terminalsRunning: this.terminals?.agentRunning(info.sessionId) || undefined,
          lastResponseAt: responded ?? info.createdAt ?? info.lastModified,
        };
      }),
    );
    // 刚建的会话第一轮还没落盘时也要出现在列表里，字段按 SDKSessionInfo 补
    for (const session of this.active.values()) {
      if (!stored.some((s) => s.sessionId === session.id)) {
        const customTitle = this.titles.get(session.id);
        stored.push({ sessionId: session.id, summary: customTitle ?? "", ...(customTitle ? { customTitle } : {}), lastModified: session.lastActiveAt, lastResponseAt: session.lastActiveAt, cwd: session.cwd, chat: isChatCwd(session.cwd), state: session.state, tasksRunning: session.backgroundBusy || undefined, terminalsRunning: this.terminals?.agentRunning(session.id) || undefined });
      }
    }
    return stored.sort((a, b) => b.lastResponseAt - a.lastResponseAt);
  }

  /**
   * 在一个项目（工作目录是 cwd 的项目会话，同侧边栏「项目」里的分组）的所有会话记录里查找，见 session-search.ts。
   * 会话按列表的顺序（最近回复的在前）；远程会话查的是同步到本机的副本（列会话时同步的，这里不再等同步）
   */
  async search(cwd: string, query: string): Promise<SessionSearchResult> {
    const ids = (await this.list(false)).filter((s) => !s.chat && (s.cwd || config.workspaceDir) === cwd).map((s) => s.sessionId);
    return searchSessions(ids, query);
  }

  /** 历史消息：压缩上下文之前的也接上（见 history.ts）。远程会话连着时先同步一下记录 */
  async messages(sessionId: string) {
    await sessionHome(sessionId).refresh();
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
    await sessionHome(sessionId).writeTitle(title);
    this.titles.set(sessionId, title);
    this.hub.publish(sessionId, { type: "title", title });
  }

  /**
   * 从某条消息分叉：新会话的记录是源会话到这条消息为止（含）的部分（SDK 的 forkSession，消息换成新的 uuid），
   * 工作目录、模型和推理强度跟源会话一样，标题是源会话的加「（分叉）」，已经有同名的会话时编号：「（分叉 2）」「（分叉 3）」…
   * 新会话不拉起子进程，发消息时再 resume。
   * 远程会话在本机副本上分叉，再把新记录传到远端
   */
  async fork(sessionId: string, upToMessageId: string): Promise<string> {
    let title = "";
    const forkedId = await sessionHome(sessionId).fork(async () => {
      const info = await getSessionInfo(sessionId);
      if (!info) throw new NotFoundError(`会话不存在：${sessionId}`);
      title = await this.forkTitle(this.titles.get(sessionId) || info.customTitle || info.summary);
      const forked = await forkSession(sessionId, { upToMessageId, title }).catch((err: Error) => {
        throw /not found/i.test(err.message) ? new BadRequestError("会话记录里没有这条消息") : err;
      });
      await restoreForkTime(sessionId, forked.sessionId).catch((err: Error) => this.log.warn({ err, sessionId }, "分叉记录的时间没改回来"));
      return forked.sessionId;
    });
    this.titles.set(forkedId, title);
    const active = this.active.get(sessionId);
    const settings = active ? { model: active.model, effort: active.effort } : this.lastSettings.get(sessionId);
    if (settings) this.lastSettings.set(forkedId, settings);
    return forkedId;
  }

  /**
   * 分叉出的会话的标题：源标题末尾已经有「（分叉）」「（分叉 N）」的（从分叉出的会话再分叉）先去掉，不叠加；
   * 和现有会话（列表里显示的标题）重名时从 2 开始编号
   */
  private async forkTitle(title: string | undefined): Promise<string> {
    const source = title?.replace(/(（分叉(?: \d+)?）)+$/, "") || title;
    const infos = await listSessions().catch(() => []);
    const taken = new Set([...infos.map((i) => this.titles.get(i.sessionId) || i.customTitle || i.summary), ...this.titles.values()]);
    const name = (n: number) => {
      const no = n > 1 ? ` ${n}` : "";
      return source ? `${source}（分叉${no}）` : `分叉的会话${no}`;
    };
    let n = 1;
    while (taken.has(name(n))) n++;
    return name(n);
  }

  /** 输入框要的：最后一次取到的上下文用量，进行中的目标（子进程在跑的用它跟踪的，否则从记录里读）。不拉起子进程 */
  async contextInfo(sessionId: string): Promise<SessionContextInfo> {
    const active = this.active.get(sessionId);
    const goal = active?.goalLoaded ? active.goal : (await recordedGoal(sessionId).catch(() => ({ goal: null }))).goal;
    return { usage: savedUsage(sessionId), goal };
  }

  /** 压缩上下文：子进程回收了的先 resume */
  async compact(sessionId: string): Promise<void> {
    (await this.activate(sessionId)).compact();
  }

  /** 设定目标（换掉已有的）：条件不对先报错；子进程回收了的先 resume */
  async setGoal(sessionId: string, text: string): Promise<void> {
    const condition = goalCondition(text);
    (await this.activate(sessionId)).setGoal(condition);
  }

  /** 取消目标：子进程回收了的先 resume（Claude Code resume 时从记录里恢复了目标，要它自己清掉） */
  async clearGoal(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active && !(await recordedGoal(sessionId).catch(() => ({ goal: null }))).goal) throw new ConflictError("没有进行中的目标");
    (await this.activate(sessionId)).clearGoal();
  }

  /**
   * 清空会话（同 Claude Code 的 /clear、Claude 桌面版的清空会话）：上下文清掉，返回新的会话 id。
   * Claude Code 清空后换了一个新的会话 id，原来的记录留着不动（列表里还是原来那个会话，可以打开、接着聊、删除）；
   * 新会话沿用原来的工作目录、标题、模型、推理强度和权限模式。子进程回收了的先 resume。
   * 清完关掉子进程、按新 id 重新拉起：子进程里的浏览器、桌面工具是按会话 id 建的
   */
  async clear(sessionId: string): Promise<string> {
    const session = await this.activate(sessionId);
    const { cwd, modelOption: model, effort, permissionMode } = session;
    const info = await getSessionInfo(sessionId).catch(() => undefined);
    // 新记录的第一条是 /clear 命令本身，不设标题的话列表里显示成「/clear」
    const title = this.titles.get(sessionId) || info?.customTitle || info?.summary || "新会话";
    const newId = await session.clear();
    await session.close();
    await sessionHome(sessionId).adopt(newId);
    try {
      await sessionHome(newId).writeTitle(title);
      this.titles.set(newId, title);
    } catch (err) {
      this.log.warn({ sessionId: newId, err }, "给清空后的会话设置标题失败");
    }
    this.lastSettings.set(newId, { model, effort });
    this.log.info({ sessionId, newId }, "清空会话");
    (await this.launch(newId, true, { cwd, model, effort, permissionMode })).announce();
    return newId;
  }

  /** 删除会话：先关掉子进程，再删会话记录（jsonl 和子代理记录，远程会话是远端的和本机的副本），事件缓冲、终端、浏览器标签页一起清掉 */
  async delete(sessionId: string): Promise<void> {
    const session = this.active.get(sessionId);
    await session?.close();
    const cwd = session?.cwd ?? (await this.cwd(sessionId));
    const removeWorkdir = await sessionHome(sessionId).deleteRecord(cwd, Boolean(session));
    this.titles.delete(sessionId);
    this.lastSettings.delete(sessionId);
    forgetSession(sessionId);
    this.disposeSession(sessionId);
    await removeWorkdir();
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
    // 右侧面板里这个会话的终端（面板按会话显示，会话没了就没人看得到了）
    this.terminals?.closeSession(sessionId);
  }

  listTasks(sessionId: string): BackgroundTask[] {
    return this.taskList(sessionId).list();
  }

  /** 任务输出的最后一段（子代理是整理过的对话记录）；只能读这个会话自己记下的任务的输出文件 */
  async taskOutput(sessionId: string, taskId: string): Promise<TaskOutput> {
    const output = this.taskList(sessionId).output(taskId);
    if (!output) throw new NotFoundError("这个任务没有输出");
    // 远程会话的输出文件在远端：取回来放进本机的临时文件再读
    const file = await sessionHome(sessionId).outputFile(output.file, !output.agent);
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
    if (!parseRemote(opts.cwd)) this.proxyKeys.set(session, proxyEnvKey());
    this.log.info({ sessionId, resume, cwd: opts.cwd }, "启动 claude 会话");
    return session;
  }

  /** 活跃会话到上限时，关掉最久没用的空闲会话（有后台任务在跑、有通知没交给模型、有定时任务排着的不算空闲） */
  private async makeRoom(): Promise<void> {
    if (this.active.size < config.maxActiveSessions) return;
    const idle = [...this.active.values()]
      .filter(reclaimable)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
    if (!idle) throw new BusyError(`同时运行的会话已达上限（${config.maxActiveSessions}），请等其中一个结束`);
    await idle.close();
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const session of this.active.values()) {
      if (reclaimable(session) && now - session.lastActiveAt > config.sessionIdleMs) {
        this.log.info({ sessionId: session.id }, "会话空闲，关闭 claude 子进程");
        await session.close();
      }
    }
    await this.recycleProxyStale();
  }

  private proxyStale(session: AgentSession): boolean {
    const key = this.proxyKeys.get(session);
    return key !== undefined && key !== proxyEnvKey();
  }

  /**
   * 网络代理设置改了：按旧设置启动的子进程，空闲的关掉（下次发消息时 resume，用新的环境变量）；
   * 正在跑的、有后台任务或通知没交给模型的先留着，之后每分钟的清理或下一条消息时再换
   */
  private async recycleProxyStale(): Promise<void> {
    for (const session of [...this.active.values()]) {
      if (!this.proxyStale(session) || !reclaimable(session)) continue;
      this.log.info({ sessionId: session.id }, "网络代理设置改了，关闭 claude 子进程");
      await session.close();
    }
  }
}

/**
 * 可以关掉子进程的会话：空闲，没有后台任务在跑（子进程关了，它拉起的后台命令、子代理也跟着没了），没有通知没交给模型，
 * 没有定时任务排着（定时任务只在子进程的内存里，关了就没了，resume 也不恢复）
 */
function reclaimable(session: AgentSession): boolean {
  return session.state === "idle" && !session.backgroundBusy && !session.cronsScheduled;
}

/** SDK 的 skills 名单只拦模型调用 Skill 工具，用户在消息开头写 /技能名 还是会执行，所以这里拦 */
function rejectDisabledSkill(text: string): void {
  const name = /^\/(\S+)/.exec(text.trim())?.[1];
  if (name && disabledSkills().includes(name)) throw new BadRequestError(`技能「${name}」已停用，可以在设置里启用`);
}

/**
 * forkSession 把新记录最后一条消息的时间改成了分叉的时刻，网页按它算那一轮的用时（历史里没有 result），
 * 列表里的最后回复时间也按它：改回原记录里那条消息的时间（每行的 forkedFrom 指着原消息）
 */
async function restoreForkTime(sourceId: string, forkedId: string): Promise<void> {
  const [sourceFile, file] = await Promise.all([sessionRecordFile(sourceId), sessionRecordFile(forkedId)]);
  if (!sourceFile || !file) return;
  const lines = (await readFile(file, "utf8")).split("\n");
  const index = lines.findLastIndex((l) => l.includes('"forkedFrom"'));
  if (index < 0) return;
  const entry = JSON.parse(lines[index]!) as { timestamp?: string; forkedFrom?: { messageUuid?: string } };
  const uuid = entry.forkedFrom?.messageUuid;
  if (!uuid) return;
  const source = (await readFile(sourceFile, "utf8")).split("\n").find((l) => l.includes(`"uuid":"${uuid}"`));
  const original = source ? (JSON.parse(source) as { uuid?: string; timestamp?: string }) : undefined;
  if (original?.uuid !== uuid || !original.timestamp || original.timestamp === entry.timestamp) return;
  lines[index] = JSON.stringify({ ...entry, timestamp: original.timestamp });
  await writeFile(file, lines.join("\n"));
}

