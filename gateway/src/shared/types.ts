// 网关和网页共用的类型：client 通过 tsconfig paths 引用这个文件，这里只能有类型，不能依赖 Node

import type { EffortLevel, SDKMessage, SDKSessionInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type SessionState = "starting" | "idle" | "running" | "closed";

/** 发给客户端的事件，见 docs/README.md「事件类型」 */
export type GatewayEvent =
  | { type: "sdk"; message: SDKMessage }
  /**
   * 用户发的消息：content 就是交给 SDK 的 user 消息内容（文字，或 image / text 块），和会话历史里的格式一样。
   * queued：这一轮还在进行时发的（有工具在跑时按 now，否则按 next），Claude Code 先放进队列，交给模型时 SDK 发
   * command_lifecycle（state: started，command_uuid 就是这里的 uuid）。落在哪里要到那时才知道：并进这一轮（某个工具结果之后），
   * 或者这一轮结束后作为下一轮的开头（next 等这一轮自己结束；now 有时让这一轮马上结束）。在那之前这一轮剩下的回复会排在它前面
   */
  | { type: "user_message"; uuid: string; content: SDKUserMessage["message"]["content"]; queued?: boolean }
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
  /**
   * 转到后台的网关工具调用（browser_run_code 等）的结果，跟在那个任务的 task_notification 后面发：
   * SDK 的通知里只有 summary（工具名），结果原文 Claude Code 直接交给了模型，网页拿不到，失败时用它显示原因
   */
  | { type: "task_result"; taskId: string; text: string; isError: boolean }
  /** 桌面工具（agent-desktop）这个会话最近操作的窗口，变了才发；null 是关掉了那个应用（close-app） */
  | { type: "desktop_target"; target: DesktopTarget | null }
  | { type: "reset" };

/** 桌面工具操作的窗口：网页右上角的浮窗显示它，桌面版按标题找到这个窗口显示实时画面 */
export interface DesktopTarget {
  /** 应用名（list-apps 里的 name） */
  app: string;
  /** agent-desktop 的窗口 id；没在 list-windows 里找到窗口时没有（应用还没开出窗口） */
  windowId?: string;
  title?: string;
  pid?: number;
  minimized?: boolean;
}

/** 会话的后台任务（Bash 后台命令、后台子代理等），见 gateway/src/agent/tasks.ts */
export interface BackgroundTask {
  taskId: string;
  toolUseId?: string;
  /** local_bash、local_agent 等 */
  type?: string;
  description: string;
  /** Bash 任务的命令 */
  command?: string;
  /** 转到后台的 browser_run_code 的代码 */
  code?: string;
  /** 转到后台的网关工具调用（browser_run_code 等）的结果原文，太长时只留开头 */
  result?: string;
  resultIsError?: boolean;
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

/** 可用的技能和插件（GET /capabilities）。技能在消息里写 /name 使用（开头的由 Claude Code 展开），插件在消息里写 @name 引用 */
export interface Capabilities {
  /** managed：导入的，可以删除；enabled：false 时新会话里模型看不到、也调用不了；builtin：Claude Code 自带的 */
  skills: { name: string; description: string; managed: boolean; enabled: boolean; builtin: boolean }[];
  /**
   * builtin：Claude Code 自带的（source 是 名字@builtin）；marketplace：从插件市场装的（source 是 名字@市场名），卸载用 source；
   * managed：导入的或从市场装的，可以删除。description、author 取自插件的 .claude-plugin/plugin.json。
   * 插件带的技能叫「插件名:技能名」，带的 MCP 服务器叫「plugin:插件名:服务器名」
   */
  plugins: {
    name: string;
    source?: string;
    version?: string;
    description?: string;
    author?: string;
    marketplace?: string;
    managed: boolean;
    builtin: boolean;
  }[];
  mcpServers: McpServerInfo[];
}

/** GET /skills/:name：有 SKILL.md 文件的技能 */
export interface SkillDetail {
  name: string;
  path: string;
  content: string;
}

export interface McpServerInfo {
  name: string;
  enabled: boolean;
  /** 设置页添加的，可以编辑、删除、启停；其余是插件或配置文件带来的，只显示 */
  managed: boolean;
  type?: string;
  /** http / sse 的地址，或 stdio 的命令行 */
  target?: string;
  /** connected、failed、needs-auth、pending、disabled */
  status: string;
  error?: string;
  source?: string;
  /** 从连接器市场添加的：注册表里的名称、标题和图标 */
  connector?: ConnectorRef;
  tools: { name: string; description?: string }[];
}

/** 插件市场里的一个插件（GET /plugin-market）。id 是「插件名@市场名」，安装、卸载、更新都用它 */
export interface MarketPlugin {
  id: string;
  name: string;
  title?: string;
  description: string;
  marketplace: string;
  category?: string;
  author?: string;
  homepage?: string;
  version?: string;
  /** 市场给的安装次数（只有一部分市场有） */
  installCount?: number;
  installed: boolean;
}

export interface ConnectorRef {
  id: string;
  title: string;
  icon?: string;
}

/**
 * 连接器市场里的一项（GET /connectors）：MCP 官方注册表里有远程地址的服务器。
 * id 是注册表里的名称，如 com.figma.mcp/mcp；斜杠前的反向域名注册表验证过所有权（io.github.用户名 验证的是 GitHub 账号）
 */
export interface ConnectorEntry {
  id: string;
  title: string;
  description: string;
  version: string;
  type: "http" | "sse";
  /** 远程地址，可能带 {变量}，添加时填 */
  url: string;
  variables: ConnectorField[];
  /** 服务器声明的请求头（API 密钥等） */
  headers: ConnectorField[];
  icon?: string;
  website?: string;
  repository?: string;
  /** 添加时默认用的名称 */
  suggestedName: string;
  /** 已经添加了的话，是哪个 MCP 服务器 */
  added?: string;
}

export interface ConnectorField {
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  choices?: string[];
}

/** 添加连接器（POST /connectors）：name 不填用建议的名称，variables 填地址里的变量，headers 填请求头 */
export interface ConnectorInput {
  id: string;
  name?: string;
  variables?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * MCP 服务器的 OAuth 登录（POST /mcp-servers/:name/auth 开始，GET 查进度）。
 * waiting：等用户在浏览器里登录，authUrl 是登录页；done：令牌已经存好、服务器连上了；failed：error 是原因
 */
export interface McpAuthState {
  state: "waiting" | "done" | "failed";
  authUrl?: string;
  error?: string;
}

/** 添加 MCP 服务器（PUT /mcp-servers/:name）：stdio 填 command、args、env，http / sse 填 url、headers */
export interface McpServerInput {
  name: string;
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
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
/** chat：普通会话（没选文件夹，工作目录是网关建的 workspace/scratch-…，或者旧会话的 workspace 本身），列在侧边栏「会话」里；否则是项目会话 */
export type SessionListItem = SDKSessionInfo & { chat: boolean; state?: SessionState };

/** GET /files：项目里的一个文件或文件夹，path 相对项目文件夹，文件夹以 / 结尾 */
export interface ProjectEntry {
  path: string;
  dir: boolean;
  /** 右侧面板目录树里的图片文件才有：大小和修改时间（缩略图用，太大的不加载，改了换地址） */
  size?: number;
  mtimeMs?: number;
}

/** 右侧面板的终端 */
export interface TerminalInfo {
  id: string;
  cwd: string;
  /** shell 的名字（bash、zsh、powershell.exe） */
  shell: string;
  /** 标签页上的名字：模型开的终端给的标题；用户开的没有，网页按「终端 2」这样编号 */
  title?: string;
  /** 谁开的：模型开的终端它可以接着用、停止、关闭，用户开的只能读 */
  openedBy: "user" | "agent";
  /** 用户在里面敲过东西（模型就不再往里写命令） */
  userTyped: boolean;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
  /** 最近一次有输出的时间 */
  activeAt: number;
}

/** GET /terminals/:id/stream 推的事件：连上时先来一条 data 是已有的输出 */
export type TerminalEvent = { type: "data"; data: string } | { type: "exit"; code: number };

/** GET /files/read：右侧面板查看文件 */
export interface FileContent {
  path: string;
  size: number;
  /** text 带 text；image 用 /files/raw 取；binary、too-large 不显示内容 */
  kind: "text" | "image" | "binary" | "too-large";
  text?: string;
  /** 修改时间，保存时带回来，文件在这期间被改过就报冲突 */
  mtimeMs: number;
}
