import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { AttachmentError } from "./agent/attachments.js";
import { BadRequestError, BusyError, NotFoundError, SessionManager } from "./agent/session-manager.js";
import { config } from "./config.js";
import { EventHub } from "./events/event-hub.js";
import { ConversationLog } from "./logging/conversation-log.js";
import { sessionRoutes } from "./http/routes/sessions.js";
import { folderRoutes } from "./http/routes/folders.js";
import { uploadRoutes } from "./http/routes/uploads.js";

// 终端里用 pino-pretty 格式化。不用 transport：它在 worker 线程里把 UTF-8 字节直接写 fd 1，
// 中文 Windows 控制台按 GBK 显示会乱码；交给 process.stdout 由 Node 转成 UTF-16 写控制台。
// pino-pretty 是开发依赖，只在终端里（或桌面版设了 LOG_PRETTY=1）动态加载
const prettyStream = process.stdout.isTTY || process.env.LOG_PRETTY === "1"
  ? (await import("pino-pretty")).default({ translateTime: "HH:MM:ss", destination: process.stdout })
  : undefined;

export interface App {
  app: FastifyInstance;
  sessions: SessionManager;
}

export function buildApp(): App {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      stream: prettyStream,
    },
  });
  const hub = new EventHub(config.eventBufferSize);
  const sessions = new SessionManager(hub, app.log, new ConversationLog(config.conversationLog, app.log));

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
    if (err instanceof AttachmentError || err instanceof BadRequestError) return reply.code(400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/config", async () => ({
    workspaceDir: config.workspaceDir,
    model: config.model ?? null,
    permissionMode: config.defaultPermissionMode,
    effort: config.defaultEffort,
    maxUploadMb: config.maxUploadMb,
  }));

  // 超过大小的文件流会被截断（file.truncated），由 saveUpload 删掉并报错
  void app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 } });

  sessionRoutes(app, sessions, hub);
  uploadRoutes(app);
  folderRoutes(app);
  return { app, sessions };
}
