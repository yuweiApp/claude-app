import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { BrowserHost } from "./browser/host.js";
import { externalTabs } from "./browser/external.js";
import { browserRoutes } from "./http/routes/browsers.js";
import { desktopEnabled } from "./config-file.js";
import { listWindows, stripOwn } from "./desktop/guard.js";
import { setDesktopLog } from "./desktop/log.js";
import Fastify, { type FastifyInstance } from "fastify";
import { AttachmentError } from "./agent/attachments.js";
import { BadRequestError, BusyError, NotFoundError, SessionManager } from "./agent/session-manager.js";
import { config } from "./config.js";
import { EventHub } from "./events/event-hub.js";
import { ConversationLog } from "./logging/conversation-log.js";
import { sessionRoutes } from "./http/routes/sessions.js";
import { fileRoutes, PAGE_PREFIX } from "./http/routes/files.js";
import { terminalRoutes } from "./http/routes/terminals.js";
import { TerminalError, TerminalManager } from "./terminal/terminal-manager.js";
import { folderRoutes } from "./http/routes/folders.js";
import { uploadRoutes } from "./http/routes/uploads.js";
import { sshRoutes } from "./http/routes/ssh.js";
import { SshConfigError } from "./ssh/connections.js";
import { SshError } from "./ssh/host.js";
import { parseRemote } from "./ssh/location.js";
import { handleTunnel } from "./browser/tunnel.js";

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
  // 远程会话的工作目录在远端，内置浏览器的下载放不进去，交给桌面版按默认的下载位置存；标签页按主机分区（browser/tunnel.ts）
  const browser = new BrowserHost(async (sessionId) => {
    const cwd = await sessions.cwd(sessionId);
    const remote = cwd ? parseRemote(cwd) : null;
    return { dir: cwd && !remote ? cwd : null, remote: remote?.host ?? null };
  });
  const conversationLog = new ConversationLog(config.conversationLog, app.log);
  setDesktopLog((entry) => conversationLog.recordDesktop(entry));
  const sessions = new SessionManager(hub, app.log, conversationLog, terminals, browser);

  if (config.apiToken) {
    app.addHook("onRequest", async (req, reply) => {
      // 网页预览靠地址里的随机 id，见 http/routes/files.ts
      if (req.url === "/health" || req.url.startsWith(PAGE_PREFIX)) return;
      const header = req.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7) : (req.query as { token?: string }).token;
      if (token !== config.apiToken) await reply.code(401).send({ error: "未授权" });
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof BusyError) return reply.code(429).send({ error: err.message });
    if (err instanceof AttachmentError || err instanceof BadRequestError || err instanceof TerminalError || err instanceof SshConfigError || err instanceof SshError) {
      return reply.code(400).send({ error: err.message });
    }
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
    // 开没开桌面工具：输入框上面的「Computer Use」据此显示，不用等列窗口（list-windows 在 Windows 上要几秒）
    desktop: desktopEnabled,
  }));

  // 超过大小的文件流会被截断（file.truncated），由 saveUpload 删掉并报错
  void app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 } });
  // WebSocket 路由（终端、桌面版外壳）要在这个插件加载之后声明，所以放在各路由前面
  void app.register(websocket);

  sessionRoutes(app, sessions, hub);
  uploadRoutes(app);
  folderRoutes(app);
  fileRoutes(app);
  terminalRoutes(app, terminals);
  sshRoutes(app);

  // 启用着的外部浏览器（用户的 Chrome、Edge 等）和交给 Playwright 的标签页，输入框 @ 引用用；还没连上时 tabs 是空的
  app.get("/external/tabs", async () => ({ browsers: await externalTabs() }));
  browserRoutes(app);

  // 桌面工具（agent-desktop）能看到的窗口，输入框上面「Computer Use」引用用；本应用自己的窗口去掉
  app.get("/desktop/windows", async () => {
    if (!desktopEnabled) return { enabled: false, windows: [] };
    const windows = stripOwn(await listWindows().catch(() => [])) as Awaited<ReturnType<typeof listWindows>>;
    return { enabled: true, windows: windows.map((w) => ({ id: w.id, app: w.app_name ?? "", title: w.title ?? "" })) };
  });

  // 桌面版外壳连上来（内置浏览器），见 browser/host.ts 和 desktop/src/browser/bridge.ts
  void app.register(async (scoped) => {
    scoped.get("/browser/host", { websocket: true }, (socket) => {
      app.log.info("桌面版的内置浏览器已连上");
      browser.attach(socket);
      socket.on("close", () => app.log.info("桌面版的内置浏览器断开了"));
    });
    // 远程会话的内置浏览器访问远端 localhost 的连接，每条一个
    scoped.get<{ Querystring: { host?: string; dest?: string; port?: string } }>("/browser/tunnel", { websocket: true }, (socket, req) => handleTunnel(socket, req.query));
  });
  return { app, sessions, terminals, browser };
}
