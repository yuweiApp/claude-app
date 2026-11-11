import type { CanUseTool, EffortLevel, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, config } from "../config.js";
import { attachmentsDir } from "./attachments.js";
import { importedPlugins } from "./extensions.js";
import { enabledMcpServers } from "./mcp-config.js";
import { TERMINAL_READ_TOOLS, TERMINAL_SERVER, terminalServer } from "../terminal/tool.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { BROWSER_SERVER, BROWSER_TOOLS, browserServer } from "../browser/tool.js";
import type { BrowserHost } from "../browser/host.js";
import { activeBrowsers, externalNote, externalServers, externalTools, fileSaver, saveFileFact } from "../browser/external.js";
import { desktopEnabled } from "../config-file.js";
import { DESKTOP_SERVER, DESKTOP_TOOLS, desktopServer } from "../desktop/tool.js";
import type { DesktopTarget } from "../shared/types.js";
import { nativePath, parseRemote } from "../ssh/location.js";
import { sshHost } from "../ssh/hosts.js";
import { remoteSpawner } from "../ssh/spawn.js";

export interface SessionLaunch {
  sessionId: string;
  /** 工作目录，也就是 Claude Code 的项目；远程会话是 ssh://<连接 id><远端路径> */
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
  /** 桌面版的内置浏览器：给模型加上浏览器工具（browser_run_code 等），只能操作这个会话自己的标签页 */
  browser?: BrowserHost;
  /** 桌面工具操作的窗口变了（发 desktop_target 事件） */
  onDesktopTarget?: (target: DesktopTarget | null) => void;
  abortController: AbortController;
  stderr: (data: string) => void;
}

/** 拼 query() 的 Options，见 docs/README.md「会话模型」「模型接入」 */
export function buildOptions(launch: SessionLaunch): Options {
  if (parseRemote(launch.cwd)) return buildRemoteOptions(launch);
  // 网页上每个会话都有右侧面板的终端，按工作目录分组：项目会话按项目文件夹，普通会话各有自己的 scratch 目录
  const terminal = launch.terminals ? terminalServer(launch.terminals, launch.cwd) : null;
  // 网页版没有内置浏览器，但会话启动时不知道之后是不是在桌面版里打开，所以都挂上；桌面版没开时调用工具返回错误
  // 外部浏览器（用户自己的 Chrome、Edge 等）：设置页「浏览器」里启用着的，每次启动会话时重新检测；第一次调用工具时才连
  const active = activeBrowsers();
  const browser = launch.browser
    ? browserServer(launch.browser, launch.sessionId, launch.resume, externalNote(active), { save: fileSaver(launch.cwd), fact: saveFileFact(launch.cwd) })
    : null;
  const external = externalServers(active, launch.sessionId, launch.cwd, launch.resume);
  // 桌面操作（agent-desktop，操作网关所在电脑上的原生应用）：config.yml 里开了才挂，默认关
  const desktop = desktopEnabled ? desktopServer(launch.sessionId, launch.onDesktopTarget) : null;
  const allowedTools = [
    ...(terminal ? TERMINAL_READ_TOOLS : []),
    // 浏览器（browser_run_code）不弹权限卡片
    ...(browser ? BROWSER_TOOLS : []),
    ...externalTools(active),
    // 桌面工具（run_code）不弹权限卡片
    ...(desktop ? DESKTOP_TOOLS : []),
  ];
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
    // WebFetch 抓网页前先问 api.anthropic.com 这个域名能不能抓，不支持的地区（如中国）一律 403，所有网址都报
    // "Unable to verify if domain … is safe to fetch"，网页本身其实能连上。跳过这一步
    settings: { skipWebFetchPreflight: true },
    mcpServers: {
      ...enabledMcpServers(),
      ...(terminal ? { [TERMINAL_SERVER]: terminal } : {}),
      ...(browser ? { [BROWSER_SERVER]: browser } : {}),
      ...external,
      ...(desktop ? { [DESKTOP_SERVER]: desktop } : {}),
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

/**
 * 远程会话（docs/README.md「SSH 远程开发」）：claude 经 SSH 在远端跑，模型请求经反向转发回网关。
 * 工具只挂浏览器（本机的内置浏览器和外部浏览器）和右侧面板的终端（远端的）；插件、技能白名单、设置页的连接器、桌面操作都不给
 */
function buildRemoteOptions(launch: SessionLaunch): Options {
  const remote = parseRemote(launch.cwd)!;
  const host = sshHost(remote.host);
  const terminal = launch.terminals ? terminalServer(launch.terminals, launch.cwd) : null;
  const active = activeBrowsers();
  const browser = launch.browser
    ? browserServer(launch.browser, launch.sessionId, launch.resume, externalNote(active), { save: fileSaver(launch.cwd), fact: saveFileFact(launch.cwd) })
    : null;
  const external = externalServers(active, launch.sessionId, launch.cwd, launch.resume);
  const allowedTools = [...(terminal ? TERMINAL_READ_TOOLS : []), ...(browser ? BROWSER_TOOLS : []), ...externalTools(active)];
  return {
    cwd: remote.path,
    // 远端的附件目录（发消息时上传到这里）
    ...(host.env ? { additionalDirectories: [nativePath(host.env.windows, host.env.attachments)] } : {}),
    // 只带 Claude Code 相关的变量过去，见 ssh/spawn.ts
    env: agentEnv(),
    spawnClaudeCodeProcess: remoteSpawner(host, launch.stderr),
    ...(launch.resume ? { resume: launch.sessionId } : { sessionId: launch.sessionId }),
    model: launch.model ?? config.model,
    ...(launch.effort ? { effort: launch.effort } : {}),
    permissionMode: launch.permissionMode,
    allowDangerouslySkipPermissions: true,
    canUseTool: launch.canUseTool,
    ...(allowedTools.length ? { allowedTools } : {}),
    disallowedTools: config.disallowedTools,
    settingSources: ["user", "project", "local"],
    settings: { skipWebFetchPreflight: true },
    mcpServers: {
      ...(terminal ? { [TERMINAL_SERVER]: terminal } : {}),
      ...(browser ? { [BROWSER_SERVER]: browser } : {}),
      ...external,
    },
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
