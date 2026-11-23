import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../../agent/session-manager.js";
import { config } from "../../config.js";
import { isChatCwd } from "../../agent/scratch.js";
import { lastCustomTitle, sessionRecordFile } from "../../agent/session-records.js";
import type { ShareBrowserRelay } from "../../share/browser-relay.js";
import type { LanServer } from "../../share/lan-server.js";
import { lanAddresses, type ShareStore } from "../../share/store.js";
import { saveShareSettings, settingsFrom, shareConfigured, shareSettings } from "../../share/share-settings.js";
import { fixGatewayPorts, probeServer } from "../../share/ssh-tunnel.js";
import type { ShareFixResult, ShareInfo, ShareSettingsInput, ShareSettingsView, SharesView, ShareTestResult } from "../../shared/types.js";
import { NotFoundError, BadRequestError } from "../../errors.js";

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

  // 设置页「公网分享」：用哪个 SSH 连接、公网端口、链接里的地址。改了以后有公网分享时按新设置重新连（LanServer 里），清空了就停掉所有公网分享
  const settingsView = (): ShareSettingsView => {
    const { server } = shareSettings();
    return {
      configured: shareConfigured(),
      server: {
        connectionId: server.connectionId ?? "",
        hasPassword: Boolean(server.password),
        remotePort: server.remotePort,
        publicHost: server.publicHost ?? "",
      },
      tunnel: lan.tunnel.view,
    };
  };

  app.get("/share/settings", async () => settingsView());

  app.put<{ Body: ShareSettingsInput }>("/share/settings", async (req) => {
    saveShareSettings(settingsFrom(req.body));
    if (!shareConfigured()) {
      for (const s of shares.list()) if (s.public) shares.removeScope(s.sessionId, "public");
      await lan.sync();
    }
    return settingsView();
  });

  /** 按请求体里的服务器配置连一次、开端口、从外面访问一次，不保存 */
  app.post<{ Body: ShareSettingsInput }>("/share/settings/test", async (req): Promise<ShareTestResult> => {
    const next = settingsFrom(req.body, true);
    const live = shareSettings();
    const same = (["connectionId", "remotePort", "publicHost"] as const).every((k) => (live.server[k] ?? "") === (next.server[k] ?? ""));
    // 测的就是现在公网分享在用的服务器和端口：另开一条会和它抢端口，直接用（没连着就连）它，结果也就是公网分享的状态
    const state = same && (shares.list().some((s) => s.public) || lan.tunnel.view.status === "ready") ? await lan.tunnel.ensure() : await probeServer(next.server, app.log);
    if (state.status === "ready") return { ok: true, url: state.url ?? "" };
    return { ok: false, error: state.error ?? "连接超时", ...(state.fix ? { fix: state.fix } : {}) };
  });

  /** 按请求体里的服务器配置登录服务器，开启 sshd 的 GatewayPorts（设置页自检报端口只开在 127.0.0.1 上时的按钮）；成功后有公网分享就重新连 */
  app.post<{ Body: ShareSettingsInput }>("/share/settings/fix-gateway-ports", async (req): Promise<ShareFixResult> => {
    const result = await fixGatewayPorts(settingsFrom(req.body, true).server, app.log);
    // 现在的转发是改之前连的，GatewayPorts 对它不生效：断开，有公网分享就按设置重新连，等连好再返回（设置页接着测试时直接用它）
    if (result.ok) {
      lan.tunnel.stop();
      await lan.sync();
      if (shares.list().some((s) => s.public)) await lan.tunnel.ensure();
    }
    return result;
  });

  app.get("/share/info", async (req, reply): Promise<ShareInfo | undefined> => {
    const token = req.headers["x-share-token"];
    const share = shares.byToken(typeof token === "string" ? token : undefined);
    if (!share) return reply.code(401).send({ error: "分享已结束或链接无效" });
    const info = await getSessionInfo(share.sessionId).catch(() => undefined);
    // 同会话列表（SessionManager.list）：SDK 只看记录文件开头，后来生成、改过的标题要从整个文件里找
    let customTitle = info?.customTitle;
    if (!customTitle) {
      const file = await sessionRecordFile(share.sessionId);
      if (file) customTitle = await lastCustomTitle(file);
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
