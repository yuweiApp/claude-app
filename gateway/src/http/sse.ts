import type { FastifyReply, FastifyRequest } from "fastify";
import type { EventHub, StoredEvent } from "../events/event-hub.js";

const HEARTBEAT_MS = 15_000;

/**
 * 把一个会话的事件频道输出为 SSE：先回放 Last-Event-ID（或 ?since=）之后的缓冲事件，再推实时事件
 */
export function streamSession(req: FastifyRequest, reply: FastifyReply, hub: EventHub, sessionId: string): void {
  const query = req.query as { since?: string };
  const header = req.headers["last-event-id"];
  const afterId = Number.parseInt((Array.isArray(header) ? header[0] : header) ?? query.since ?? "0", 10) || 0;

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const write = (stored: StoredEvent) => {
    res.write(`id: ${stored.id}\ndata: ${JSON.stringify(stored.event)}\n\n`);
  };

  const channel = hub.channel(sessionId);
  const backlog = channel.since(afterId);
  if (backlog === null) res.write(`data: {"type":"reset"}\n\n`);
  else backlog.forEach(write);

  const unsubscribe = channel.subscribe(write);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
