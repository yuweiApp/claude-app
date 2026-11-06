import type { CanUseTool, EffortLevel, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, config } from "../config.js";
import { attachmentsDir } from "./attachments.js";
import { importedPlugins } from "./extensions.js";
import { enabledMcpServers } from "./mcp-config.js";
import { TERMINAL_READ_TOOLS, TERMINAL_SERVER, terminalServer } from "../terminal/tool.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { BROWSER_READ_TOOLS, BROWSER_SERVER, browserServer } from "../browser/tool.js";
import type { BrowserHost } from "../browser/host.js";
import { CHROME_READ_TOOLS, CHROME_SERVER, chromeServer } from "../browser/chrome.js";
import { externalBrowserEnabled } from "../config-file.js";

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
  /** 右侧面板的终端：给模型加上读终端、往终端里写命令的工具（终端开在会话的工作目录） */
  terminals?: TerminalManager;
  /** 桌面版的内置浏览器：给模型加上 Playwright MCP，只能操作这个会话自己的标签页 */
  browser?: BrowserHost;
  abortController: AbortController;
  stderr: (data: string) => void;
}

/** 拼 query() 的 Options，见 docs/README.md「会话模型」「模型接入」 */
export function buildOptions(launch: SessionLaunch): Options {
  // 网页上每个会话都有右侧面板的终端，按工作目录分组：项目会话按项目文件夹，普通会话各有自己的 scratch 目录
  const terminal = launch.terminals ? terminalServer(launch.terminals, launch.cwd) : null;
  // 网页版没有内置浏览器，但会话启动时不知道之后是不是在桌面版里打开，所以都挂上；桌面版没开时调用工具返回错误
  const browser = launch.browser ? browserServer(launch.browser, launch.sessionId) : null;
  // 外部浏览器（用户自己的 Chrome）：config.yml 里开了才挂，第一次调用工具时才连
  const chrome = externalBrowserEnabled ? chromeServer(launch.sessionId) : null;
  const allowedTools = [...(terminal ? TERMINAL_READ_TOOLS : []), ...(browser ? BROWSER_READ_TOOLS : []), ...(chrome ? CHROME_READ_TOOLS : [])];
  return {
    cwd: launch.cwd,
    // 附件存在 workspace/.attachments，工作目录不是 workspace 本身的会话（项目会话、普通会话的 scratch 目录）也要能不经确认读到
    ...(launch.cwd !== config.workspaceDir ? { additionalDirectories: [attachmentsDir] } : {}),
    env: agentEnv(),
    ...(launch.resume ? { resume: launch.sessionId } : { sessionId: launch.sessionId }),
    model: launch.model ?? config.model,
    ...(launch.effort ? { effort: launch.effort } : {}),
    permissionMode: launch.permissionMode,
    // 不带这个标志启动的会话，之后无法用 setPermissionMode 切到 bypassPermissions（「全部允许」）
    allowDangerouslySkipPermissions: true,
    canUseTool: launch.canUseTool,
    ...(allowedTools.length ? { allowedTools } : {}),
    disallowedTools: config.disallowedTools,
    settingSources: ["user", "project", "local"],
    mcpServers: {
      ...enabledMcpServers(),
      ...(terminal ? { [TERMINAL_SERVER]: terminal } : {}),
      ...(browser ? { [BROWSER_SERVER]: browser } : {}),
      ...(chrome ? { [CHROME_SERVER]: chrome } : {}),
    },
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
