import { readFile } from "node:fs/promises";
import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { listModels } from "../../agent/models.js";
import { historyForDisplay, historyImage, sessionHistory } from "../../agent/history.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorInput, ConnectorPage, MarketPluginPage, McpAuthState, McpServerInput, MessagePriority, WidgetReport } from "../../shared/types.js";
import { reportWidget } from "../../visualize/tool.js";
import type { SelectedElementInput } from "../../agent/attachments.js";
import type { SessionManager } from "../../agent/session-manager.js";
import type { EventHub } from "../../events/event-hub.js";
import { streamSession } from "../sse.js";
import { clearCapabilitiesCache, listCapabilities } from "../../agent/capabilities.js";
import { importPlugin, importSkill, readSkill, removePlugin, removeSkill, setAgentEnabled, setSkillEnabled } from "../../agent/extensions.js";
import { removeMcpServer, saveMcpServer, setMcpServerEnabled } from "../../agent/mcp-config.js";
import { addConnector, listConnectors } from "../../agent/connectors.js";
import { cancelMcpAuth, clearMcpAuth, getMcpAuth, startMcpAuth, submitMcpAuthCallback } from "../../agent/mcp-auth.js";
import { installMarketPlugin, queryMarketPlugins, uninstallMarketPlugin, updateMarketPlugin } from "../../agent/plugin-market.js";
import { config, EFFORT_LEVELS, PERMISSION_MODES } from "../../config.js";
import { isRemote } from "../../ssh/location.js";
import type { ShareStore } from "../../share/store.js";
import { NotFoundError, BadRequestError } from "../../errors.js";


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
  if (!body.text.trim() && !body.attachments?.length && !body.elements?.length) throw new BadRequestError("消息不能为空");
}

export function sessionRoutes(app: FastifyInstance, sessions: SessionManager, hub: EventHub, shares: ShareStore): void {
  app.get("/sessions", async () => ({ sessions: await sessions.list() }));
  app.get<{ Querystring: { ids?: string } }>("/sessions/live-replies", async (req) => {
    const ids = (req.query.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return { replies: sessions.liveReplies(ids) };
  });

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
    const name = await importing(() => importSkill(req.body.path));
    return { name };
  });

  app.post<{ Body: { path: string } }>("/plugins/import", async (req) => {
    const name = await importing(() => importPlugin(req.body.path));
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
      return queryMarketPlugins({
        refresh: refresh === "1",
        search,
        marketplace,
        category,
        offset: offset ? Number(offset) || 0 : undefined,
        limit: limit ? Number(limit) || undefined : undefined,
      });
    },
  );

  /** 安装、卸载、更新市场里的插件：id 是「插件名@市场名」。对新会话和子进程重启后的会话生效 */
  app.post<{ Body: { id: string } }>("/plugin-market/install", async (req) => {
    await installMarketPlugin(req.body.id);
    return { ok: true };
  });

  app.post<{ Body: { id: string } }>("/plugin-market/uninstall", async (req) => {
    await uninstallMarketPlugin(req.body.id);
    return { ok: true };
  });

  app.post<{ Body: { id: string } }>("/plugin-market/update", async (req) => {
    return { message: await updateMarketPlugin(req.body.id) };
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

  /**
   * 连接器市场的一页。source=directory 是 Claude 目录：按 search、category 筛，offset、limit 分页，带总数和分类；
   * 不传 source 是 MCP 官方注册表：不传 search 是推荐的，传了查整个注册表，cursor 取下一页
   */
  app.get<{ Querystring: { source?: string; search?: string; cursor?: string; category?: string; offset?: string; limit?: string } }>(
    "/connectors",
    async (req): Promise<ConnectorPage> => {
      const { source, search, cursor, category, offset, limit } = req.query;
      return listConnectors({
        source: source === "directory" ? "directory" : "registry",
        search,
        cursor,
        category: category || undefined,
        offset: offset ? Number(offset) || 0 : undefined,
        limit: limit ? Number(limit) || undefined : undefined,
      });
    },
  );

  /** 添加连接器：存成 MCP 服务器，返回它的名称；之后要登录的照常走 /mcp-servers/:name/auth */
  app.post<{ Body: ConnectorInput }>("/connectors", async (req) => {
    if (!req.body?.id) throw new BadRequestError("缺少连接器");
    const name = await addConnector(req.body);
    clearCapabilitiesCache();
    return { name };
  });

  /**
   * MCP 服务器的 OAuth 登录（设置页添加的和插件、配置文件带来的都行）：返回登录页地址，网页在浏览器里打开，之后用 GET 查进度。
   * 登录成功后开着的会话重连这个服务器
   */
  app.post<{ Params: { name: string }; Body: { cwd?: string } | undefined }>("/mcp-servers/:name/auth", async (req): Promise<McpAuthState> => {
    const { name } = req.params;
    return startMcpAuth(name, req.body?.cwd || config.workspaceDir, () => sessions.reconnectMcpServer(name));
  });

  app.get<{ Params: { name: string } }>("/mcp-servers/:name/auth", async (req): Promise<McpAuthState> => {
    const state = getMcpAuth(req.params.name);
    if (!state) throw new NotFoundError("没有进行中的登录");
    return state;
  });

  /** 浏览器和网关不在同一台电脑上时，登录后跳到打不开的 localhost 页面：把地址栏里的网址交上来 */
  app.post<{ Params: { name: string }; Body: { url: string } }>("/mcp-servers/:name/auth/callback", async (req): Promise<McpAuthState> => {
    if (!/^https?:\/\//.test(req.body?.url ?? "")) throw new BadRequestError("请粘贴完整的网址");
    return submitMcpAuthCallback(req.params.name, req.body.url.trim());
  });

  app.delete<{ Params: { name: string } }>("/mcp-servers/:name/auth", async (req) => {
    cancelMcpAuth(req.params.name);
    return { ok: true };
  });

  /** 断开：清除保存的登录令牌，返回清除后的状态；开着的会话重连这个服务器 */
  app.post<{ Params: { name: string }; Body: { cwd?: string } | undefined }>("/mcp-servers/:name/logout", async (req): Promise<{ status: string }> => {
    const { name } = req.params;
    const status = await clearMcpAuth(name, req.body?.cwd || config.workspaceDir);
    sessions.reconnectMcpServer(name);
    return { status };
  });

  app.post<{
    Body: { text: string; cwd?: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; attachments?: string[]; goal?: string };
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
            effort: { type: "string", enum: EFFORT_LEVELS },
            permissionMode: { type: "string", enum: PERMISSION_MODES },
            attachments: attachmentsSchema,
            // 不发消息，一开始就设定这个目标（text 不用）
            goal: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      if (req.body.goal === undefined) requireContent(req.body);
      const session = await sessions.create(req.body.text.trim(), req.body);
      return { sessionId: session.id };
    },
  );

  /** 在项目（工作目录是 cwd）的所有会话记录里查找 q，见 SessionManager.search */
  app.get<{ Querystring: { cwd?: string; q?: string } }>("/sessions/search", async (req) => {
    const cwd = req.query.cwd;
    const q = req.query.q?.trim();
    if (!cwd) throw new BadRequestError("缺少 cwd");
    if (!q) throw new BadRequestError("查找的内容不能为空");
    if (q.length > 200) throw new BadRequestError("查找的内容太长（最多 200 个字）");
    return sessions.search(cwd, q);
  });

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

  app.post<{ Params: IdParams; Body: { text: string; attachments?: string[]; elements?: SelectedElementInput[]; priority?: MessagePriority; draft?: unknown } }>(
    "/sessions/:id/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          // draft：网页输入框的草稿，以 next 排队时网关原样存着，撤回（编辑）时还回去
          properties: { text: { type: "string" }, attachments: attachmentsSchema, elements: elementsSchema, priority: { type: "string", enum: ["now", "next"] }, draft: { type: "object" } },
        },
      },
    },
    async (req) => {
      requireContent(req.body);
      return { uuid: await sessions.send(req.params.id, req.body.text.trim(), req.body.attachments, req.body.elements, req.body.priority, req.body.draft) };
    },
  );

  app.patch<{ Params: IdParams; Body: { title: string } }>(
    "/sessions/:id",
    {
      schema: {
        body: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
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

  // 以 next 排队、还没交给模型的消息：撤回（删除，或拿回草稿编辑）、改成立即发送；已经交给模型的报 409
  app.delete<{ Params: IdParams & { uuid: string } }>("/sessions/:id/queued/:uuid", async (req) => {
    const { draft } = await activeOr404(sessions, req.params.id).withdraw(req.params.uuid);
    return { draft: draft ?? null };
  });

  app.post<{ Params: IdParams & { uuid: string } }>("/sessions/:id/queued/:uuid/send", async (req) => ({
    uuid: await activeOr404(sessions, req.params.id).sendNow(req.params.uuid),
  }));

  // 对话里的部件显示后网页报告结果（大小、加载期间的错误），交给正在等它的 show_widget 调用；局域网分享的访客也能报（同一个会话）
  app.post<{ Params: IdParams & { toolUseId: string }; Body: WidgetReport }>("/sessions/:id/widgets/:toolUseId/report", async (req) => {
    return { accepted: reportWidget(req.params.id, req.params.toolUseId, req.body) };
  });

  app.post<{ Params: IdParams }>("/sessions/:id/interrupt", async (req) => {
    await activeOr404(sessions, req.params.id).interrupt();
    return { ok: true };
  });

  app.post<{ Params: IdParams; Body: { mode: PermissionMode } }>(
    "/sessions/:id/permission-mode",
    {
      schema: {
        body: { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: PERMISSION_MODES } } },
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
          properties: { model: { type: "string" }, effort: { type: ["string", "null"], enum: [...EFFORT_LEVELS, null] } },
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

  /** 设定目标（同 Claude Code 的 /goal <条件>），已有目标的换掉；这一轮还在进行时先结束这一轮 */
  app.post<{ Params: IdParams; Body: { condition: string } }>(
    "/sessions/:id/goal",
    { schema: { body: { type: "object", required: ["condition"], properties: { condition: { type: "string" } } } } },
    async (req) => {
      await sessions.setGoal(req.params.id, req.body.condition);
      return { ok: true };
    },
  );

  /** 取消目标（/goal clear）；这一轮还在进行时先结束这一轮 */
  app.delete<{ Params: IdParams }>("/sessions/:id/goal", async (req) => {
    await sessions.clearGoal(req.params.id);
    return { ok: true };
  });

  /** 压缩上下文（同 Claude Code 的 /compact） */
  app.post<{ Params: IdParams }>("/sessions/:id/compact", async (req) => {
    await sessions.compact(req.params.id);
    return { ok: true };
  });

  /**
   * 清空会话（同 Claude Code 的 /clear）：上下文清掉，返回清空后的会话 id（Claude Code 换了新的 id，原来的记录留在原来的 id 下）。
   * 这一轮还在进行、有后台任务在跑时 409
   */
  app.post<{ Params: IdParams }>("/sessions/:id/clear", async (req) => {
    const sessionId = await sessions.clear(req.params.id);
    // 局域网分享跟到清空后的会话（见 docs/lan-share.md）
    shares.move(req.params.id, sessionId);
    return { sessionId };
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
    shares.remove(req.params.id);
    return { ok: true };
  });
}

/** 导入、删除后列表要重新读 */
async function importing<T>(action: () => Promise<T>): Promise<T> {
  const result = await action();
  clearCapabilitiesCache();
  return result;
}

function activeOr404(sessions: SessionManager, id: string) {
  const session = sessions.get(id);
  if (!session) throw new NotFoundError("会话不在运行");
  return session;
}
