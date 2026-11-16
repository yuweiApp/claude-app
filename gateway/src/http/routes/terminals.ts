import path from "node:path";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import { isRemote } from "../../ssh/location.js";
import type { TerminalClientMessage, TerminalEvent } from "../../shared/types.js";

const HEARTBEAT_MS = 15_000;
type IdParams = { id: string };

/** 右侧面板的终端：建、列、连上（WebSocket：输出、输入、改大小）、关 */
export function terminalRoutes(app: FastifyInstance, terminals: TerminalManager): void {
  // sessionId：只要这个会话的（面板按会话显示）
  app.get<{ Querystring: { cwd?: string; sessionId?: string } }>("/terminals", async (req) => ({ terminals: terminals.list(req.query.cwd, req.query.sessionId || undefined) }));

  app.post<{ Body: { cwd: string; cols?: number; rows?: number; sessionId?: string } }>("/terminals", async (req) => {
    const { cwd, cols = 80, rows = 24, sessionId } = req.body ?? {};
    if (!cwd || !(path.isAbsolute(cwd) || isRemote(cwd))) throw new BadRequestError("缺少项目文件夹");
    return { terminal: await terminals.create(cwd, cols, rows, typeof sessionId === "string" && sessionId ? { sessionId } : {}) };
  });

  // 输出、输入、改大小走一条 WebSocket：SSE 每个终端占一个 HTTP 连接，浏览器对同一个源最多 6 个，
  // 终端开多了其他请求（上传、发消息）全都排队等不到
  void app.register(async (scoped) => {
    scoped.get<{ Params: IdParams }>("/terminals/:id/socket", { websocket: true }, (socket, req) => {
      const send = (event: TerminalEvent) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(event));
      let detach: () => void;
      try {
        detach = terminals.attach(req.params.id, send);
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        socket.close();
        return;
      }
      const heartbeat = setInterval(() => socket.ping(), HEARTBEAT_MS);
      socket.on("message", (raw) => {
        let msg: TerminalClientMessage;
        try {
          msg = JSON.parse(raw.toString()) as TerminalClientMessage;
        } catch {
          return;
        }
        try {
          if (msg.type === "input" && typeof msg.data === "string") terminals.write(req.params.id, msg.data, msg.typed === true ? "user" : "emulator");
          else if (msg.type === "resize") terminals.resize(req.params.id, Number(msg.cols), Number(msg.rows));
          else if (msg.type === "viewing") terminals.setViewing(req.params.id, socket, msg.on === true);
        } catch {
          // 终端已经关了
        }
      });
      socket.on("close", () => {
        clearInterval(heartbeat);
        terminals.setViewing(req.params.id, socket, false);
        detach();
      });
    });
  });

  app.delete<{ Params: IdParams }>("/terminals/:id", async (req) => {
    await terminals.closeByUser(req.params.id);
    return { ok: true };
  });
}
