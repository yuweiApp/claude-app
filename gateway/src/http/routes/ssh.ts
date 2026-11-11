import type { FastifyInstance } from "fastify";
import type { SshConnectionInput } from "../../shared/types.js";
import { addConnection, getConnection, removeConnection, updateConnection } from "../../ssh/connections.js";
import { connectionInfos, dropHost, sshHost } from "../../ssh/hosts.js";
import { configHosts } from "../../ssh/ssh-config.js";
import { forgetHost } from "../../ssh/transcripts.js";

type IdParams = { id: string };

/**
 * 设置页「SSH 连接」：增删改、连接、信任主机密钥、断开。
 * 连接要几秒到几分钟（第一次要在远端装 Claude Code），POST connect 等到连上或失败才返回，期间网页轮询 GET 看进度；
 * 失败也返回 200 和连接状态（error、hostKey、needsPassword），网页按状态显示
 */
export function sshRoutes(app: FastifyInstance): void {
  app.get("/ssh/connections", async () => ({ connections: connectionInfos() }));

  /** 本机 ~/.ssh/config 里的主机（添加连接对话框的候选；它们本身也已经在连接列表里） */
  app.get("/ssh/config-hosts", async () => ({ hosts: configHosts() }));

  app.post<{ Body: Partial<SshConnectionInput> }>("/ssh/connections", async (req) => {
    const conn = addConnection(req.body ?? {});
    return { connection: sshHost(conn.id).info() };
  });

  app.patch<{ Params: IdParams; Body: Partial<SshConnectionInput> }>("/ssh/connections/:id", async (req) => {
    const before = getConnection(req.params.id);
    const conn = updateConnection(req.params.id, req.body ?? {});
    // 主机、端口、密钥换了：断开，下次按新配置连
    if (before && (before.host !== conn.host || before.port !== conn.port || before.identityFile !== conn.identityFile)) dropHost(conn.id);
    return { connection: sshHost(conn.id).info() };
  });

  /** 删连接：断开，本机的会话记录副本删掉（远端的记录不动）；~/.ssh/config 里的主机删不了（removeConnection 报错） */
  app.delete<{ Params: IdParams }>("/ssh/connections/:id", async (req) => {
    removeConnection(req.params.id);
    dropHost(req.params.id);
    await forgetHost(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: IdParams; Body: { password?: string } }>("/ssh/connections/:id/connect", async (req) => {
    const host = sshHost(req.params.id);
    const password = typeof req.body?.password === "string" ? req.body.password : undefined;
    await host.ensureReady(password).catch(() => undefined);
    return { connection: host.info() };
  });

  app.post<{ Params: IdParams; Body: { fingerprint: string } }>("/ssh/connections/:id/trust", async (req) => {
    const host = sshHost(req.params.id);
    host.trust(String(req.body?.fingerprint ?? ""));
    return { connection: host.info() };
  });

  app.post<{ Params: IdParams }>("/ssh/connections/:id/disconnect", async (req) => {
    const host = sshHost(req.params.id);
    host.disconnect();
    return { connection: host.info() };
  });
}
