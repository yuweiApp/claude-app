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

/**
 * 外部浏览器（用户自己的 Chrome、Edge、Brave 等 Chromium 内核浏览器，经 Playwright 扩展连接）的 id，
 * 也是 MCP 服务器名和引用里的来源（mcp__brave__…、@brave[标题](网址)），只有小写字母和数字。见 gateway/src/browser/external.ts
 */
export type ExternalBrowserId = string;

/** 外部浏览器的图标：Chrome、Edge 系列用各自的标志，其他的是这个颜色的圆块里写名字的首字母 */
export interface BrowserLogo {
  kind: "chrome" | "edge" | "letter";
  color?: string;
}

/** 启用着的外部浏览器（引用、图标用）；GET /external/tabs 再带上交给 Playwright 的标签页（还没连上时是空的） */
export interface ExternalBrowserInfo {
  id: ExternalBrowserId;
  /** 显示的名字，也是引用整个浏览器时 @ 后面写的：@Chrome、@Brave */
  name: string;
  logo: BrowserLogo;
}

export interface ExternalBrowserTabs extends ExternalBrowserInfo {
  tabs: { title: string; url: string }[];
}

/** 浏览器的一个配置（Default、Profile 1…）；dir 为空是没有这一层、目录本身就是配置的（Opera） */
export interface BrowserProfile {
  dir: string;
  /** 用户起的名字（Local State 里的），没有就是 dir */
  name: string;
  /** 这个配置里装了 Playwright 扩展 */
  extension: boolean;
}

/** 设置页「浏览器」里的一项：检测到的（表里的、这台电脑上装了的）和手动添加的 */
export interface BrowserEntry extends ExternalBrowserInfo {
  /** 手动添加的（可以删） */
  custom: boolean;
  executablePath: string;
  userDataDir?: string;
  /** 可执行文件还在 */
  installed: boolean;
  /** 看着是 Chromium 内核（手动添加的才可能是 false，只是提示） */
  chromium: boolean;
  profiles: BrowserProfile[];
  /** 有配置装了扩展 */
  extension: boolean;
  /** 选定的配置（dir）；没选时连接用装了扩展的、最近用过的那个 */
  profile?: string;
  /** 实际是否启用：没手动开关过时，检测到的装了扩展才启用，手动添加的默认启用 */
  enabled: boolean;
  /** 填了扩展 token（不返回 token 本身） */
  hasToken: boolean;
}

/** GET /browsers：设置页「浏览器」 */
export interface BrowserSettingsView {
  /** 连接时扩展建不建标签页组 */
  tabGroup: boolean;
  /** Playwright 扩展的安装地址 */
  installUrl: string;
  browsers: BrowserEntry[];
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
  /** 子代理（local_agent）收到的任务说明 */
  prompt?: string;
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
  /** 发起任务的工具全名（mcp__服务器__工具、Bash、Agent 等），按 tool_use_id 对上 */
  tool?: string;
  /**
   * 运行中的一行状态（task_progress 的 summary）：MCP 任务（mcp_task）是 MCP 服务器自己报的状态，
   * 子代理是模型生成的进度摘要；状态变了才更新，结束后清掉
   */
  progress?: string;
  /** MCP 任务完成时结果里按引用返回的文件（resource_link），最多 50 个 */
  resourceLinks?: { uri: string; name: string; title?: string; mimeType?: string; size?: number }[];
  /** 有输出可以看（GET /sessions/:id/tasks/:taskId/output）：后台命令的输出，子代理的对话记录 */
  hasOutput: boolean;
}

/** GET /sessions/:id/tasks/:taskId/output */
export interface TaskOutput {
  /** 后台命令是输出原文；子代理是整理成文字的对话记录（回复、工具调用和结果） */
  text: string;
  /** 只给了最后一段 */
  truncated: boolean;
  /** 子代理：对话记录里的第一条用户消息，即交给它的任务说明 */
  prompt?: string;
}

/** 可用的技能和插件（GET /capabilities）。技能在消息里写 /name 使用（开头的由 Claude Code 展开），插件在消息里写 @name 引用 */
export interface Capabilities {
  /** managed：导入的，可以删除；enabled：false 时新会话里模型看不到、也调用不了；builtin：Claude Code 自带的 */
  skills: { name: string; description: string; managed: boolean; enabled: boolean; builtin: boolean }[];
  /**
   * builtin：Claude Code 自带的（source 是 名字@builtin）；marketplace：从插件市场装的（source 是 名字@市场名），卸载用 source；
   * managed：导入的或从市场装的，可以删除。description、author 取自插件的 .claude-plugin/plugin.json。
   * 插件带的技能叫「插件名:技能名」，带的 MCP 服务器叫「plugin:插件名:服务器名」；path 是插件所在的文件夹（网关机器上的，内置插件没有）
   */
  plugins: {
    name: string;
    path?: string;
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
  /** 内置目录（anthropic-plugin-directory）里的审核情况：Anthropic 审核过、合作伙伴审核过；没有是未审核或市场不提供 */
  review?: "anthropic" | "partner";
  /** 插件代码所在的仓库（内置目录的插件大多在第三方仓库） */
  repository?: string;
  installed: boolean;
}

/** GET /plugin-market 的一页：按搜索词、来源、分类筛过之后的一段 */
export interface MarketPluginPage {
  plugins: MarketPlugin[];
  /** 筛过之后的总数 */
  total: number;
  /** 配置里的市场名称，按配置顺序（来源的选项） */
  marketplaces: string[];
  /** 当前来源里出现过的分类（分类的选项，不受搜索词和分类本身影响） */
  categories: string[];
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
/**
 * 网页上选中的元素（右侧面板的 HTML 预览、桌面版的内置浏览器），取法同 Claude 桌面版的「选择元素」（captureElementContext），
 * 在网页里取的函数见 element-context.ts
 */
export interface SelectedElement {
  /** 标签名（小写） */
  tagName: string;
  id?: string;
  classes: string[];
  /** 只取 ELEMENT_ATTRIBUTES 里有值的 */
  attributes: Record<string, string>;
  /** 只取 ELEMENT_STYLES 里有值的 */
  computedStyles: Record<string, string>;
  /** 元素文字的前 200 个字符 */
  innerText?: string;
  /** 往上最多 4 层父元素（到 body 为止），每层是 标签#id 或 标签.第一个类名，用 > 连起来 */
  parentPath?: string;
  /** 超过 2000 字符截断，末尾加 ... */
  outerHTML?: string;
  /** 同一个父元素下的所有子元素：别的只写标签、id、前 3 个类名，选中的那个前面加 <!-- SELECTED --> 写完整 HTML；超过 2000 字符截断 */
  siblingHTML?: string;
}

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
export type SessionListItem = SDKSessionInfo & {
  chat: boolean;
  state?: SessionState;
  /** 最后一次 AI 回复的时间（毫秒），列表按它倒序；还没回复过的是创建时间。不用 lastModified：打开会话也会改到记录文件 */
  lastResponseAt: number;
};

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

/** 终端的 WebSocket（GET /terminals/:id/socket）网关发的消息：连上时先来一条 data 是已有的输出；终端不存在时发 error 后断开 */
export type TerminalEvent = { type: "data"; data: string } | { type: "exit"; code: number } | { type: "error"; message: string };

/** 终端的 WebSocket 网页发的消息：输入、改大小 */
export type TerminalClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

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

/**
 * 远程会话的工作目录写成 ssh://<连接 id><远端绝对路径>（ssh://k3j9x2ab/home/me/proj），网页把它当普通的 cwd 用：
 * 分组、最近用过的文件夹、右侧面板的文件和终端都按它，网关按前缀找到 SSH 连接（gateway/src/ssh/location.ts）。
 * 这个文件只放类型，网页那边的解析在 client/src/remote.ts
 */


/** 设置页「SSH 连接」里填的，存在 Claude Code 配置目录的 gateway-ssh-connections.json */
export interface SshConnectionInput {
  /** 显示的名称 */
  name: string;
  /** user@host、host，或者 ~/.ssh/config 里的别名 */
  host: string;
  port?: number;
  /** 私钥文件的路径（只存路径，不存私钥内容） */
  identityFile?: string;
  /** 新会话浏览文件夹时先打开的远端目录，不填是远端的用户目录 */
  startDirectory?: string;
  /** 反向转发，同 ssh -R 的写法（[远端地址:]远端端口:本机地址:本机端口）：远端连这个端口，网关在本机连那个地址。~/.ssh/config 的 RemoteForward 另外照样生效 */
  remoteForwards?: string[];
}

export type SshStatus = "disconnected" | "connecting" | "deploying" | "ready" | "error";

/** GET /ssh/connections 的一项：配置加上现在的连接状态 */
export interface SshConnectionInfo extends SshConnectionInput {
  id: string;
  /** 来自本机 ~/.ssh/config（自动列出，不用添加）：设置页里只能连接、断开，要改、要删改那个文件 */
  fromConfig?: boolean;
  /** ~/.ssh/config 里写的地址（user@hostname:port，写了哪些显示哪些），设置页显示用 */
  address?: string;
  status: SshStatus;
  /** 上次连接失败的原因 */
  error?: string;
  /** 主机密钥没记录过或者变了：要用户看过指纹、点了信任才连 */
  hostKey?: { type: string; fingerprint: string; changed: boolean };
  /** 用密钥、ssh-agent 都登录不了，要输入密码（密码只在网关内存里，不落盘） */
  needsPassword?: boolean;
  /** 已经信任的主机密钥指纹（SHA256:…） */
  trustedFingerprint?: string;
  /** 正在上传 Claude Code：已传的比例（0–1） */
  progress?: number;
  /** 连上过之后记下的远端信息 */
  platform?: string;
  home?: string;
  /** 连着时的反向转发（设置页填的和 ~/.ssh/config 的 RemoteForward）：远端的地址、本机的地址，远端开不了端口时有 error */
  forwards?: { remote: string; local: string; error?: string }[];
}

/** 设置页添加连接时，从本机 ~/.ssh/config 里读出来的主机别名 */
export interface SshConfigHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
}
