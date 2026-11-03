import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { AttachmentError } from "./agent/attachments.js";
import { BusyError, NotFoundError, SessionManager } from "./agent/session-manager.js";
import { config } from "./config.js";
import { EventHub } from "./events/event-hub.js";
import { sessionRoutes } from "./http/routes/sessions.js";
import { uploadRoutes } from "./http/routes/uploads.js";

export interface App {
  app: FastifyInstance;
  sessions: SessionManager;
}

export function buildApp(): App {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      transport: process.stdout.isTTY ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } : undefined,
    },
  });
  const hub = new EventHub(config.eventBufferSize);
  const sessions = new SessionManager(hub, app.log);

  if (config.apiToken) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/health") return;
      const header = req.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7) : (req.query as { token?: string }).token;
      if (token !== config.apiToken) await reply.code(401).send({ error: "未授权" });
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof BusyError) return reply.code(429).send({ error: err.message });
    if (err instanceof AttachmentError) return reply.code(400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/config", async () => ({
    workspaceDir: config.workspaceDir,
    model: config.model ?? null,
    permissionMode: config.defaultPermissionMode,
    maxUploadMb: config.maxUploadMb,
    imageInput: config.imageInput,
  }));

  // 超过大小的文件流会被截断（file.truncated），由 saveUpload 删掉并报错
  void app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 } });

  sessionRoutes(app, sessions, hub);
  uploadRoutes(app);
  return { app, sessions };
}
