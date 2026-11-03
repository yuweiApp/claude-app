import type { CanUseTool, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, config } from "../config.js";

export interface SessionLaunch {
  sessionId: string;
  /** true：续接已有会话（从 jsonl 读回历史）；false：用 sessionId 新建 */
  resume: boolean;
  model?: string;
  permissionMode: PermissionMode;
  canUseTool: CanUseTool;
  abortController: AbortController;
  stderr: (data: string) => void;
}

/** 拼 query() 的 Options，见 docs/README.md「会话模型」「模型接入」 */
export function buildOptions(launch: SessionLaunch): Options {
  return {
    cwd: config.workspaceDir,
    env: agentEnv(),
    ...(launch.resume ? { resume: launch.sessionId } : { sessionId: launch.sessionId }),
    model: launch.model ?? config.model,
    permissionMode: launch.permissionMode,
    allowDangerouslySkipPermissions: launch.permissionMode === "bypassPermissions",
    canUseTool: launch.canUseTool,
    disallowedTools: config.disallowedTools,
    settingSources: ["user", "project", "local"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(config.appendSystemPrompt ? { append: config.appendSystemPrompt } : {}),
    },
    includePartialMessages: true,
    abortController: launch.abortController,
    stderr: launch.stderr,
  };
}
