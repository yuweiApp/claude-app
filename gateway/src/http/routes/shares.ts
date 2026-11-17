import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyInstance } from "fastify";
import { NotFoundError, type SessionManager } from "../../agent/session-manager.js";
import { config } from "../../config.js";
import { isChatCwd, sessionRecordDir } from "../../agent/scratch.js";
import { lastCustomTitle } from "../../agent/session-records.js";
import path from "node:path";
import type { ShareBrowserRelay } from "../../share/browser-relay.js";
import type { LanServer } from "../../share/lan-server.js";
import { lanAddresses, type ShareStore } from "../../share/store.js";
import type { ShareInfo, SharesView } from "../../shared/types.js";

interface IdParams {
  id: string;
}

/**
 * 局域网分享（见 docs/lan-share.md）。
 * 开关分享的接口给本机用：局域网入口不放行它们。/share/info 给访客用：局域网入口校验过令牌，放在 X-Share-Token 里转过来
 */
export function shareRoutes(app: FastifyInstance, sessions: SessionManager, shares: ShareStore, lan: LanServer, relay: ShareBrowserRelay): void {
  const view = (): SharesView => ({ shares: shares.list(), port: config.sharePort, addresses: lanAddresses() });

  app.get("/shares", async () => view());

  app.post<{ Params: IdParams }>("/sessions/:id/share", async (req, reply) => {
    if (!(await sessions.cwd(req.params.id))) throw new NotFoundError(`会话不存在：${req.params.id}`);
    const existed = shares.bySession(req.params.id);
    shares.add(req.params.id);
    await lan.sync();
    if (!lan.listening) {
      // 端口被占用等：这次新开的分享撤掉，免得留下一条打不开的
      if (!existed) shares.remove(req.params.id);
      return reply.code(500).send({ error: lan.error ?? "局域网分享的入口没能开始监听" });
    }
    return view();
  });

  app.delete<{ Params: IdParams }>("/sessions/:id/share", async (req) => {
    shares.remove(req.params.id);
    await lan.sync();
    return view();
  });

  app.get("/share/info", async (req, reply): Promise<ShareInfo | undefined> => {
    const token = req.headers["x-share-token"];
    const share = shares.byToken(typeof token === "string" ? token : undefined);
    if (!share) return reply.code(401).send({ error: "分享已结束或链接无效" });
    const info = await getSessionInfo(share.sessionId).catch(() => undefined);
    // 同会话列表（SessionManager.list）：SDK 只看记录文件开头，后来生成、改过的标题要从整个文件里找
    let customTitle = info?.customTitle;
    if (!customTitle) {
      const dir = await sessionRecordDir(share.sessionId).catch(() => undefined);
      if (dir) customTitle = await lastCustomTitle(path.join(dir, `${share.sessionId}.jsonl`));
    }
    const recorded = await sessions.cwd(share.sessionId);
    return {
      sessionId: share.sessionId,
      cwd: recorded ?? config.workspaceDir,
      title: customTitle || info?.firstPrompt || info?.summary || null,
      chat: !recorded || isChatCwd(recorded),
    };
  });

  // 访客操作内置浏览器（share/browser-relay.ts）：局域网入口校验过令牌，放在 X-Share-Token 里转过来
  void app.register(async (scoped) => {
    scoped.get("/share/browser", { websocket: true }, (socket, req) => {
      const token = req.headers["x-share-token"];
      relay.connect(socket, typeof token === "string" ? token : undefined);
    });
  });
}
