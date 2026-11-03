import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyInstance } from "fastify";
import { NotFoundError, type SessionManager } from "../../agent/session-manager.js";
import type { EventHub } from "../../events/event-hub.js";
import { streamSession } from "../sse.js";

const permissionModes = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

interface IdParams {
  id: string;
}

export function sessionRoutes(app: FastifyInstance, sessions: SessionManager, hub: EventHub): void {
  app.get("/sessions", async () => ({ sessions: await sessions.list() }));

  app.post<{ Body: { text: string; model?: string; permissionMode?: PermissionMode } }>(
    "/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1 },
            model: { type: "string" },
            permissionMode: { type: "string", enum: permissionModes },
          },
        },
      },
    },
    async (req) => {
      const session = await sessions.create(req.body.text, req.body);
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
      permissionMode: session?.permissionMode,
    };
  });

  app.get<{ Params: IdParams }>("/sessions/:id/messages", async (req) => ({
    messages: await sessions.messages(req.params.id),
  }));

  app.post<{ Params: IdParams; Body: { text: string } }>(
    "/sessions/:id/messages",
    {
      schema: {
        body: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } } },
      },
    },
    async (req) => ({ uuid: await sessions.send(req.params.id, req.body.text) }),
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
      await activeOr404(sessions, req.params.id).setPermissionMode(req.body.mode);
      return { ok: true };
    },
  );

  app.post<{ Params: IdParams; Body: { model?: string } }>("/sessions/:id/model", async (req) => {
    await activeOr404(sessions, req.params.id).setModel(req.body.model || undefined);
    return { ok: true };
  });

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
}

function activeOr404(sessions: SessionManager, id: string) {
  const session = sessions.get(id);
  if (!session) throw new NotFoundError("会话不在运行");
  return session;
}
