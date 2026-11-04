// 网关和网页共用的类型：client 通过 tsconfig paths 引用这个文件，这里只能有类型，不能依赖 Node

import type { EffortLevel, SDKMessage, SDKSessionInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type SessionState = "starting" | "idle" | "running" | "closed";

/** 发给客户端的事件，见 docs/README.md「事件类型」 */
export type GatewayEvent =
  | { type: "sdk"; message: SDKMessage }
  /** 用户发的消息：content 就是交给 SDK 的 user 消息内容（文字，或 image / text 块），和会话历史里的格式一样 */
  | { type: "user_message"; uuid: string; content: SDKUserMessage["message"]["content"] }
  | { type: "state"; state: SessionState; model?: string; effort?: EffortLevel; permissionMode?: string }
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
  /** 网关给新会话生成了标题，列表要刷新 */
  | { type: "title"; title: string }
  /** 会话的后台任务有变化：整个列表 */
  | { type: "tasks"; tasks: BackgroundTask[] }
  | { type: "reset" };

/** 会话的后台任务（Bash 后台命令、后台子代理等），见 gateway/src/agent/tasks.ts */
export interface BackgroundTask {
  taskId: string;
  toolUseId?: string;
  /** local_bash、local_agent 等 */
  type?: string;
  description: string;
  /** Bash 任务的命令 */
  command?: string;
  status: "running" | "completed" | "failed" | "stopped";
  /** 网关收到开始、结束消息的时间（毫秒） */
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  /** 完成通知里的一句话说明 */
  summary?: string;
  /** 有输出文件可以看（GET /sessions/:id/tasks/:taskId/output） */
  hasOutput: boolean;
}

/** 可用的技能和插件（GET /capabilities）。技能在消息开头写 /name 使用，插件在消息里写 @name 引用 */
export interface Capabilities {
  skills: { name: string; description: string }[];
  plugins: { name: string; source?: string; version?: string }[];
}

/** 上传后的附件（POST /uploads 返回），发消息时只传 id */
export interface Attachment {
  id: string;
  name: string;
  /** 绝对路径，在工作目录的 .attachments/<id>/ 下 */
  path: string;
  size: number;
}

/**
 * GET /sessions 的列表项：SDK 的 SDKSessionInfo 原样返回，只加上网关里活跃会话的运行状态（不活跃时没有 state）。
 * cwd 是会话的工作目录，Claude Code 按它区分项目（会话存在 $CLAUDE_CONFIG_DIR/projects/<编码后的目录>/ 下）
 */
export type SessionListItem = SDKSessionInfo & { state?: SessionState };
