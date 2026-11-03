import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { EventHub } from "../events/event-hub.js";
import type { SessionSummary } from "../shared/types.js";
import { AgentSession } from "./session.js";

/** 活跃会话表：新建、按需 resume、空闲回收；历史会话直接读 Claude Code 落盘的 jsonl */
export class SessionManager {
  private readonly active = new Map<string, AgentSession>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly hub: EventHub,
    private readonly log: FastifyBaseLogger,
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
  async create(text: string, opts: { model?: string; permissionMode?: PermissionMode }): Promise<AgentSession> {
    const session = await this.launch(randomUUID(), false, opts);
    session.send(text);
    return session;
  }

  /** 发送消息；会话不活跃时先 resume */
  async send(sessionId: string, text: string): Promise<string> {
    let session = this.active.get(sessionId);
    if (!session) {
      if (!(await this.exists(sessionId))) throw new NotFoundError(`会话不存在：${sessionId}`);
      session = await this.launch(sessionId, true, {});
    }
    return session.send(text);
  }

  async list(): Promise<SessionSummary[]> {
    const stored = await listSessions({ dir: config.workspaceDir });
    const result: SessionSummary[] = stored.map((info) => ({
      sessionId: info.sessionId,
      title: info.customTitle || info.firstPrompt || info.summary || "新会话",
      lastModified: info.lastModified,
      active: this.active.has(info.sessionId),
      state: this.active.get(info.sessionId)?.state,
    }));
    // 刚建的会话第一轮还没落盘时也要出现在列表里
    for (const session of this.active.values()) {
      if (!result.some((s) => s.sessionId === session.id)) {
        result.unshift({ sessionId: session.id, title: "新会话", lastModified: session.lastActiveAt, active: true, state: session.state });
      }
    }
    return result.sort((a, b) => b.lastModified - a.lastModified);
  }

  async messages(sessionId: string) {
    return getSessionMessages(sessionId, { dir: config.workspaceDir });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await renameSession(sessionId, title, { dir: config.workspaceDir });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.active.get(sessionId)?.close();
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.active.values()].map((s) => s.close()));
  }

  private async launch(
    sessionId: string,
    resume: boolean,
    opts: { model?: string; permissionMode?: PermissionMode },
  ): Promise<AgentSession> {
    await this.makeRoom();
    const session = new AgentSession(
      sessionId,
      { resume, model: opts.model, permissionMode: opts.permissionMode ?? config.defaultPermissionMode },
      this.hub,
      this.log,
      (closed) => {
        if (this.active.get(closed.id) === closed) this.active.delete(closed.id);
      },
    );
    this.active.set(sessionId, session);
    this.log.info({ sessionId, resume }, "启动 claude 会话");
    return session;
  }

  private async exists(sessionId: string): Promise<boolean> {
    return Boolean(await getSessionInfo(sessionId, { dir: config.workspaceDir }));
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

export class NotFoundError extends Error {}
export class BusyError extends Error {}
