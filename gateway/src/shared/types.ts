// 网关和网页共用的类型：client 通过 tsconfig paths 引用这个文件，这里只能有类型，不能依赖 Node

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type SessionState = "starting" | "idle" | "running" | "closed";

/** 发给客户端的事件，见 docs/README.md「事件类型」 */
export type GatewayEvent =
  | { type: "sdk"; message: SDKMessage }
  | { type: "user_message"; uuid: string; text: string }
  | { type: "state"; state: SessionState; model?: string; permissionMode?: string }
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      toolUseId: string;
      input: Record<string, unknown>;
      title?: string;
      description?: string;
      decisionReason?: string;
      canAlways: boolean;
    }
  | { type: "permission_resolved"; requestId: string; behavior: "allow" | "deny" }
  | { type: "error"; message: string }
  | { type: "reset" };

/** GET /sessions 的列表项 */
export interface SessionSummary {
  sessionId: string;
  title: string;
  lastModified: number;
  active: boolean;
  state?: SessionState;
}
