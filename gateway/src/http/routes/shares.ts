import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyInstance } from "fastify";
import { BadRequestError, NotFoundError, type SessionManager } from "../../agent/session-manager.js";
import { config } from "../../config.js";
import { isChatCwd, sessionRecordDir } from "../../agent/scratch.js";
import { lastCustomTitle } from "../../agent/session-records.js";
import path from "node:path";
import type { ShareBrowserRelay } from "../../share/browser-relay.js";
import type { LanServer } from "../../share/lan-server.js";
import { lanAddresses, type ShareStore } from "../../share/store.js";
import { saveShareSettings, settingsFrom, shareConfigured, ShareSettingsError, shareSettings, type ShareSettings } from "../../share/share-settings.js";
import { probeServer } from "../../share/ssh-tunnel.js";
import type { ShareInfo, ShareSettingsInput, ShareSettingsView, SharesView, ShareTestResult } from "../../shared/types.js";

interface IdParams {
  id: string;
}

/**
 * 局域网分享、公网分享（见 docs/lan-share.md）。
 * 开关分享的接口给本机用：局域网入口不放行它们。/share/info 给访客用：局域网入口校验过令牌，放在 X-Share-Token 里转过来
 */
export function shareRoutes(app: FastifyInstance, sessions: SessionManager, shares: ShareStore, lan: LanServer, relay: ShareBrowserRelay): void {
  const view = (): SharesView => ({ shares: shares.list(), port: config.sharePort, addresses: lanAddresses(), publicEnabled: shareConfigured(), tunnel: lan.tunnel.view });

  app.get("/shares", async () => view());

  app.post<{ Params: IdParams }>("/sessions/:id/share", async (req, reply) => {
    if (!(await sessions.cwd(req.params.id))) throw new NotFoundError(`会话不存在：${req.params.id}`);
    const existed = shares.bySession(req.params.id)?.lan;
    shares.add(req.params.id, "lan");
    await lan.sync();
    if (!lan.isListening("lan")) {
      // 端口被占用等：这次新开的分享撤掉，免得留下一条打不开的
      if (!existed) shares.removeScope(req.params.id, "lan");
      return reply.code(500).send({ error: lan.errors.lan ?? "局域网分享的入口没能开始监听" });
    }
    return view();
  });

  app.delete<{ Params: IdParams }>("/sessions/:id/share", async (req) => {
    shares.removeScope(req.params.id, "lan");
    await lan.sync();
    return view();
  });

  // 公网分享：开本机入口、连设置里的服务器开反向转发，等到自检通过（最多 25 秒，还没好时照常返回，tunnel.status 是 starting）
  app.post<{ Params: IdParams }>("/sessions/:id/share/public", async (req, reply) => {
    if (!(await sessions.cwd(req.params.id))) throw new NotFoundError(`会话不存在：${req.params.id}`);
    if (!shareConfigured()) throw new BadRequestError("还没在设置「公网分享」里配置服务器");
    const existed = shares.bySession(req.params.id)?.public;
    shares.add(req.params.id, "public");
    await lan.sync();
    const undo = async (error: string) => {
      // 这次新开的分享撤掉，免得留下一条打不开的
      if (!existed) shares.removeScope(req.params.id, "public");
      await lan.sync();
      return reply.code(500).send({ error });
    };
    if (!lan.isListening("public")) return undo(lan.errors.public ?? "公网分享的本机入口没能开始监听");
    const tunnel = await lan.tunnel.ensure();
    if (tunnel.status === "error") return undo(tunnel.error ?? "没能连上服务器");
    return view();
  });

  app.delete<{ Params: IdParams }>("/sessions/:id/share/public", async (req) => {
    shares.removeScope(req.params.id, "public");
    await lan.sync();
    return view();
  });

  // 设置页「公网分享」：服务器的地址、账号、端口。改了以后有公网分享时按新设置重新连（LanServer 里），清空了就停掉所有公网分享
  const settingsView = (): ShareSettingsView => {
    const { server } = shareSettings();
    return {
      configured: shareConfigured(),
      server: {
        connectionId: server.connectionId ?? "",
        host: server.host,
        sshPort: server.sshPort,
        username: server.username,
        hasPassword: Boolean(server.password),
        identityFile: server.identityFile ?? "",
        remotePort: server.remotePort,
        publicHost: server.publicHost ?? "",
        fingerprint: server.fingerprint ?? null,
      },
      tunnel: lan.tunnel.view,
    };
  };
  const parse = (body: ShareSettingsInput | undefined, requireServer = false): ShareSettings => {
    try {
      return settingsFrom(body ?? ({} as ShareSettingsInput), requireServer);
    } catch (err) {
      if (err instanceof ShareSettingsError) throw new BadRequestError(err.message);
      throw err;
    }
  };

  app.get("/share/settings", async () => settingsView());

  app.put<{ Body: ShareSettingsInput }>("/share/settings", async (req) => {
    saveShareSettings(parse(req.body));
    if (!shareConfigured()) {
      for (const s of shares.list()) if (s.public) shares.removeScope(s.sessionId, "public");
      await lan.sync();
    }
    return settingsView();
  });

  /** 按请求体里的服务器配置连一次、开端口、从外面访问一次，不保存 */
  app.post<{ Body: ShareSettingsInput }>("/share/settings/test", async (req): Promise<ShareTestResult> => {
    const next = parse(req.body, true);
    const live = shareSettings();
    const tunnel = lan.tunnel.view;
    // 公网分享正挂在同一台服务器的同一个端口上：再开一次会冲突，直接用现在的
    const same = (["connectionId", "host", "sshPort", "username", "remotePort", "publicHost"] as const).every((k) => (live.server[k] ?? "") === (next.server[k] ?? ""));
    if (tunnel.status === "ready" && same) return { ok: true, url: tunnel.url ?? "", fingerprint: live.server.fingerprint ?? "" };
    const { state, fingerprint } = await probeServer(next.server, app.log);
    if (state.status === "ready") return { ok: true, url: state.url ?? "", fingerprint: fingerprint ?? "" };
    return { ok: false, error: state.error ?? "连接超时" };
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
