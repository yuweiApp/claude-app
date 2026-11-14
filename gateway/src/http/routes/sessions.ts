import { readFile } from "node:fs/promises";
import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { listModels } from "../../agent/models.js";
import { historyForDisplay, historyImage, sessionHistory } from "../../agent/history.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorEntry, ConnectorInput, MarketPluginPage, McpAuthState, McpServerInput, MessagePriority } from "../../shared/types.js";
import { AttachmentError, type SelectedElementInput } from "../../agent/attachments.js";
import { BadRequestError, NotFoundError, type SessionManager } from "../../agent/session-manager.js";
import type { EventHub } from "../../events/event-hub.js";
import { streamSession } from "../sse.js";
import { clearCapabilitiesCache, listCapabilities } from "../../agent/capabilities.js";
import { ExtensionError, importPlugin, importSkill, readSkill, removePlugin, removeSkill, setAgentEnabled, setSkillEnabled } from "../../agent/extensions.js";
import { removeMcpServer, saveMcpServer, setMcpServerEnabled } from "../../agent/mcp-config.js";
import { addConnector, ConnectorError, listConnectors } from "../../agent/connectors.js";
import { cancelMcpAuth, clearMcpAuth, getMcpAuth, McpAuthError, startMcpAuth, submitMcpAuthCallback } from "../../agent/mcp-auth.js";
import { installMarketPlugin, PluginMarketError, queryMarketPlugins, uninstallMarketPlugin, updateMarketPlugin } from "../../agent/plugin-market.js";
import { config } from "../../config.js";
import { isRemote } from "../../ssh/location.js";

const permissionModes = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];
const effortLevels = ["low", "medium", "high", "xhigh", "max"];

const attachmentsSchema = { type: "array", items: { type: "string" }, maxItems: 20 };
/** 网页上选中的元素：网页拼好的 <selected-element> 一段文字，和截图的附件 id */
const elementsSchema = {
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    required: ["text"],
    additionalProperties: false,
    properties: { text: { type: "string", minLength: 1, maxLength: 20000 }, screenshot: { type: "string" } },
  },
};

interface IdParams {
  id: string;
}

interface TaskParams extends IdParams {
  taskId: string;
}

/** 文字、附件、网页元素至少要有一样 */
function requireContent(body: { text: string; attachments?: string[]; elements?: SelectedElementInput[] }): void {
  if (!body.text.trim() && !body.attachments?.length && !body.elements?.length) throw new AttachmentError("消息不能为空");
}

export function sessionRoutes(app: FastifyInstance, sessions: SessionManager, hub: EventHub): void {
  app.get("/sessions", async () => ({ sessions: await sessions.list() }));

  /** Claude Code 的模型列表（SDK 的 ModelInfo） */
  app.get("/models", async () => ({ models: await listModels() }));

  /** 可用的技能、插件、MCP 服务器和子代理；cwd 不传是默认工作目录，refresh=1 不用缓存 */
  app.get<{ Querystring: { cwd?: string; refresh?: string } }>("/capabilities", async (req) => {
    if (req.query.refresh === "1") clearCapabilitiesCache();
    // 远程会话不管技能、插件、连接器（网页上也不显示），按默认工作目录回答
    return listCapabilities(req.query.cwd && !isRemote(req.query.cwd) ? req.query.cwd : config.workspaceDir);
  });

  /** 技能的 SKILL.md；内置技能没有文件，返回 404。插件里的技能到插件所在的文件夹里找 */
  app.get<{ Params: { name: string }; Querystring: { cwd?: string } }>("/skills/:name", async (req) => {
    const cwd = req.query.cwd || config.workspaceDir;
    const plugin = req.params.name.includes(":") ? req.params.name.split(":")[0] : undefined;
    const pluginDir = plugin ? (await listCapabilities(cwd)).plugins.find((p) => p.name === plugin)?.path : undefined;
    const skill = await readSkill(req.params.name, cwd, pluginDir);
    if (!skill) throw new NotFoundError("这个技能没有可查看的文件");
    return skill;
  });

  /** 子代理的定义文件；内置的没有文件，返回 404。只读列表里有路径的文件 */
  app.get<{ Params: { name: string }; Querystring: { cwd?: string } }>("/agents/:name", async (req) => {
    const cwd = req.query.cwd || config.workspaceDir;
    const file = (await listCapabilities(cwd)).agents.find((a) => a.name === req.params.name)?.path;
    const content = file ? await readFile(file, "utf8").catch(() => null) : null;
    if (!file || content === null) throw new NotFoundError("这个子代理没有可查看的文件");
    return { name: req.params.name, path: file, content };
  });

  /** 启用、停用子代理（内置的也可以）。对新会话和子进程重启后的会话生效 */
  app.patch<{ Params: { name: string }; Body: { enabled: boolean } }>("/agents/:name", async (req) => {
    setAgentEnabled(req.params.name, req.body.enabled !== false);
    clearCapabilitiesCache();
    return { ok: true };
  });

  /** 导入技能、插件：path 是网关机器上的文件夹，复制到 Claude Code 配置目录 */
  app.post<{ Body: { path: string } }>("/skills/import", async (req) => {
    const name = await importing(() => importSkill(String(req.body?.path ?? "")));
    return { name };
  });

  app.post<{ Body: { path: string } }>("/plugins/import", async (req) => {
    const name = await importing(() => importPlugin(String(req.body?.path ?? "")));
    return { name };
  });

  /** 启用、停用技能（内置的也可以）。对新会话和子进程重启后的会话生效 */
  app.patch<{ Params: { name: string }; Body: { enabled: boolean } }>("/skills/:name", async (req) => {
    setSkillEnabled(req.params.name, req.body.enabled !== false);
    clearCapabilitiesCache();
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>("/skills/:name", async (req) => {
    if (!(await importing(() => removeSkill(req.params.name)))) throw new NotFoundError("只能删除导入的技能");
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>("/plugins/:name", async (req) => {
    if (!(await importing(() => removePlugin(req.params.name)))) throw new NotFoundError("只能删除导入的插件");
    return { ok: true };
  });

  /** 插件市场：config.yml 里配置的市场的插件，按搜索词、来源、分类筛过后的一页；refresh=1 先更新市场 */
  app.get<{ Querystring: { refresh?: string; search?: string; marketplace?: string; category?: string; offset?: string; limit?: string } }>(
    "/plugin-market",
    async (req): Promise<MarketPluginPage> => {
      const { refresh, search, marketplace, category, offset, limit } = req.query;
      return market(() =>
        queryMarketPlugins({
          refresh: refresh === "1",
          search,
          marketplace,
          category,
          offset: offset ? Number(offset) || 0 : undefined,
          limit: limit ? Number(limit) || undefined : undefined,
        }),
      );
    },
  );

  /** 安装、卸载、更新市场里的插件：id 是「插件名@市场名」。对新会话和子进程重启后的会话生效 */
  app.post<{ Body: { id: string } }>("/plugin-market/install", async (req) => {
    await market(() => installMarketPlugin(String(req.body?.id ?? "")));
    return { ok: true };
  });

  app.post<{ Body: { id: string } }>("/plugin-market/uninstall", async (req) => {
    await market(() => uninstallMarketPlugin(String(req.body?.id ?? "")));
    return { ok: true };
  });

  app.post<{ Body: { id: string } }>("/plugin-market/update", async (req) => {
    return { message: await market(() => updateMarketPlugin(String(req.body?.id ?? ""))) };
  });

  /** 添加 MCP 服务器，同名时覆盖。对新会话和子进程重启后的会话生效 */
  app.put<{ Params: { name: string }; Body: Omit<McpServerInput, "name"> }>("/mcp-servers/:name", async (req) => {
    const { name } = req.params;
    const { type, command, url } = req.body;
    if (!/^[\w-]+$/.test(name)) throw new BadRequestError("名称只能用字母、数字、下划线和连字符");
    if (type === "stdio" ? !command?.trim() : !/^https?:\/\//.test(url ?? "")) throw new BadRequestError(type === "stdio" ? "请填写命令" : "请填写 http 或 https 地址");
    saveMcpServer({ ...req.body, name });
    clearCapabilitiesCache();
    return { ok: true };
  });

  app.patch<{ Params: { name: string }; Body: { enabled: boolean } }>("/mcp-servers/:name", async (req) => {
    if (!setMcpServerEnabled(req.params.name, req.body.enabled)) throw new NotFoundError("MCP 服务器不存在");
    clearCapabilitiesCache();
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>("/mcp-servers/:name", async (req) => {
    if (!removeMcpServer(req.params.name)) throw new NotFoundError("MCP 服务器不存在");
    clearCapabilitiesCache();
    return { ok: true };
  });

  /** 连接器市场（MCP 官方注册表里有远程地址的服务器）：不传 search 是推荐的，传了查整个注册表，cursor 取下一页 */
  app.get<{ Querystring: { search?: string; cursor?: string } }>("/connectors", async (req): Promise<{ connectors: ConnectorEntry[]; nextCursor?: string }> => {
    return connectorCall(() => listConnectors(req.query.search, req.query.cursor));
  });

  /** 添加连接器：存成 MCP 服务器，返回它的名称；之后要登录的照常走 /mcp-servers/:name/auth */
  app.post<{ Body: ConnectorInput }>("/connectors", async (req) => {
    if (!req.body?.id) throw new BadRequestError("缺少连接器");
    const name = await connectorCall(() => addConnector(req.body));
    clearCapabilitiesCache();
    return { name };
  });

  /**
   * MCP 服务器的 OAuth 登录（设置页添加的和插件、配置文件带来的都行）：返回登录页地址，网页在浏览器里打开，之后用 GET 查进度。
   * 登录成功后开着的会话重连这个服务器
   */
  app.post<{ Params: { name: string }; Body: { cwd?: string } | undefined }>("/mcp-servers/:name/auth", async (req): Promise<McpAuthState> => {
    const { name } = req.params;
    return mcpAuth(() => startMcpAuth(name, req.body?.cwd || config.workspaceDir, () => sessions.reconnectMcpServer(name)));
  });

  app.get<{ Params: { name: string } }>("/mcp-servers/:name/auth", async (req): Promise<McpAuthState> => {
    const state = getMcpAuth(req.params.name);
    if (!state) throw new NotFoundError("没有进行中的登录");
    return state;
  });

  /** 浏览器和网关不在同一台电脑上时，登录后跳到打不开的 localhost 页面：把地址栏里的网址交上来 */
  app.post<{ Params: { name: string }; Body: { url: string } }>("/mcp-servers/:name/auth/callback", async (req): Promise<McpAuthState> => {
    if (!/^https?:\/\//.test(req.body?.url ?? "")) throw new BadRequestError("请粘贴完整的网址");
    return mcpAuth(() => submitMcpAuthCallback(req.params.name, req.body.url.trim()));
  });

  app.delete<{ Params: { name: string } }>("/mcp-servers/:name/auth", async (req) => {
    cancelMcpAuth(req.params.name);
    return { ok: true };
  });

  /** 断开：清除保存的登录令牌，返回清除后的状态；开着的会话重连这个服务器 */
  app.post<{ Params: { name: string }; Body: { cwd?: string } | undefined }>("/mcp-servers/:name/logout", async (req): Promise<{ status: string }> => {
    const { name } = req.params;
    const status = await mcpAuth(() => clearMcpAuth(name, req.body?.cwd || config.workspaceDir));
    sessions.reconnectMcpServer(name);
    return { status };
  });

  app.post<{
    Body: { text: string; cwd?: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; attachments?: string[] };
  }>(
    "/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string" },
            cwd: { type: "string" },
            model: { type: "string" },
            effort: { type: "string", enum: effortLevels },
            permissionMode: { type: "string", enum: permissionModes },
            attachments: attachmentsSchema,
          },
        },
      },
    },
    async (req) => {
      requireContent(req.body);
      const session = await sessions.create(req.body.text.trim(), req.body);
      return { sessionId: session.id };
    },
  );

  app.get<{ Params: IdParams }>("/sessions/:id", async (req) => {
    const session = sessions.get(req.params.id);
    return {
      sessionId: req.params.id,
      active: Boolean(session),
      state: session?.state ?? "closed",
      model: session?.model,
      effort: session?.effort,
      permissionMode: session?.permissionMode,
    };
  });

  app.get<{ Params: IdParams }>("/sessions/:id/messages", async (req) => ({
    messages: historyForDisplay(req.params.id, await sessions.messages(req.params.id)),
  }));

  // 历史消息里换成地址的图片（见 history.ts 的 historyForDisplay）。会话记录只会追加，同一条消息里的图片不会变
  app.get<{ Params: IdParams & { uuid: string; key: string } }>("/sessions/:id/images/:uuid/:key", async (req, reply) => {
    const image = historyImage(await sessionHistory(req.params.id), req.params.uuid, req.params.key);
    if (!image) throw new NotFoundError("图片不存在");
    return reply.type(image.mediaType).header("cache-control", "private, max-age=31536000, immutable").send(image.data);
  });

  app.post<{ Params: IdParams; Body: { text: string; attachments?: string[]; elements?: SelectedElementInput[]; priority?: MessagePriority } }>(
    "/sessions/:id/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" }, attachments: attachmentsSchema, elements: elementsSchema, priority: { type: "string", enum: ["now", "next"] } },
        },
      },
    },
    async (req) => {
      requireContent(req.body);
      return { uuid: await sessions.send(req.params.id, req.body.text.trim(), req.body.attachments, req.body.elements, req.body.priority) };
    },
  );

  app.patch<{ Params: IdParams; Body: { title: string } }>(
    "/sessions/:id",
    {
      schema: {
        body: { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1 } } },
      },
    },
    async (req) => {
      const title = req.body.title.trim();
      if (!title) throw new BadRequestError("标题不能为空");
      await sessions.rename(req.params.id, title);
      return { ok: true };
    },
  );

  /** 从某条消息分叉出一个新会话（记录到这条消息为止），返回新会话 id */
  app.post<{ Params: IdParams; Body: { messageId: string } }>(
    "/sessions/:id/fork",
    {
      schema: {
        body: { type: "object", required: ["messageId"], properties: { messageId: { type: "string", minLength: 1 } } },
      },
    },
    async (req) => ({ sessionId: await sessions.fork(req.params.id, req.body.messageId) }),
  );

  app.post<{ Params: IdParams }>("/sessions/:id/interrupt", async (req) => {
    await activeOr404(sessions, req.params.id).interrupt();
    return { ok: true };
  });

  app.post<{ Params: IdParams; Body: { mode: PermissionMode } }>(
    "/sessions/:id/permission-mode",
    {
      schema: {
        body: { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: permissionModes } } },
      },
    },
    async (req) => {
      // 子进程回收了的会话先 resume 再切
      await (await sessions.activate(req.params.id)).setPermissionMode(req.body.mode);
      return { ok: true };
    },
  );

  /** 切换模型（Query.setModel）和推理强度（Query.applyFlagSettings），只传要改的；effort 为 null 回到模型默认 */
  app.post<{ Params: IdParams; Body: { model?: string; effort?: EffortLevel | null } }>(
    "/sessions/:id/model",
    {
      schema: {
        body: {
          type: "object",
          properties: { model: { type: "string" }, effort: { type: ["string", "null"], enum: [...effortLevels, null] } },
        },
      },
    },
    async (req) => {
      // 子进程回收了的会话先 resume 再切，不用等下一条消息
      const session = await sessions.activate(req.params.id);
      if (req.body.model !== undefined) await session.setModel(req.body.model || undefined);
      if (req.body.effort !== undefined) await session.setEffort(req.body.effort);
      return { ok: true };
    },
  );

  /** 输入框上下文圆环：最后一次取到的用量 */
  app.get<{ Params: IdParams }>("/sessions/:id/context", async (req) => sessions.contextInfo(req.params.id));

  /** 压缩上下文（同 Claude Code 的 /compact） */
  app.post<{ Params: IdParams }>("/sessions/:id/compact", async (req) => {
    await sessions.compact(req.params.id);
    return { ok: true };
  });

  app.post<{
    Params: IdParams & { requestId: string };
    Body: { behavior: "allow" | "deny"; message?: string; always?: boolean; answers?: Record<string, string> };
  }>(
    "/sessions/:id/permissions/:requestId",
    {
      schema: {
        body: {
          type: "object",
          required: ["behavior"],
          properties: {
            behavior: { type: "string", enum: ["allow", "deny"] },
            message: { type: "string" },
            always: { type: "boolean" },
            // AskUserQuestion 的回答：问题原文 → 选中的选项
            answers: { type: "object", additionalProperties: { type: "string" } },
          },
        },
      },
    },
    async (req) => {
      const ok = activeOr404(sessions, req.params.id).replyPermission(req.params.requestId, req.body);
      if (!ok) throw new NotFoundError("权限请求不存在或已处理");
      return { ok: true };
    },
  );

  app.get<{ Params: IdParams }>("/sessions/:id/events", (req, reply) => {
    streamSession(req, reply, hub, req.params.id);
  });

  app.delete<{ Params: IdParams }>("/sessions/:id/process", async (req) => {
    await sessions.closeSession(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: IdParams }>("/sessions/:id/tasks", async (req) => ({ tasks: sessions.listTasks(req.params.id) }));

  app.get<{ Params: TaskParams }>("/sessions/:id/tasks/:taskId/output", async (req) =>
    sessions.taskOutput(req.params.id, req.params.taskId),
  );

  app.post<{ Params: TaskParams }>("/sessions/:id/tasks/:taskId/stop", async (req) => {
    await sessions.stopTask(req.params.id, req.params.taskId);
    return { ok: true };
  });

  /** 清掉已经结束的后台任务 */
  app.delete<{ Params: IdParams }>("/sessions/:id/tasks", async (req) => {
    sessions.clearFinishedTasks(req.params.id);
    return { ok: true };
  });

  /** 删除会话（会话记录一起删，不能恢复） */
  app.delete<{ Params: IdParams }>("/sessions/:id", async (req) => {
    await sessions.delete(req.params.id);
    return { ok: true };
  });
}

/** 导入、删除后列表要重新读；校验不通过时返回 400 */
async function importing<T>(action: () => Promise<T>): Promise<T> {
  try {
    const result = await action();
    clearCapabilitiesCache();
    return result;
  } catch (err) {
    if (err instanceof ExtensionError) throw new BadRequestError(err.message);
    throw err;
  }
}

function activeOr404(sessions: SessionManager, id: string) {
  const session = sessions.get(id);
  if (!session) throw new NotFoundError("会话不在运行");
  return session;
}

/** 插件市场失败（克隆不了、插件不存在、同名冲突等）是 400，带着 Claude Code 给的原因 */
async function market<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PluginMarketError) throw new BadRequestError(err.message);
    throw err;
  }
}

/** 登录、断开失败（服务器不支持注册客户端、回调网址不对等）是 400，带着 Claude Code 给的原因 */
async function mcpAuth<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof McpAuthError) throw new BadRequestError(err.message);
    throw err;
  }
}

/** 注册表连不上、要填的没填是 400，带着原因 */
async function connectorCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ConnectorError) throw new BadRequestError(err.message);
    throw err;
  }
}
