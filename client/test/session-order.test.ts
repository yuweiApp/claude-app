import assert from "node:assert/strict";
import test from "node:test";
import { emptyView, reduce, type SessionView } from "../src/state/session.ts";

const assistant = (uuid: string, model: string, text: string, stop = "end_turn", requestedModel?: string) => ({
  type: "assistant" as const,
  uuid,
  timestamp: "2026-11-29T00:00:00.000Z",
  parent_tool_use_id: null,
  message: { role: "assistant", model, content: [{ type: "text", text }], stop_reason: stop },
  ...(requestedModel ? { requestedModel } : {}),
});

function history(...messages: ReturnType<typeof assistant>[]): SessionView {
  return reduce(emptyView(), {
    type: "history",
    messages: [
      {
        type: "user",
        uuid: "user",
        timestamp: "2026-11-29T00:00:00.000Z",
        parent_tool_use_id: null,
        message: { role: "user", content: "work" },
      },
      ...messages,
    ],
  });
}

test("a model switch stays between the replies generated before and after it", () => {
  let view = history(assistant("before", "old-model", "before"));
  view = reduce(view, { type: "event", event: { type: "state", state: "running", model: "old-model" } });
  view = reduce(view, {
    type: "event",
    event: { type: "state", state: "running", model: "new-model" },
  });
  view = reduce(view, {
    type: "event",
    event: {
      type: "sdk",
      message: {
        type: "result",
        subtype: "success",
        uuid: "result",
        session_id: "session",
        duration_ms: 1000,
        total_cost_usd: 0,
        is_error: false,
        errors: [],
      } as never,
    },
  });
  assert.deepEqual(
    view.items.map((item) => item.kind),
    ["user", "assistant", "model", "result"],
  );
  assert.equal((view.items[2] as { from?: string }).from, "old-model");
  assert.equal((view.items[2] as { to?: string }).to, "new-model");
});

test("the local set-model notice does not duplicate a recorded switch", () => {
  let view = history(assistant("before", "old-model", "before"));
  view = reduce(view, { type: "event", event: { type: "state", state: "running", model: "old-model" } });
  view = reduce(view, { type: "event", event: { type: "state", state: "running", model: "new-model" } });
  view = reduce(view, {
    type: "event",
    event: {
      type: "sdk",
      message: {
        type: "user",
        uuid: "notice",
        parent_tool_use_id: null,
        message: { role: "user", content: "<local-command-stdout>Set model to new-model</local-command-stdout>" },
      } as never,
    },
  });

  assert.equal(view.items.filter((item) => item.kind === "model").length, 1);
});

test("history follows the requested model instead of a proxy-reported upstream model", () => {
  const view = history(assistant("reply", "deepseek-upstream", "answer", "end_turn", "gpt-6.2-sol"));

  assert.equal(view.items.filter((item) => item.kind === "model").length, 0);
  assert.equal(view.shownModel, "gpt-6.2-sol");
});

test("a picker selection is placed before the server confirmation arrives", () => {
  let view = history(assistant("before", "old-model", "before"));
  view = reduce(view, { type: "event", event: { type: "state", state: "idle", model: "old-model" } });
  view = reduce(view, {
    type: "model_change",
    uuid: "model-switch:pending",
    from: "old-model",
    to: "new-model",
  });

  assert.deepEqual(
    view.items.map((item) => item.kind),
    ["user", "assistant", "model"],
  );
  assert.equal(view.model, "new-model");
});

test("a failed picker selection removes its optimistic line", () => {
  let view = history(assistant("before", "old-model", "before"));
  view = reduce(view, { type: "event", event: { type: "state", state: "idle", model: "old-model" } });
  view = reduce(view, {
    type: "model_change",
    uuid: "model-switch:pending",
    from: "old-model",
    to: "new-model",
  });
  view = reduce(view, {
    type: "model_change_failed",
    uuid: "model-switch:pending",
    from: "old-model",
    to: "new-model",
    fromShownModel: "old-model",
  });

  assert.equal(view.items.filter((item) => item.kind === "model").length, 0);
  assert.equal(view.model, "old-model");
});
