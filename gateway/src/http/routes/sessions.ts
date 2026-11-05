import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { listModels } from "../../agent/models.js";
import type { FastifyInstance } from "fastify";
import type { McpServerInput } from "../../shared/types.js";
import { AttachmentError } from "../../agent/attachments.js";
import { BadRequestError, NotFoundError, type SessionManager } from "../../agent/session-manager.js";
import type { EventHub } from "../../events/event-hub.js";
import { streamSession } from "../sse.js";
import { clearCapabilitiesCache, listCapabilities } from "../../agent/capabilities.js";
import { ExtensionError, importPlugin, importSkill, readSkill, removePlugin, removeSkill, setSkillEnabled } from "../../agent/extensions.js";
import { removeMcpServer, saveMcpServer, setMcpServerEnabled } from "../../agent/mcp-config.js";
import { config } from "../../config.js";

const permissionModes = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];
const effortLevels = ["low", "medium", "high", "xhigh", "max"];

const attachmentsSchema = { type: "array", items: { type: "string" }, maxItems: 20 };

interface IdParams {
  id: string;
}

interface TaskParams extends IdParams {
  taskId: string;
}

/** 文字和附件至少要有一样 */
function requireContent(body: { text: string; attachments?: string[] }): void {
  if (!body.text.trim() && !body.attachments?.length) throw new AttachmentError("消息不能为空");
}

export function sessionRoutes(app: FastifyInstance, sessions: SessionManager, hub: EventHub): void {
  app.get("/sessions", async () => ({ sessions: await sessions.list() }));

  /** Claude Code 的模型列表（SDK 的 ModelInfo） */
  app.get("/models", async () => ({ models: await listModels() }));

  /** 可用的技能、插件和 MCP 服务器；cwd 不传是默认工作目录，refresh=1 不用缓存 */
  app.get<{ Querystring: { cwd?: string; refresh?: string } }>("/capabilities", async (req) => {
    if (req.query.refresh === "1") clearCapabilitiesCache();
    return listCapabilities(req.query.cwd || config.workspaceDir);
  });

  /** 技能的 SKILL.md；内置技能没有文件，返回 404 */
  app.get<{ Params: { name: string }; Querystring: { cwd?: string } }>("/skills/:name", async (req) => {
    const skill = await readSkill(req.params.name, req.query.cwd || config.workspaceDir);
    if (!skill) throw new NotFoundError("这个技能没有可查看的文件");
    return skill;
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
    messages: await sessions.messages(req.params.id),
  }));

  app.post<{ Params: IdParams; Body: { text: string; attachments?: string[] } }>(
    "/sessions/:id/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" }, attachments: attachmentsSchema },
        },
      },
    },
    async (req) => {
      requireContent(req.body);
      return { uuid: await sessions.send(req.params.id, req.body.text.trim(), req.body.attachments) };
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
      await sessions.rename(req.params.id, req.body.title);
      return { ok: true };
    },
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

  app.post<{
    Params: IdParams & { requestId: string };
    Body: { behavior: "allow" | "deny"; message?: string; always?: boolean };
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
