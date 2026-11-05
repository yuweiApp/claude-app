import type { CanUseTool, EffortLevel, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, config } from "../config.js";
import { attachmentsDir } from "./attachments.js";
import { importedPlugins } from "./extensions.js";
import { enabledMcpServers } from "./mcp-config.js";

export interface SessionLaunch {
  sessionId: string;
  /** 工作目录，也就是 Claude Code 的项目 */
  cwd: string;
  /** true：续接已有会话（从 jsonl 读回历史）；false：用 sessionId 新建 */
  resume: boolean;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  /** 启用的技能，不传是 Claude Code 的默认（全部） */
  skills?: string[];
  canUseTool: CanUseTool;
  abortController: AbortController;
  stderr: (data: string) => void;
}

/** 拼 query() 的 Options，见 docs/README.md「会话模型」「模型接入」 */
export function buildOptions(launch: SessionLaunch): Options {
  return {
    cwd: launch.cwd,
    // 附件存在默认工作目录下，项目里的会话也要能不经确认读到
    ...(launch.cwd !== config.workspaceDir ? { additionalDirectories: [attachmentsDir] } : {}),
    env: agentEnv(),
    ...(launch.resume ? { resume: launch.sessionId } : { sessionId: launch.sessionId }),
    model: launch.model ?? config.model,
    ...(launch.effort ? { effort: launch.effort } : {}),
    permissionMode: launch.permissionMode,
    // 不带这个标志启动的会话，之后无法用 setPermissionMode 切到 bypassPermissions（「全部允许」）
    allowDangerouslySkipPermissions: true,
    canUseTool: launch.canUseTool,
    disallowedTools: config.disallowedTools,
    settingSources: ["user", "project", "local"],
    mcpServers: enabledMcpServers(),
    plugins: importedPlugins(),
    ...(launch.skills ? { skills: launch.skills } : {}),
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
