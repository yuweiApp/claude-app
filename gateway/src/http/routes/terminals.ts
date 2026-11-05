import path from "node:path";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

const HEARTBEAT_MS = 15_000;
type IdParams = { id: string };

/** 右侧面板的终端：建、列、输出流（SSE）、输入、改大小、关 */
export function terminalRoutes(app: FastifyInstance, terminals: TerminalManager): void {
  app.get<{ Querystring: { cwd?: string } }>("/terminals", async (req) => ({ terminals: terminals.list(req.query.cwd) }));

  app.post<{ Body: { cwd: string; cols?: number; rows?: number } }>("/terminals", async (req) => {
    const { cwd, cols = 80, rows = 24 } = req.body ?? {};
    if (!cwd || !path.isAbsolute(cwd)) throw new BadRequestError("缺少项目文件夹");
    return { terminal: terminals.create(cwd, cols, rows) };
  });

  app.get<{ Params: IdParams }>("/terminals/:id/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let detach: () => void = () => undefined;
    try {
      detach = terminals.attach(req.params.id, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) })}\n\n`);
      res.end();
      return;
    }
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      detach();
    });
  });

  app.post<{ Params: IdParams; Body: { data: string } }>("/terminals/:id/input", async (req) => {
    terminals.write(req.params.id, String(req.body?.data ?? ""));
    return { ok: true };
  });

  app.post<{ Params: IdParams; Body: { cols: number; rows: number } }>("/terminals/:id/resize", async (req) => {
    terminals.resize(req.params.id, Number(req.body?.cols), Number(req.body?.rows));
    return { ok: true };
  });

  app.delete<{ Params: IdParams }>("/terminals/:id", async (req) => {
    terminals.close(req.params.id);
    return { ok: true };
  });
}
