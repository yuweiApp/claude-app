import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { BrowserHost } from "./browser/host.js";
import { chromeBridge } from "./browser/chrome.js";
import { externalBrowserEnabled } from "./config-file.js";
import Fastify, { type FastifyInstance } from "fastify";
import { AttachmentError } from "./agent/attachments.js";
import { BadRequestError, BusyError, NotFoundError, SessionManager } from "./agent/session-manager.js";
import { config } from "./config.js";
import { EventHub } from "./events/event-hub.js";
import { ConversationLog } from "./logging/conversation-log.js";
import { sessionRoutes } from "./http/routes/sessions.js";
import { fileRoutes } from "./http/routes/files.js";
import { terminalRoutes } from "./http/routes/terminals.js";
import { TerminalError, TerminalManager } from "./terminal/terminal-manager.js";
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
  terminals: TerminalManager;
  browser: BrowserHost;
}

export function buildApp(): App {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      stream: prettyStream,
      formatters: {
        // Fastify 的「request completed」里 responseTime 是原始毫秒数（8.909099999989849），保留两位小数
        log: (obj) =>
          typeof obj.responseTime === "number" ? { ...obj, responseTime: Math.round(obj.responseTime * 100) / 100 } : obj,
      },
    },
  });
  const hub = new EventHub(config.eventBufferSize);
  const terminals = new TerminalManager();
  // 桌面版问会话的工作目录（内置浏览器的下载存到那里）时用 sessions 回答，两边互相引用，所以传函数
  const browser = new BrowserHost((sessionId) => sessions.cwd(sessionId));
  const sessions = new SessionManager(hub, app.log, new ConversationLog(config.conversationLog, app.log), terminals, browser);

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
    if (err instanceof AttachmentError || err instanceof BadRequestError || err instanceof TerminalError) return reply.code(400).send({ error: err.message });
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
  fileRoutes(app);
  terminalRoutes(app, terminals);

  // 外部浏览器（用户的 Chrome）里交给 Playwright 的标签页，输入框 @ 引用用；没开或还没连上时 tabs 是空的
  app.get("/chrome/tabs", async () => ({ enabled: externalBrowserEnabled, tabs: externalBrowserEnabled ? ((await chromeBridge.tabs()) ?? []) : [] }));

  // 桌面版外壳连上来（内置浏览器），见 browser/host.ts 和 desktop/src/browser/bridge.ts
  void app.register(websocket);
  void app.register(async (scoped) => {
    scoped.get("/browser/host", { websocket: true }, (socket) => {
      app.log.info("桌面版的内置浏览器已连上");
      browser.attach(socket);
      socket.on("close", () => app.log.info("桌面版的内置浏览器断开了"));
    });
  });
  return { app, sessions, terminals, browser };
}
