// 网关和网页共用的类型：client 通过 tsconfig paths 引用这个文件，这里只能有类型，不能依赖 Node

import type { EffortLevel, SDKMessage, SDKSessionInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type SessionState = "starting" | "idle" | "running" | "closed";

/** 发给客户端的事件，见 docs/README.md「事件类型」 */
export type GatewayEvent =
  | { type: "sdk"; message: SDKMessage }
  /**
   * 用户发的消息：content 就是交给 SDK 的 user 消息内容（文字，或 image / text 块），和会话历史里的格式一样。
   * queued：这一轮还在进行时发的，priority 是实际交给 Claude Code 的 now / next，Claude Code 先放进队列，交给模型时 SDK 发
   * command_lifecycle（state: started，command_uuid 就是这里的 uuid）。落在哪里要到那时才知道：并进这一轮（某个工具结果之后），
   * 或者这一轮结束后作为下一轮的开头（next 等这一轮自己结束；now 有时让这一轮马上结束）。在那之前这一轮剩下的回复会排在它前面
   */
  | { type: "user_message"; uuid: string; content: SDKUserMessage["message"]["content"]; queued?: boolean; priority?: MessagePriority }
  /**
   * 这条用户消息开始了新的一轮（上一轮的 result 之后才交给模型）。它在记录里跟在工具结果后面，
   * 和并进上一轮的插话位置一样，网页据此分轮；这一轮结束时 result 的 user_message_uuid 也会指向它
   */
  | { type: "turn_start"; uuid: string }
  /** 以 next 排队的消息被撤回了（网页点了编辑、删除或立即发送），Claude Code 不会再处理它 */
  | { type: "user_message_cancelled"; uuid: string }
  | {
      type: "state";
      state: SessionState;
      model?: string;
      effort?: EffortLevel;
      permissionMode?: string;
      /** 有后台任务结束的通知还没交给模型：Claude Code 会拿它开始新的一轮，空闲时也算在忙 */
      noticePending?: boolean;
    }
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
  /**
   * 子进程异常结束。at：网关发出的时间（毫秒）。host：远程会话因为 SSH 连接断开而结束时是连接 id，
   * 网页在这台主机之后又连上（SshConnectionInfo.connectedAt 比 at 晚）时不再显示这条
   */
  | { type: "error"; message: string; at: number; host?: string }
  /** 网关给新会话生成了标题，列表要刷新 */
  | { type: "title"; title: string }
  /** 会话的后台任务有变化：整个列表 */
  | { type: "tasks"; tasks: BackgroundTask[] }
  /** 这个会话的模型开的终端（run_in_terminal）里有没有命令在跑，变了才发；和会话的子进程无关，空闲回收之后也照样发 */
  | { type: "terminals_running"; running: boolean }
  /**
   * 转到后台的网关工具调用（browser_run_code 等）的结果，跟在那个任务的 task_notification 后面发：
   * SDK 的通知里只有 summary（工具名），结果原文 Claude Code 直接交给了模型，网页拿不到，失败时用它显示原因
   */
  | { type: "task_result"; taskId: string; text: string; isError: boolean }
  /** 桌面工具（agent-desktop）这个会话最近操作的窗口，变了才发；null 是关掉了那个应用（close-app） */
  | { type: "desktop_target"; target: DesktopTarget | null }
  /** 上下文用量：子进程启动后、每轮结束、压缩完成后各取一次（Query.getContextUsage） */
  | { type: "context"; usage: ContextUsage }
  /** 会话的目标变了（设定、取消、一次检查没通过、达成或失败后清掉），见 GoalState */
  | { type: "goal"; goal: GoalState | null }
  /**
   * 目标达成或判定做不到了：Claude Code 写进会话记录的 goal_status（实时的消息流里没有），一轮结束时网关从记录里读出来补发。
   * uuid 是记录里那一行的，和历史消息里的（见 GoalStatusRecord）一样
   */
  | { type: "goal_status"; uuid: string; at: number; status: GoalStatusRecord }
  | { type: "reset" };

/**
 * 会话的目标（Claude Code 的 /goal）：设定一个完成条件，之后模型每次要停下时由另一个模型按条件检查会话，
 * 没达成就把理由交给模型让它接着做，达成后自动清掉
 */
export interface GoalState {
  condition: string;
  /** 设定以来没通过的检查次数（会话子进程重启过的，从会话记录里数） */
  checks: number;
  /** 最近一次没通过时检查给的理由 */
  lastReason?: string;
  /** 设定的时间（毫秒） */
  setAt?: number;
}

/**
 * Claude Code 写进会话记录的 goal_status 附件（attachment 行）：
 * sentinel 是设定（met: false）和手动取消（met: true）时写的标记；其余是一次检查的结果：没通过（met: false，带 reason）、
 * 达成（met: true）、判定做不到（failed）。
 * 历史消息里网关把没有 sentinel 的这几种转成 type 为 system 的消息，message 是 { type: "goal_status", ...GoalStatusRecord }
 */
export interface GoalStatusRecord {
  met: boolean;
  failed?: boolean;
  sentinel?: boolean;
  condition: string;
  reason?: string;
  /** 达成时：一共检查了几次 */
  iterations?: number;
}

/** 上下文用量，token 数 */
export interface ContextUsage {
  /** 已用：上一次模型回复报的用量加上之后新增的估算 */
  used: number;
  /** 模型的上下文窗口 */
  window: number;
  /** 用到这么多时自动压缩；关掉了自动压缩时 null */
  threshold: number | null;
  /** 取的时间（毫秒） */
  at: number;
  /**
   * 刚压缩过、之后模型还没回复过：used 是按压缩请求本身的用量估的，不准（比压缩前还大），
   * 下一次模型回复后才是压缩后的实际用量
   */
  compacted?: boolean;
}

/** 输入框要的会话状态：上下文圆环的用量，目标栏的目标 */
export interface SessionContextInfo {
  /** 还没取到过时 null */
  usage: ContextUsage | null;
  /** 进行中的目标，没有时 null */
  goal: GoalState | null;
}

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
  /** 转到后台的 browser_run_code 执行的脚本文件（file 参数，相对会话工作目录的路径），这时没有 code */
  file?: string;
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

/** 可用的技能、插件、MCP 服务器和子代理（GET /capabilities）。技能在消息里写 /name 使用（开头的由 Claude Code 展开），插件在消息里写 @name 引用 */
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
  /**
   * 子代理（模型用 Agent 工具调起的），包括停用的。builtin：Claude Code 自带的（没有定义文件）和内置插件带的；plugin：插件带的（名字是 插件名:…）；
   * path：定义文件（网关机器上的）；model：别名、模型 ID 或 inherit（跟主会话一样），没有时用默认的子代理模型；
   * enabled：false 时新会话里模型看不到、也调用不了
   */
  agents: { name: string; description: string; model?: string; path?: string; plugin?: string; enabled: boolean; builtin: boolean }[];
  /** 用户的子代理所在的文件夹（Claude Code 配置目录的 agents/，网关机器上的），列表时没有就建上 */
  agentsDir: string;
}

/** GET /skills/:name：有 SKILL.md 文件的技能；GET /agents/:name：有定义文件的子代理 */
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
 * 历史消息（GET /sessions/:id/messages）里图片块的 source：会话记录里的 base64 换成了网关的取图地址，
 * path 相对网关接口（同其他接口，网页加上前缀和令牌），见 gateway/src/agent/history.ts 的 historyForDisplay
 */
export interface HistoryImageSource {
  type: "gateway";
  path: string;
  media_type?: string;
}

/**
 * GET /sessions 的列表项：SDK 的 SDKSessionInfo 原样返回，只加上网关里活跃会话的运行状态（不活跃时没有 state）。
 * cwd 是会话的工作目录，Claude Code 按它区分项目（会话存在 $CLAUDE_CONFIG_DIR/projects/<编码后的目录>/ 下）
 */
/** chat：普通会话（没选文件夹，工作目录是网关建的 workspace/scratch-…，或者旧会话的 workspace 本身），列在侧边栏「会话」里；否则是项目会话 */
export type SessionListItem = SDKSessionInfo & {
  chat: boolean;
  /** Fork 源会话；侧栏据此把分支显示在源会话下 */
  forkedFromSessionId?: string;
  state?: SessionState;
  /**
   * 有后台任务（后台命令、后台子代理、转到后台的工具调用）在跑，或者任务结束的通知还没交给模型；
   * 一轮结束后 state 是 idle，任务结束的通知会再唤起新的一轮
   */
  tasksRunning?: boolean;
  /** 这个会话的模型开的终端里有命令在跑（不管子进程还在不在） */
  terminalsRunning?: boolean;
  /** 最后一次 AI 回复的时间（毫秒），列表按它倒序；还没回复过的是创建时间。不用 lastModified：打开会话也会改到记录文件 */
  lastResponseAt: number;
};

/** 文件树的上传、下载：文件在网关这台机器上的路径和项目里的路径之间直接复制，见 /files/transfers */
export interface FileTransfer {
  id: string;
  /** 项目文件夹（会话的工作目录，远程会话是 ssh://…） */
  cwd: string;
  kind: "upload" | "download";
  /** 文件名 */
  name: string;
  /** 项目里的路径（相对项目文件夹）：上传是传到的位置，下载是下载的文件 */
  path: string;
  /** 网关这台机器上的路径：上传是源文件，下载是存到的位置 */
  local: string;
  /** queued：同一个项目一次传一个，排着队 */
  state: "queued" | "running" | "done" | "error";
  /** 已经传了、一共的字节数 */
  done: number;
  total: number;
  /** 开始以来的平均速度，字节/秒 */
  speed: number;
  error?: string;
}

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
  /** 属于哪个项目（会话的工作目录），面板按它分组 */
  cwd: string;
  /** shell 起始的目录，不是 cwd 本身时才有（模型开终端时指定了工作目录里的子目录）；本机路径，远程会话是远端的 posix 路径 */
  dir?: string;
  /** shell 的名字（bash、zsh、powershell.exe） */
  shell: string;
  /** 标签页上的名字：模型开的终端给的标题；用户开的没有，网页按「终端 2」这样编号 */
  title?: string;
  /** 谁开的：模型开的终端它可以接着用、停止、关闭，用户开的只能读 */
  openedBy: "user" | "agent";
  /**
   * 属于哪个会话：面板里只显示当前会话的，模型只看得到它这个会话的（只有那个会话的模型能接着用、停止，一轮结束时自动关的也只是它自己开的）。
   * 没有的是这个改动之前用户开的终端，同项目的会话都看得到
   */
  sessionId?: string;
  /** 用户在里面敲过东西（模型就不再往里写命令） */
  userTyped: boolean;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
  /** 最近一次有输出的时间 */
  activeAt: number;
}

/** 终端的 WebSocket（GET /terminals/:id/socket）网关发的消息：连上时先来一条 data 是已有的输出；终端不存在时发 error 后断开 */
/**
 * 这一轮还在进行时发的消息怎么送到模型（POST /sessions/:id/messages 的 priority）：
 * now 马上送到（正在跑的工具调用转到后台；模型正在写文字时会打断它），next 等下一次工具结果之后（没有工具调用了就等这一轮结束）
 */
export type MessagePriority = "now" | "next";

export type TerminalEvent = { type: "data"; data: string } | { type: "exit"; code: number } | { type: "error"; message: string };

/**
 * 终端的 WebSocket 网页发的消息：输入、改大小、是不是正显示着。
 * typed：用户在网页里敲的、粘贴的；false 是 xterm 自己发的（焦点上报、对查询的回复），不算用户动过这个终端
 */
export type TerminalClientMessage =
  | { type: "input"; data: string; typed: boolean }
  | { type: "resize"; cols: number; rows: number }
  /** 这个终端现在是不是显示在面板里（面板开着、它是当前标签页）：一轮结束时用户正在看的终端不自动关 */
  | { type: "viewing"; on: boolean };

/** GET /files/read：右侧面板查看文件 */
export interface FileContent {
  path: string;
  size: number;
  /** text 带 text；image、video、audio 用 /files/raw 取；binary、too-large 不显示内容 */
  kind: "text" | "image" | "video" | "audio" | "binary" | "too-large";
  text?: string;
  /** text 的文件编码，保存时带回来按它写；gb18030 兼容 GBK、GB2312 */
  encoding?: FileEncoding;
  /** 修改时间，保存时带回来，文件在这期间被改过就报冲突 */
  mtimeMs: number;
}
export type FileEncoding = "utf-8" | "gb18030" | "utf-16le" | "utf-16be";

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
  /** 来自本机 ~/.ssh/config（自动列出，不用添加）：设置页里只能连接、断开、删除（只是不再列出），要改改那个文件 */
  fromConfig?: boolean;
  /** ~/.ssh/config 里写的地址（user@hostname:port，写了哪些显示哪些），设置页显示用 */
  address?: string;
  status: SshStatus;
  /** 连着时：这次连上（准备好）的时间（毫秒） */
  connectedAt?: number;
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

/**
 * 设置页「网络代理」（见 docs/proxy.md）：
 * - system：跟随系统。桌面版报过操作系统的代理就用它，没有（网页版、系统说直连）时沿用网关进程继承来的 HTTPS_PROXY 等环境变量（.env.local 里写的也算）
 * - off：一律直连，继承来的代理变量也不传给 claude 子进程
 * - manual：用 url 这个代理（HTTP、HTTPS、SOCKS5）
 * - subscription：订阅，网关拉起代理内核 mihomo 连订阅里的节点（见 docs/proxy-subscription.md）
 */
export type ProxyMode = "system" | "off" | "manual" | "subscription";

/** GET /proxy、PUT /proxy 返回的；不带密码明文 */
export interface ProxySettingsView {
  mode: ProxyMode;
  /** 手动模式的代理地址，http://host:port 或 https://host:port，不含用户名、密码 */
  url: string;
  username: string;
  hasPassword: boolean;
  /** 用户填的不走代理的地址 */
  noProxy: string[];
  /** 总是不走代理的本机地址，不能删 */
  fixedNoProxy: string[];
  /** 网关进程继承来的代理（跟随系统、又没有操作系统的代理时用的），没有是 null；不含用户名、密码 */
  inherited: string | null;
  /**
   * 操作系统的代理（桌面版查了报给网关的，跟随系统时优先用它）：桌面版没连着、还没报过是 null；
   * proxy 是能用的代理（http://、https://、socks5://），系统说直连是 null；unusable 是网关、Claude Code 用不了的（SOCKS4 等）
   */
  system: { proxy: string | null; unusable: string | null } | null;
  /** 现在实际用的代理，直连是 null；不含用户名、密码 */
  effective: string | null;
  /** 订阅：填没填过地址（地址本身不回给网页）、自动更新间隔（小时）、代理内核的状态 */
  subscription: { hasUrl: boolean; intervalHours: number; core: ProxyCoreStatus };
}

/** 订阅模式的代理内核 mihomo：missing 是没找到可执行文件（下载失败时 error 带原因）；downloading 是网关正在下载；error 带原因（会自动重启） */
export interface ProxyCoreStatus {
  state: "missing" | "downloading" | "stopped" | "starting" | "running" | "error";
  version?: string;
  error?: string;
}

/** GET /proxy/nodes：订阅里的节点和订阅信息 */
export interface ProxyNodes {
  /** 选的节点，null 是「自动」（选延迟最低的） */
  selected: string | null;
  /** delay：最近一次测的延迟（毫秒），没测过或不通是 null */
  nodes: { name: string; type: string; alive: boolean; delay: number | null }[];
  /**
   * 订阅信息：updatedAt 是上次拉到订阅的时间（ISO），没拉到过是 null；
   * 流量（字节）和到期时间只在订阅返回了 subscription-userinfo 时有，total、expire 为 null 是不限
   */
  subscription: { updatedAt: string | null; upload?: number; download?: number; total?: number | null; expire?: string | null };
}

/** PUT /proxy、POST /proxy/test 的请求体；password 不传是不改（测试时用已存的），空字符串是清掉 */
export interface ProxySettingsInput {
  mode: ProxyMode;
  url?: string;
  username?: string;
  password?: string;
  noProxy?: string[];
  /** 订阅地址：不传是不改，空字符串是清掉 */
  subscriptionUrl?: string;
  subscriptionInterval?: number;
}

/** POST /proxy/test：经代理（或直连）请求模型接口，收到任何 HTTP 响应都算连上了 */
export type ProxyTestResult =
  | { ok: true; target: string; via: string | null; status: number; ms: number }
  | { ok: false; target: string; via: string | null; error: string };

/** 局域网分享、公网分享（见 docs/lan-share.md）：一个会话一条，两种分享共用一个令牌 */
export interface ShareEntry {
  sessionId: string;
  token: string;
  /** ISO 时间 */
  createdAt: string;
  /** 分享到局域网（经 SHARE_PORT 的入口打开） */
  lan: boolean;
  /** 分享到公网（经设置页配置的服务器打开） */
  public: boolean;
}

/** 公网分享到服务器的 SSH 反向转发 */
export interface ShareTunnelState {
  /** off：没有公网分享、没连；starting：正在连、开端口、自检；error：没连上或断了 */
  status: "off" | "starting" | "ready" | "error";
  /** 出错时能在设置页一键修的：gatewayPorts 是服务器 sshd 的 GatewayPorts 没开，端口只开在服务器的 127.0.0.1 上 */
  fix?: "gatewayPorts";
  /** 公网地址（http://<服务器>:<端口>，不带结尾的 /），ready 时才有 */
  url: string | null;
  error: string | null;
}

/** 设置页「公网分享」：GET /share/settings（密码不回给网页，只说有没有） */
export interface ShareSettingsView {
  /** 选了 SSH 连接，或者填了服务器地址和用户名：会话菜单里才有「分享到公网」 */
  configured: boolean;
  server: {
    /** 用设置「SSH 连接」里的哪个连接（地址、账号、密钥、跳板都按它的）；空是下面手动填的 */
    connectionId: string;
    /** 服务器地址（IP 或域名），SSH 连它 */
    host: string;
    sshPort: number;
    username: string;
    hasPassword: boolean;
    /** 私钥文件的路径（选填，只存路径） */
    identityFile: string;
    /** 服务器上对外开的端口，访客连它 */
    remotePort: number;
    /** 拼链接用的地址（有域名时填），空时用 host */
    publicHost: string;
    /** 第一次连上时记下的主机密钥指纹（SHA256:…），之后不一样就不连 */
    fingerprint: string | null;
  };
  /** 现在的公网隧道 */
  tunnel: ShareTunnelState;
}

/** PUT /share/settings、POST /share/settings/test 的请求体；password 不传是沿用已存的，传空串是清除。没选连接、地址和用户名都空是不用公网分享 */
export interface ShareSettingsInput {
  /** 设置「SSH 连接」里的连接 id；空串是手动填 */
  connectionId?: string;
  host: string;
  sshPort: number;
  username: string;
  password?: string;
  identityFile: string;
  remotePort: number;
  publicHost: string;
  /** true：忘掉记下的主机密钥指纹，下次连上时重新记 */
  forgetFingerprint?: boolean;
}

/** POST /share/settings/test：连上服务器、开端口、从外面访问一次，然后断开 */
export type ShareTestResult = { ok: true; url: string; fingerprint: string } | { ok: false; error: string; fix?: ShareTunnelState["fix"] };

/** POST /share/settings/fix-gateway-ports：在服务器上开启 GatewayPorts；自动开不了时 manual 是手动执行的命令 */
export type ShareFixResult = { ok: true; message: string } | { ok: false; error: string; manual?: string };

/** GET /shares：所有分享，加上拼链接用的端口、本机的局域网地址和公网隧道 */
export interface SharesView {
  shares: ShareEntry[];
  port: number;
  addresses: string[];
  /** 设置里配置了公网分享的服务器：没配置时菜单里没有「分享到公网」 */
  publicEnabled: boolean;
  tunnel: ShareTunnelState;
}

/** GET /share/info（访客）：分享的是哪个会话 */
export interface ShareInfo {
  sessionId: string;
  /** 右侧面板的工作目录 */
  cwd: string;
  title: string | null;
  /** 普通会话（工作目录是网关建的 scratch 目录）：标题旁边不显示文件夹名 */
  chat: boolean;
}
