# 技术方案

用 Claude Agent SDK（底层是 Claude Code 引擎）做一套网页版编程助手，形态参照 Claude 桌面版的 Code 标签页和 `codex-app-server`。模型先接 newapi 里的 DeepSeek。

## 1. 总体架构

```
浏览器 (React) ──HTTP / SSE──▶ gateway (Fastify) ──进程内调用──▶ @anthropic-ai/claude-agent-sdk
                                                                     │ 每个活跃会话一个子进程
                                                                     │ stdin/stdout 收发 stream-json
                                                                     ▼
                                                               claude 二进制（Claude Code）
                                                                     │ Anthropic Messages API 格式
                                                                     ▼
                                                     ANTHROPIC_BASE_URL（newapi → DeepSeek）
```

| 层 | 职责 |
| --- | --- |
| client | 会话列表、流式对话、工具调用展示、权限确认、中断 |
| gateway | 会话生命周期、把 SDK 消息转成 SSE 事件（带断线续传）、权限请求挂起与回复、历史会话读取、鉴权；以后挂自定义工具（浏览器、终端等） |
| Agent SDK | 拉起 `claude` 子进程，提供 `query()`、`interrupt()`、`setModel()`、`setPermissionMode()`、`listSessions()`、`getSessionMessages()` 等 |
| claude 二进制 | 智能体循环、内置工具（Bash / Read / Edit / Write / Grep / Glob / WebFetch / Agent / Skill …）、上下文压缩、会话落盘、CLAUDE.md 与 settings 加载 |

和 `codex-app-server` 的对应关系：

| codex-app-server | claude-app |
| --- | --- |
| `codex app-server`（JSON-RPC，一个进程管所有 thread） | `query()`（stream-json，**一个会话一个进程**） |
| `gen:protocol` 生成的类型 | SDK 自带的 `SDKMessage` 等 TS 类型 |
| 服务端审批请求 | `canUseTool` 回调 |
| `thread/resume` | `options.resume = sessionId` |
| `$CODEX_HOME/sessions` | `$CLAUDE_CONFIG_DIR/projects/<cwd 编码>/<sessionId>.jsonl` |
| 网关注入的 MCP 工具 | `createSdkMcpServer()` 进程内 MCP，或外部 stdio / http MCP |

## 2. 会话模型

### 2.1 活跃会话

gateway 为每个"正在用"的会话持有一个 `AgentSession`：

- **输入队列**：一个 `AsyncIterable<SDKUserMessage>`，作为 `query({ prompt })` 的 prompt。用户每发一条消息就往队列里推一条，SDK 在当前一轮结束后接着处理（流式输入模式）。这样中途追加、打断、切模型都在同一个进程里完成，不用每轮重启。
- **消费循环**：`for await (const msg of query)`，每条 `SDKMessage` 都包成事件发到这个会话的事件频道。
- **状态**：`starting` → `idle` / `running` → `closed`。收到用户消息置 `running`，收到 `result` 置 `idle`。
- **空闲回收**：`idle` 超过 `SESSION_IDLE_MS`（默认 30 分钟）就 `close()`，子进程退出。下次再发消息时用 `resume` 重新拉起，对话历史从 jsonl 读回，用户无感。resume 时传上回收前用着的模型和推理强度（不传的话 Claude Code 用默认模型，切换过的模型就丢了）；网关重启过、没记着的，模型按记录文件里最后一条主线程 `assistant` 行的 `message.model`，网页在会话没有 `state` 事件时也按历史推出的这个模型显示。

新会话由 gateway 生成 UUID 作为 `options.sessionId` 传给 SDK，所以创建接口能马上返回会话 id，不用等 `system/init`。

### 2.2 历史会话

不另建数据库，直接用 SDK 读 Claude Code 落盘的 jsonl，返回给网页的也是 SDK 的数据格式：

- 列表：`listSessions()`（不传 dir，所有工作目录），`GET /sessions` 原样返回 `SDKSessionInfo`，只加上活跃会话的 `state`
- 消息：`getSessionMessages(id)`（`SessionMessage`）
- 改名：`renameSession(id, title)`
- 技能和插件：输入框上面的「技能」「插件」选择后插在光标处（前后补空格），可以有多个，只列导入的和项目里的，Claude Code 自带的（技能的 `builtin`、插件 source 为 `名字@builtin`）不列，设置页里照常显示。技能写成 `/技能名`：在消息开头的由 Claude Code 展开成技能内容，在中间的只是文字，模型自己决定调不调 Skill 工具；插件写成 `@插件名`，只是文字引用，Claude Code 没有对应的命令。输入框和消息里，开头的 `/名字` 都高亮，中间的要在技能列表里才高亮。用技能的消息在历史里是 `<command-message>` 标签加一条技能内容，网页还原成 `/技能名 内容`，技能内容不显示。
- 引用文件：有项目文件夹时，输入框里打 `@` 弹出项目里的文件、文件夹，选中写成 `@相对路径`（带空格的加引号 `@"a b.txt"`），和 Claude Code 命令行的 @ 引用一样交给 SDK。输入框里只列文件，插件用上面的「插件」按钮；也没有 `/` 命令菜单，技能用「技能」按钮。候选来自网关 `GET /files?cwd=&q=`：`q` 为空列第一层，以 `/` 结尾列那个文件夹，否则在整个项目里按名字搜（git 仓库用 `git ls-files` 按 `.gitignore` 过滤，列表缓存 10 秒）。技能名、插件和文件引用在输入框里高亮，删除、移动光标都按一个整体。
- 右侧面板：对话标题栏右边有开关（开没开全局记住），面板有标签页，新标签页里选「文件」或「终端」（xterm.js，按需加载），桌面版的新标签页顶部还有浏览器的地址栏（见第 12 节「内置浏览器」）；面板开在会话的工作目录：项目会话是项目文件夹，普通会话（没选文件夹）是它自己的 scratch 目录（见下面「会话」），都有「文件」和「终端」；旧的普通会话（工作目录就是 `WORKSPACE_DIR`）的文件树列的是整个 workspace。新会话页还没有工作目录（scratch 目录建会话时才有），开关置灰，发出第一条消息、会话出现在列表里之后才能用，所以终端、浏览器标签页不用从新会话页转给新会话。文件工具同 codex-app-server：一个标签里左边目录树（顶部「筛选文件…」在整个项目里搜，可以收起、拖动调宽；第一行是工作目录本身，可以收起展开）、右边内容；目录树右键：空白处和第一行新建文件（默认「新建文本文档.txt」，新建完直接打开）、新建文件夹，文件夹还能在里面新建，文件和文件夹能重命名（F2）、删除（Delete，先确认，永久删除），名字在行内输入框里改；文件、文件夹可以拖到别的文件夹（拖到文件上是放进它所在的文件夹，拖到空白处或第一行是放到根目录，悬停在收起的文件夹上 600ms 自动展开）；改名、挪动后开着的文件标签跟着换路径（没保存的修改也跟过去），删掉的文件的标签关掉，正在看的那个变回「打开文件」；单击文件预览打开（标签名斜体，再单击别的文件换掉它），双击文件或标签固定；文本打开就能编辑，Ctrl+S 保存（不自动保存，没保存的标签显示圆点，关闭时问），文件被外面改过时保存报冲突，可以放弃或覆盖；Markdown 默认所见即所得（`MarkdownLiveEditor`，从 codex-app-server 移植，CodeMirror）：编辑的是源码，只是把 Markdown 符号藏起来、按渲染效果显示，整个元素选中时才露出符号，任务列表的复选框可以直接点，项目里的文件链接在面板里打开，「预览 / 源代码」开关切到带行号的源代码编辑；HTML 显示成网页（沙箱 iframe，没有开关，见下面「网页标注」）；文件、文件夹图标用 Material Icon Theme（`material-icon-theme`，图标按需加载），输入框 @ 的候选也用它。目录树里的图片（png、jpg、gif、webp、bmp、svg，5 MB 以内）显示 16px 的缩略图，`/files/list` 给图片带上大小和修改时间，修改时间放进地址里，图片改了缩略图跟着变，读不出来退回类型图标。Claude 回复里的链接（`ReplyMarkdown`）：指向工作目录里文件的（绝对路径、`file://`、相对工作目录的路径，Windows 路径不分大小写、反斜杠原样保留；react-markdown 默认会把 `file:` 和 `C:\` 当成不认识的协议清空）点了打开面板、在文件标签里预览打开（面板只能看工作目录里的文件，`/files/*` 不能跳出项目，工作目录外的点了没反应、悬停说明原因），网址在新窗口打开。行内代码像文件路径（带扩展名，可以带 `:行号`，`index.html`、`src/a.ts:12`、绝对路径）时，网页用 `POST /files/exists` 批量问网关是不是工作目录里存在的文件，是就同样显示成文件链接，只改显示，消息内容不变；代码块里的不处理；存在的一直记着，不存在的 5 秒后再问。标签页按文件夹分开存在内存里；终端进程在网关上，跟网页断开无关，刷新页面后按 `GET /terminals?cwd=` 补回标签页，关标签页才结束。
- 模型用终端（参照 Claude 桌面版的终端工具）：每个会话（操作它工作目录那一组终端），网关给 SDK 加一个进程内 MCP 服务器 `terminal`（`gateway/src/terminal/tool.ts`，`createSdkMcpServer`），工具有 `read_terminal`（读屏幕上的文字：清屏之前的丢掉，去掉控制序列，回车、退格按覆盖处理；可以先等新输出）、`list_terminal_tabs`、`run_in_terminal`（敲一行命令并回车；不传 tab_id 开新终端，title 是标签页名字）、`stop_terminal_tab`（Ctrl-C 或关闭）。读的两个在 `allowedTools` 里不用确认，写命令、停止走权限卡片（「完全访问权限」下直接执行）。模型只能往它自己开的、用户没敲过、回到了提示符的终端里写命令，只能停止、关闭它自己开的；前台在跑什么用 node-pty 的 `process`（Unix 上是 tcgetpgrp，Windows 上拿不到）。面板每 2 秒对一次 `GET /terminals?cwd=`：模型开的终端补成标签页（不抢当前标签），关掉的去掉。
- 导入技能和插件：技能文件夹要有 `SKILL.md`，复制到 `$CLAUDE_CONFIG_DIR/skills/<名称>/`，Claude Code 自己发现；插件文件夹要有 `.claude-plugin/plugin.json`，复制到 `$CLAUDE_CONFIG_DIR/gateway-plugins/<名称>/`，通过 `options.plugins` 加载，它的技能叫 `插件名:技能名`。桌面版用系统对话框选文件夹，网页用 `GET /folders` 浏览。
- 插件详情：设置页「插件」点一个插件进详情（同 Claude 桌面版），显示 `plugin.json` 里的描述和作者（`GET /capabilities` 按 SDK 返回的插件 `path` 读），下面分「技能」「连接器」两个标签。插件和它带的东西不另外记对应关系，按名称认：技能是 `插件名:技能名`，MCP 服务器是 `plugin:插件名:服务器名`。技能的启停、查看和连接器的登录、查看工具和「技能」「连接器」页里的一样。
- 插件市场（`gateway/src/agent/plugin-market.ts`、`client/src/components/PluginDirectory.tsx`）：设置页「插件」第三个标签「插件市场」。整个交给 SDK 自带的 Claude Code 命令行做（`claude plugin …`，`CLAUDE_CONFIG_DIR` 是网关的配置目录，可执行文件和 SDK 一样按平台包名 `@anthropic-ai/claude-agent-sdk-<平台>-<架构>` 找），网关不自己解析插件来源、不自己拉代码。
  - 市场在 `config.yml` 的 `plugins.marketplaces`，每项是 git 仓库地址或 Claude Code 内置市场的名称，默认两个：Anthropic 官方的 `claude-plugins-official`（三百多个）和 Claude Code 内置的 `anthropic-plugin-directory`（三千六百多个）。
    - git 市场：`.claude-plugin/marketplace.json` 列出插件，第一次打开目录时没加过的先 `marketplace add`（克隆到 `plugins/marketplaces/` 下，记进 `settings.json` 的 `extraKnownMarketplaces`）。要写完整的 https 地址：`owner/repo` 简写 Claude Code 用 SSH 克隆，没配 SSH 密钥就失败。
    - 内置目录：不在 `marketplace list` 里、不用 `add`，列表、安装、更新照常用名称；数据由 Claude Code 从网上取，缓存在配置目录的 `plugins/plugin-directory-cache-v2.json`。不需要 Claude 订阅或 API key：实测没有任何凭据时也能列出、安装，接 OpenAI 中转的会话照常加载装上的插件。插件代码大多在第三方 GitHub 仓库，装的时候要能访问 GitHub；四百多个经过审核（Anthropic 或合作伙伴），其余未审核。
  - 列表用 `plugin list --available --json`，只留配置里的市场。git 市场从 `marketplace.json` 补分类、作者、主页，有安装次数；内置目录从上面的缓存文件补显示名称、发布者、文档链接、审核情况（Claude Code 内部的文件，读不到就只显示命令行给的），没有安装次数和分类。两个市场有两百多个同名插件，同名的只留一个（已经装了的那个，都没装用配置里排在前面的市场的），两个同名插件不能同时装。按配置里市场的顺序排，同一个市场里有安装次数的按次数，内置目录保持 Claude Code 给的顺序。完整列表在网关里缓存 10 分钟（Claude Code 一次给出全部，取一次要几秒），设置页「刷新」先 `marketplace update`（git 拉取，内置目录重新取）。接口按搜索词、来源、分类筛过后只返回一页（`offset`、`limit`，最多 100 条），带总数、来源和分类的选项；网页按卡片网格显示（从左往右排、放不下换行），底部是页码分页（`client/src/components/Pager.tsx`，连接器市场共用）。每页的个数在第一次显示时按设置页的可见区域算：先渲染一批卡片，绘制前量出列数和最高的卡片，取列数 × 不出滚动条能放下的行数（至少一行，最多 60），之后固定不变（`useFitPageSize`），翻页、换条件时再取，搜索词停 300ms 再查。每项显示来源市场、审核情况和代码仓库链接。
  - 安装、卸载、更新是 `plugin install / uninstall / update <插件名@市场名> --json`（不加 `-y`：要执行市场声明的命令的插件会失败并报原因）。插件按来源（市场仓库里的目录、别的 git 仓库或其中的子目录）拉到 `plugins/cache/` 下，记进 `settings.json` 的 `enabledPlugins`，会话按 `settingSources` 的 `user` 加载，对新会话和子进程重启后的会话生效。插件来源是 git 仓库的要有 git（Windows 上 Claude Code 本来就要 Git for Windows）。
  - 能力列表里插件的 source 是 `插件名@市场名` 的算从市场装的（`marketplace` 字段），列表和详情里「删除」换成「卸载」，详情多一个「检查更新」，显示 Claude Code 的说明。已经手动导入了同名插件的不让装（两个同名插件的技能、MCP 服务器名称冲突），目录里显示「已导入」。
- 停用技能：停用的名称存在 `$CLAUDE_CONFIG_DIR/gateway-disabled-skills.json`。有停用的技能时，网关把其余技能作为 `options.skills` 白名单传给 SDK，模型看不到停用的技能，调 Skill 工具也会被拒绝；这个白名单管不到用户自己输入的 `/技能名`，所以网关在新建和发送时再拦一次，返回 400。白名单在拉起 claude 进程时确定，已经活跃的会话要等进程重启才更新，`/技能名` 的拦截立即生效。内置技能只能停用；删除只针对导入的技能，是删文件，SDK 没有对应接口。
- MCP 服务器：设置页添加的存在 `$CLAUDE_CONFIG_DIR/gateway-mcp-servers.json`（权限 600，请求头和环境变量可能有令牌），启用的通过 `options.mcpServers` 传给会话，对新会话和子进程重启后的会话生效。插件或配置文件带来的服务器只显示，不能在设置页改。
- 连接器（`gateway/src/agent/connectors.ts`、`client/src/components/ConnectorDirectory.tsx`）：设置页原来的「MCP」改叫「连接器」，分「已添加」和「连接器市场」两个标签。连接器市场的数据来自 MCP 官方注册表（`config.yml` 的 `connectors.registry`，默认 `https://registry.modelcontextprotocol.io`），只列有远程地址（streamable-http 优先，其次 SSE）的服务器，删除了的不列。
  - 注册表很大（2 万多条，不少是批量发布的杂项），所以不搜索时只列 `connectors.featured` 里推荐的（按名称逐个取最新版本，缓存 1 小时，取不到的跳过）；搜索时查整个注册表（`version=latest`，网关一页 100 条，缓存 5 分钟），推荐的和名称主体就是搜索词的排在前面。网页按卡片网格显示，每页个数同插件市场按可见区域算，翻到已经取回来的最后一页再往后时取注册表的下一页（还有没取的时，最后一个页码后面多一个省略号）。
  - 名称是反向域名（`com.figma.mcp/mcp`），注册表验证过所有权：`com.figma` 验证域名，`io.github.用户名` 验证 GitHub 账号，所以列表里显示完整名称和地址，看得出是不是官方的。没写 title 的，标题用斜杠后面那段，那段只是 mcp 的用名称主体（`com.notion/mcp` → Notion）。
  - 添加（`POST /connectors`）由网关按名称再取一次注册表，填好地址变量和请求头，存成设置页的 MCP 服务器（`gateway-mcp-servers.json` 里多记一个 `connector`：注册表名称、标题、图标），之后的连接、登录、启停、删除和手动添加的一样。默认名称是名称主体（figma、linear），`io.github.*` 的用标题；被别的服务器占了加 `-2`。有请求头或地址变量的先弹表单（可选的请求头不填就不带），没有的直接添加；添加后直接打开登录对话框，不用登录的连上就自动关掉。
  - 目录里地址和已有服务器相同的（插件带来的、手动添加的）显示「已添加」，免得重复；已添加但要登录的显示「登录」。
- MCP 服务器的 OAuth 登录（`gateway/src/agent/mcp-auth.ts`）：状态是「需要认证」的服务器（设置页添加的、插件和配置文件带来的都算）在设置页有「登录」。登录整个由 Claude Code 自己做：发现授权服务器、动态注册客户端、PKCE、在 localhost 的随机端口上等回调、换令牌、存令牌（Linux / Windows 是 `$CLAUDE_CONFIG_DIR/.credentials.json` 的 `mcpOAuth`，按「服务器名称|配置的哈希」存；macOS 是钥匙串）、过期刷新。同一个配置目录下的会话共用令牌，所以登录一次，之后的新会话直接连上。
  - 网关起一个和会话同样配置的临时 query（`inspectQuery`），发 `mcp_authenticate` 控制请求拿到登录页地址给网页；query 留着等回调（端口在它的子进程里），每秒查一次 `mcpServerStatus()`，服务器变成 connected 就算成功，10 分钟没完成就结束。成功后开着的会话都 `reconnectMcpServer()`，不用等子进程重启。
  - SDK 的 `Query` 上有 `mcpAuthenticate`、`mcpSubmitOAuthCallbackUrl`、`mcpClearAuth`，但类型定义里没写（0.3.317），网关按运行时有没有这两个方法判断，没有就报「不支持」。升级 SDK 后要重新跑一遍登录。
  - 断开（`POST /mcp-servers/:name/logout`）：连上的远程（HTTP / SSE）服务器在设置页有「断开」，确认后起临时 query 调 `mcpClearAuth` 清掉 Claude Code 存的令牌，再重连一次，返回清除后的状态，开着的会话也重连这个服务器。服务器的状态里看不出是不是靠登录连上的，所以远程服务器都有这个按钮；不是靠登录连上的（不要认证、令牌写在请求头里），清除后仍是已连接，网页提示「没有保存的登录信息」。
  - 网页在浏览器里打开登录页（桌面版的 `window.open` 由外壳交给系统浏览器）。浏览器和网关在同一台电脑上时，登录后跳回 localhost 由 Claude Code 收下；不在同一台电脑上时跳到打不开的 localhost 页面，对话框里可以把地址栏的网址贴回来，网关经 `mcp_oauth_callback_url` 交给 Claude Code。贴回来的回调 Claude Code 不会自己重连服务器（localhost 收到的会），网关接着调 `reconnectMcpServer()`。
  - 服务器的授权服务器不让注册客户端时（没有注册接口、或者拒绝），Claude Code 报 `mcp_client_registration_unavailable`，原因原样显示在对话框里。
- 标题：新会话发出第一条消息时，网关直接请求模型接口概括成简短标题（`gateway/src/agent/title.ts`，失败时取提问第一行），用 `renameSession()` 写成自定义标题，之后不再变。网页显示 `customTitle`，没有时用 `firstPrompt`；`summary` 没有自定义标题时跟着最新一条提问变，不用它。SDK 列会话只读记录文件开头和结尾各 64 KB 找 `customTitle`：标题那一行在文件开头之后，网页快照、工具结果把文件撑大，它就不在结尾那段里了；Claude Code 过一阵才把标题等元数据补写到末尾（实测 Windows 上 1.5 MB 的会话，标题在第 107 KB 处，一轮结束、网页刷新列表时还没补写，显示成第一条提问，之后才补上）。网关设的标题 Claude Code 不一定补写（实测 Windows 上 718 KB 的会话，标题在第 125 KB，一直没补写，网关重启后显示成第一条提问）。所以网关记住每个会话的标题（`SessionManager.titles`：生成、改名时，从记录文件里找到时），列表里优先用记住的（SDK 读到的可能是开头那段里改名前的旧标题）；没记着、SDK 也读不到时（网关重启过），从整个记录文件里找最后一行 `custom-title`（`gateway/src/agent/session-records.ts`，按文件大小和修改时间缓存）再记下。不往记录文件末尾补写标题：补写会改文件修改时间。

### 2.3 项目（文件夹）

和 Claude 桌面版 Code 标签页一致：**项目就是会话的文件夹（工作目录）**，没有单独的项目列表。Claude Code 按工作目录存会话（`$CLAUDE_CONFIG_DIR/projects/<编码后的目录>/`），`SDKSessionInfo.cwd` 就是会话所在的文件夹；桌面版自己的会话记录（`claude-code-sessions/…/local_<id>.json`）里也只记 `cwd`。

- 侧边栏「会话」按文件夹分组（桌面版的 Group by › Project），组名取目录最后一级，悬停有「在 {文件夹} 中新建会话」。没选文件夹的会话同 Claude 桌面版的 scratch-workspaces：新建时网关在 `WORKSPACE_DIR` 下建一个 `scratch-日期-随机串` 目录作为它的工作目录（`gateway/src/agent/scratch.ts`），AI 下载、写的文件各归各的。`WORKSPACE_DIR` 默认在用户数据目录（Windows `%LOCALAPPDATA%`、macOS `~/Library/Application Support`、Linux `~/.local/share`）的 `claude-app/workspace`：以前默认是 `gateway/.data/workspace`，在 git 仓库里，Claude Code 会把仓库的 git 状态和最近的提交放进系统提示（实测普通会话的模型看到了 claude-app 的提交记录）；也不放临时目录，系统会清理，AI 产出的文件会丢，resume 时工作目录没了子进程起不来；会话列表的 `chat` 标记它是普通会话（工作目录是 scratch 目录，或者旧会话的 `WORKSPACE_DIR` 本身），侧边栏按它分「会话」和「项目」。删会话时 scratch 目录是空的就一起删，有文件就留着。Claude Code 的会话记录按工作目录放在 `projects/<目录名>/` 下，所以每个普通会话的记录也各在一个文件夹里，列表用不带 `dir` 的 `listSessions()` 全部读出来。列表（项目按组里最新的会话）按最后一次 AI 回复的时间排，侧边栏显示的也是这个时间：网关从记录文件末尾往前找最后一条 `assistant` 行的 `timestamp`（`gateway/src/agent/session-records.ts`，最多往前读 4 MB，按文件大小和修改时间缓存），没回复过的用创建时间。不用 SDK 给的 `lastModified`（文件修改时间）：子进程退出时（空闲回收、网关重启）Claude Code 会往末尾补写 `last-prompt`、`cost-state` 等元数据，只是会话被回收，修改时间就变了，顺序会乱跳。
- 新会话在输入框上面一栏「选择文件夹」（桌面版的 Choose a folder，样式同 codex-app-server 新聊天页）：最近用过的文件夹，或「选择文件夹…」打开对话框浏览网关这台机器上的文件夹（`GET /folders`）。
- `POST /sessions` 带 `cwd`（必须是已存在的目录，支持 `~`），子进程在这个目录里跑；续接会话时用 `getSessionInfo(id).cwd` 找回原来的目录。
- 附件存在 `WORKSPACE_DIR/.attachments`，工作目录不是 `WORKSPACE_DIR` 本身的会话（项目会话、普通会话的 scratch 目录）启动时用 `additionalDirectories` 把附件目录加进来，读附件不用确认。

### 2.4 配置隔离

Claude Code 默认读写 `~/.claude`。gateway 通过 `env.CLAUDE_CONFIG_DIR` 指到 `gateway/.data/claude-home`，和本机自己用的 Claude Code / 桌面版完全分开：会话记录、settings、skills、memory 都在这个目录里。多人部署时每个用户容器各一个目录。

`settingSources` 用 `['user', 'project', 'local']`：user 指的就是上面隔离出来的目录；project / local 让工作目录里的 `CLAUDE.md`、`.claude/settings.json` 生效。

## 3. 事件流（SSE）

### 3.1 频道与续传

- 每个会话一个频道，环形缓冲最近 `EVENT_BUFFER_SIZE`（默认 5000）条事件，事件 id 在频道内单调递增。
- `GET /sessions/:id/events`：首次连接回放整个缓冲；断线重连时浏览器自动带 `Last-Event-ID`，只回放之后的事件。缓冲已经被覆盖时先发一条 `reset`，客户端重新拉历史。
- 每 15 秒发一次注释行心跳，防止代理断开空闲连接。

### 3.2 事件类型

| type | 数据 | 说明 |
| --- | --- | --- |
| `sdk` | `SDKMessage` 原样 | assistant / user（工具结果）/ stream_event（增量）/ result / system 等，客户端自己归并 |
| `user_message` | `{ uuid, content, queued? }` | 用户发的消息（gateway 推进队列时发出，SDK 默认不回显用户输入）；`queued`：这一轮还在进行时发的（有工具在跑时按 `now`，否则按 `next`），Claude Code 放进队列，交给模型时发 `command_lifecycle` 的 `started` |
| `state` | `{ state, model?, permissionMode? }` | 会话状态变化 |
| `permission_request` | `{ requestId, toolName, input, title?, description?, decisionReason? }` | `canUseTool` 挂起的权限请求 |
| `permission_resolved` | `{ requestId, behavior }` | 已回复或超时、取消 |
| `error` | `{ message }` | 子进程异常退出等 |
| `tasks` | `{ tasks: BackgroundTask[] }` | 会话的后台任务有变化，整个列表（见下面「后台任务」） |
| `task_result` | `{ taskId, text, isError }` | 转到后台的网关工具调用（`browser_run_code` 等）的结果原文，跟在那个任务的 `task_notification` 后面发。SDK 的通知里只有 `summary`（工具名）和 `tool_use_id`，结果 Claude Code 直接交给了模型；网关的工具按 Claude Code 调用时放在 `_meta["claudecode/toolUseId"]` 里的 id 记下自己返回的结果（`takeToolResult`），对上后补发。网页在失败时把原因（第一行）显示在「后台任务失败」下面，悬停看全文；历史里的 `<task-notification>` 带 `<result>`（以 `Task failed: ` 开头），也从那里取 |
| `desktop_target` | `{ target: { app, windowId?, title?, pid?, minimized? } \| null }` | 桌面工具（`mcp__desktop__…`）这个会话最近操作的窗口，变了才发（`gateway/src/desktop/guard.ts` 的 `noteTarget`）；`null` 是 `close-app` 关掉了它。网页在对话区右上角浮着显示，点开后桌面版按窗口标题找到采集源显示实时画面，见 [agent-desktop.md](agent-desktop.md) 第 10 节 |
| `reset` | — | 续传点已不在缓冲里 |

SDK 消息原样转发，不在 gateway 里做第二套协议。原因：SDK 类型比较全，转一遍只会丢字段；客户端可以直接 `import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'`。

### 3.3 客户端归并规则

- 打开会话：先连 SSE，再拉 `GET /sessions/:id/messages` 的历史，两边按 `uuid` 去重合并。
- 排队的用户消息（`user_message` 带 `queued`）：模型在写文字、或在等权限确认时发的消息不能用 `now`（会打断写到一半的回答），用 `next`（同 Claude 桌面版：实测不打断，写到一半的 952 字回答照常写完）。Claude Code 先放进队列，下一次工具结果之后并进这一轮（同一个 result），这一轮不再调用工具的话等它结束、作为下一轮的开头；有工具在跑时用 `now`，不排队（见第 12 节「跑久了自动转后台」）。以前用 `later`，要等整轮结束才送到。交给模型时 SDK 发 `command_lifecycle`（SDK 的类型定义里没有）：`command_uuid` 是消息的 uuid，`state` 依次是 `queued`、`started`（交给模型了）、`completed`。有工具在跑时用 `now` 发的也一样等 `started`（网关这时也标 `queued`）：`now` 有时并进这一轮，有时先结束这一轮（`result` 的 `stop_reason` 是 `tool_use`）再用它开新的一轮，实测两种都有；以前当它一定并进这一轮，结果上一轮的 `result` 挂到了它这一段上（显示「用时 0s」），之后并进来的后台任务通知被当成新一轮的开头，它自己那一轮的用时也没了。分轮时 `result` 的 `user_message_uuid` 指向的用户消息算一轮的开头，不算插入的一段（历史里它也紧跟在工具结果后面，光看位置分不出来）。网页收到排队的消息时不放进消息列表，先像普通消息一样显示在对话最后，这一轮剩下的回复排在它上面；收到它的 `started` 再放进消息列表，位置就固定了（并进这一轮的，显示上在那个工具结果后面分段，同进行中插入的消息）；`result`、状态变成 `idle` / `closed` 时还没放的也放进去，兜底。以前收到就放进去，这一轮剩下的回复排在它后面、被算进它那一轮，「用时」也从发消息时算起。并进这一轮的消息在会话文件里存成 `queued_command` 附件，`getSessionMessages` 读回来是同一个 uuid 的普通用户消息，位置和实时的一样；拉历史时已经在历史里的不再排队。
- `stream_event` 只用来拼"正在生成"的那段文字；收到对应的完整 `assistant` 消息后丢掉临时内容。模型的思考（`thinking` 块）不显示。
- 工具调用：`assistant` 里的 `tool_use` 块和随后 `user` 消息里同 `tool_use_id` 的 `tool_result` 配对显示。
- `parent_tool_use_id` 不为空的是子代理里的消息，折叠在对应的 Agent 工具调用下面。
- 后台任务（会话标题后面的按钮，点开是弹窗）：网关按会话记后台任务（`gateway/src/agent/tasks.ts`）。SDK 的 `task_started` / `task_updated` / `task_notification` 里没有时间，开始、结束时间按网关收到的时间记；命令取自对应的 Bash `tool_use`，输出文件路径取自放到后台时立即返回的 `tool_result`（运行中就能看输出）或完成通知。只列放到后台的任务，`ambient`、`skip_transcript` 的不列。是不是后台任务看 `task_started` 的 `is_backgrounded`，或者在不在最近一条 `background_tasks_changed`（SDK 说是当前所有在跑的后台任务的完整列表）里：转到后台的 MCP 调用（`mcp_task`，如 `browser_run_code` 跑满 20 秒）的 `task_started` 不带 `is_backgrounded`，只靠后者认出来，它比 `task_started` 先到。开始时间按对应的 `tool_use` 发出的时间算（跑久了才转后台的，不按转后台的时候）。任务记录跟会话走，子进程空闲回收后还在，会话删除或网关重启时丢掉；子进程退出时还在运行的任务记为已停止。
- 后台任务（Bash 后台命令、后台子代理）完成时，如果模型空闲，Claude Code 会拿通知自动开始新的一轮，没有用户消息。历史里这条通知存成内容是 `<task-notification>` 的 user 消息；实时事件里只有 `system/task_notification`，之后网关的状态从 `idle` 变回 `running`。网页把两者都显示成一行「后台任务已完成：…」作为新一轮的开头，按 `task:<task_id>` 去重。一轮还在进行时完成的任务，Claude Code 会把通知并进当前这一轮（只有一个 result；历史里这条通知夹在这一轮中间，前一条 assistant 的 `stop_reason` 是 `tool_use`），这种不分轮、对话里也不显示：历史里按 `stop_reason` 判断，实时按收到通知后这一轮里有没有再发出模型请求（`status: requesting`）判断；通知到时已经在路上的请求不带它，响应回来后通知还会开新的一轮。

## 4. 权限

- `permissionMode` 默认 `bypassPermissions`（完全访问，`DEFAULT_PERMISSION_MODE` 可改），可选 `acceptEdits`、`plan`、`bypassPermissions`（需要 `allowDangerouslySkipPermissions`）。运行中通过 `query.setPermissionMode()` 切换。
- 需要确认时 SDK 调 `canUseTool(toolName, input, { signal, suggestions, title, description, decisionReason })`。gateway 生成 `requestId`，发 `permission_request` 事件，返回一个 Promise 挂起，等 `POST /sessions/:id/permissions/:requestId` 回复：
  - 允许：`{ behavior: 'allow', updatedInput: input }`；勾"以后都允许"时带上 `updatedPermissions: suggestions`
  - 拒绝：`{ behavior: 'deny', message }`
- `signal` 中止（用户打断）或超过 `PERMISSION_TIMEOUT_MS`（默认 10 分钟）时自动拒绝，并发 `permission_resolved`。
- `AskUserQuestion` 也走 `canUseTool`（「完全访问权限」下也走），入参里是 1–4 道题，每道题有 `question`、`header`、2–4 个选项（`label`、`description`、可能有 `preview`）和 `multiSelect`。网页把它渲染成选择题卡片（`PermissionCard.tsx` 的 `QuestionCard`）：单选或多选，另有「其他」可以自己写，选了带 `preview` 的选项时显示它；「提交」把回答放在回复的 `answers` 里（问题原文 → 选中的选项 `label`，按选项的顺序；多选用 `, ` 连接；「其他」是用户写的文字），网关放进 `updatedInput.answers` 交还 Claude Code，模型读到的就是这些；「跳过」是拒绝这次调用。不给「总是允许」。以前没有单独处理，卡片上只有原始 JSON 和「允许 / 拒绝」，点「允许」交回的没有回答。

## 5. 附件

1. 网页选文件、拖入或粘贴后立刻 `POST /uploads`（multipart，可多个），网关存到 `<工作目录>/.attachments/<id>/<文件名>`，返回 `{ id, name, path, size }`。单个文件上限 `MAX_UPLOAD_MB`（默认 20）。
2. 发消息时只传附件 id（`attachments: string[]`），网关按 id 找回文件，拼成用户消息。结构同 Claude 桌面版（它的会话 jsonl 里用户发的图片就是这样存的）：

   ```
   [image] png / jpeg / gif / webp 且不超过 5 MB 的图片，base64，放在最前面
   [text]  用户输入的文字（可以为空）
   [text]  <attachments>
           用户上传了以下文件，已保存在这些路径，需要时用 Read 工具读取：
           - /…/.attachments/<id>/report.pdf
           </attachments>          （只有非图片文件时才有）
   ```

3. 图片模型直接看到；其他文件模型按需用 Read 读取（在工作目录里，不用确认）。
4. `user_message` 事件带的就是这份 `content`，和 `getSessionMessages()` 读回的历史格式一样：网页从 image 块直接显示缩略图，从 `<attachments>` 段还原文件附件。

模型要能看图；接纯文本模型（如 DeepSeek 文本模型）时不要发图片。

**回复注释**（参照 codex-app-server，`client/src/components/ResponseAnnotations.tsx`）：在 Claude 的回复里选中文字，浮出「回复」，写一句回复（可以不写）后加进输入框里的「N 条注释」，原文末尾显示编号，点编号或列表里的「编辑」可以改、删。注释按会话存在 localStorage，随下一条消息发出后清空；发送时纯在网页拼进用户文字的末尾（放末尾是因为 `/技能` 要在消息开头），网关不感知：

```
用户输入的文字

# Response annotations:
（一句说明）
<response-annotations>
[{"text":"所选文本","annotation":"回复","source":{"messageId":"<消息 uuid>:<块序号>","startOffset":0,"endOffset":10}}]
</response-annotations>
```

网页解析用户消息时把这一段拆出来，显示成消息上方的「N 条注释」，点开一条按 `source` 滚回原文并闪一下。

**网页标注**（参照 codex-app-server 的浏览器批注）：右侧面板里的 HTML 文件显示成网页，地址是 `/files/page/<id>/<相对路径>`（先用 `GET /files/page-url?cwd=&path=` 取；`id` 是网关给项目文件夹的随机串，只在内存里，网关重启后失效），网页里的相对路径照常解析。这个路由不走令牌鉴权，只能读那个项目文件夹里的文件；响应带 CSP `sandbox allow-scripts …`（不给 allow-same-origin），iframe 也加同样的 sandbox，网页和界面同源但被放进单独的源，脚本碰不到界面的 localStorage 和接口。网关在 HTML 末尾接上一段脚本（`gateway/src/http/page-picker.ts`），和界面互相 `postMessage`：标题栏的「标注」打开标注模式后，网页里的点击被拦下，点到的元素框出来，界面上在它旁边打开和回复注释同一个编辑框写要怎么改，✓ 后加进同一个「N 条注释」（可以不写，空着也能加）；已有的标注在元素上显示编号，点编号修改。发出去的格式是同一段 `<response-annotations>`，网页标注的条目没有 `source`，带 `page`（`file` 相对工作目录、`selector`、`tag`、点的位置 `point` 和视口大小 `viewport`），`text` 是元素的 aria-label、alt、文字等。

附件目录不自动清理，跟着工作目录走。

## 6. 模型接入（newapi / DeepSeek）

Claude Code 只说 Anthropic Messages API（`POST /v1/messages`）。接 DeepSeek 有两条路，都只是改环境变量：

1. **newapi 的 Claude 格式接口**：`ANTHROPIC_BASE_URL=https://<newapi 域名>`，`ANTHROPIC_AUTH_TOKEN=<newapi 令牌>`。newapi 把 Claude 格式请求转成上游渠道的格式，渠道配 DeepSeek。
2. **DeepSeek 官方的 Anthropic 兼容接口**：`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`。

模型：

- `ANTHROPIC_MODEL`：默认模型（如 `gpt-6-luna`），新会话用它。
- 模型菜单读接口的 `GET /v1/models`（`GET /models` 缓存 5 分钟），按 codex-app-server 的规则去掉图片、视频、语音、向量、3D 等不是对话的模型，`MODELS_FILTER` 正则可以再筛；默认模型排第一。切换用 `Query.setModel(<模型 id>)`。
- Claude Code 的 opus / sonnet / haiku 档位（后台生成标题、WebFetch 总结、Explore 子代理用 haiku）默认会请求 `claude-*` 模型，第三方接口里没有。网关启动 claude 子进程时把 `ANTHROPIC_DEFAULT_OPUS_MODEL` / `SONNET` / `HAIKU` 都设成默认模型，配置文件里不用写。
- 没配 `ANTHROPIC_BASE_URL`（直连 Anthropic）时，模型菜单用 Claude Code 自己的列表（`Query.supportedModels()`）。

另外：

- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`：关掉遥测、错误上报、自动更新检查，不往 Anthropic 发东西。
- `WebSearch` 是 Anthropic 服务端工具，第三方模型用不了，默认放进 `disallowedTools`。
- `WebFetch` 每次抓网页前会先请求 `api.anthropic.com/api/web/domain_info?domain=<域名>` 查域名黑名单，Anthropic 不支持的地区（如中国）这个接口一律返回 403，所有网址都报 "Unable to verify if domain … is safe to fetch"，网页本身其实能连上。网关在 SDK 的 `settings` 选项里设 `skipWebFetchPreflight: true` 跳过这一步。
- Windows 上命令输出的编码：Claude Code 的 Bash 工具跑的是 Git Bash，模型在里面调 `powershell.exe`、`ipconfig` 等原生程序时，它们按控制台代码页输出（中文系统是 936，GBK），Claude Code 按 UTF-8 读，中文全是乱码。`agentEnv()` 在 Windows 上给子进程设 `BASH_ENV`，指向网关写在 `$CLAUDE_CONFIG_DIR/claude-app-bash-env.sh` 的脚本，每次起 bash 先 `chcp.com 65001`；环境里原来有 `BASH_ENV` 的放进 `CLAUDE_APP_USER_BASH_ENV`，脚本最后接着 source 它。Claude Code 自己的 PowerShell 工具（`CLAUDE_CODE_USE_POWERSHELL_TOOL=1`，预览）也是先 `chcp 65001` 再起 PowerShell。
- 追加的系统提示（`APPEND_SYSTEM_PROMPT`，经 `systemPrompt.append` 接在 Claude Code 的提示词后面）：网关代码里没有默认值，不设或设成空串就不追加；`.env.example` 里写了一句，要求调用工具前用一句话说明要做什么、做事过程中有重要发现或改变方向时说一句：SDK 会话拿到的 Claude Code 提示词是精简版（截过实际请求，约 5800 字），没有完整版里「Before your first tool call, say in a sentence what you're about to do」那段；Claude 模型不说也会边做边说，GPT 类模型（`gpt-6-luna`）不被要求就一句不说，工具调用之间没有文字（两台机器统计 119 次带工具调用的响应，一次都没有）。加上后新会话里会先说一句再调用工具；老会话里前面几十轮都没说，模型多半照着历史继续不说。Codex 的提示词里也有同样的要求（Preamble messages）。
- 兼容性需要实测：工具调用格式、`thinking` 块、prompt caching 字段、并行工具调用。不兼容时优先在 newapi 侧修，其次关掉对应特性（如 `MAX_THINKING_TOKENS=0`）。

## 7. HTTP 接口（第一版）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 网关状态 |
| GET | `/config` | 工作目录、默认模型、默认权限模式、默认推理强度（`DEFAULT_EFFORT`，默认 high）、上传大小上限 |
| GET | `/models` | 可选的模型（SDK 的 `ModelInfo` 格式）：接 newapi 时是它 `/v1/models` 里的对话模型，直连 Anthropic 时是 `Query.supportedModels()`；缓存 5 分钟 |
| GET | `/sessions` | 所有文件夹的会话，SDK 的 `SDKSessionInfo` 加活跃会话的 `state`、最后一次 AI 回复的时间 `lastResponseAt`，按 `lastResponseAt` 倒序 |
| POST | `/sessions` | 新建会话并发送第一条消息 `{ text, attachments?, cwd?, model?, effort?, permissionMode? }` → `{ sessionId }`；`cwd` 是会话的文件夹，`model` 是模型列表里的 value |
| GET | `/sessions/:id/messages` | 历史消息 |
| POST | `/sessions/:id/messages` | 发送消息 `{ text, attachments? }`（文字和附件至少有一样）；会话不活跃时自动 resume |
| POST | `/uploads` | 上传附件（multipart，可多个）→ `{ attachments: [{ id, name, path, size }] }` |
| GET | `/folders?path=` | 网关机器上一个文件夹里的子文件夹 `{ path, parent, home, entries }`，不传 path 是主目录，支持 `~` |
| GET | `/files?cwd=&q=` | 输入框 @ 引用文件的候选，见上面「引用文件」 |
| GET | `/files/list?cwd=&path=` | 右侧面板文件树：项目里一个文件夹的直接子项（`path` 相对项目文件夹，空是根，不能跳出项目） |
| GET | `/files/read?cwd=&path=` | 右侧面板查看文件：`{ kind: text \| image \| binary \| too-large, text?, mtimeMs }`，文本最大 2 MB，前 8 KB 有 0 字节算二进制 |
| POST | `/files/write` | 右侧面板保存文件 `{ cwd, path, text, mtimeMs, force? }`：`mtimeMs` 和磁盘上的对不上（打开之后被改过）返回 409，`force` 覆盖 |
| POST | `/files/create` | 文件树新建 `{ cwd, path, dir? }`：空文件或文件夹，已经有同名的报错 |
| POST | `/files/delete` | 文件树删除 `{ cwd, path }`：文件夹连同里面的一起删 |
| POST | `/files/rename` | 文件树重命名、拖动 `{ cwd, from, to }`：目标已存在不覆盖（大小写不敏感的文件系统上只改大小写可以），文件夹不能挪进自己里面 |
| GET | `/files/raw?cwd=&path=` | 图片原文件（只允许图片类型，带禁脚本的 CSP） |
| GET | `/terminals?cwd=` | 右侧面板的终端列表（刷新页面后把还开着的补成标签页） |
| POST | `/terminals` | 开终端 `{ cwd, cols, rows }`：网关机器上的 pty（`@lydell/node-pty`，带各平台预编译包），shell 是 `$SHELL`，Windows 是 PowerShell |
| GET | `/terminals/:id/stream` | 终端输出（SSE）：连上先给保留的输出（最多 512K 字符）还原屏幕，之后实时推 `data`、`exit` |
| POST | `/terminals/:id/input`、`/terminals/:id/resize` | 输入 `{ data }`（网页按顺序发，前一个回来才发下一个）、改大小 `{ cols, rows }` |
| DELETE | `/terminals/:id` | 关终端（关标签页时）；网关退出时全部结束 |
| GET（WebSocket） | `/browser/host` | 桌面版外壳连上来，转发各会话 Playwright 的 CDP 消息（见第 12 节） |
| GET | `/chrome/tabs` | 外部浏览器（用户的 Chrome）里交给 Playwright 的标签页，输入框 @ 引用用（见第 13 节） |
| POST | `/sessions/:id/interrupt` | 打断当前一轮 |
| POST | `/sessions/:id/permission-mode` | `{ mode }` |
| POST | `/sessions/:id/model` | `{ model?, effort? }` 切换模型（`Query.setModel`）和推理强度（`Query.applyFlagSettings({ effortLevel })`）；子进程回收了的会话先 resume |
| POST | `/sessions/:id/permissions/:requestId` | `{ behavior: 'allow' \| 'deny', message?, always? }` |
| GET | `/sessions/:id/events` | SSE |
| DELETE | `/sessions/:id/process` | 关闭活跃进程（不删记录） |
| DELETE | `/sessions/:id` | 删除会话：先关进程，再用 `deleteSession()` 删会话记录（jsonl 和子代理记录），不能恢复。侧边栏「项目」「会话」标题行的「…」菜单里「全部删除」逐个调用（「项目」删的是所有项目下的会话，不动文件夹） |
| GET | `/capabilities?cwd=&refresh=` | 工作目录下可用的技能、插件和 MCP 服务器状态（临时 query 的 `reloadSkills()`、`reloadPlugins()`，不调模型接口，缓存 1 分钟，`refresh=1` 不用缓存） |
| GET | `/skills/:name` | 技能的 `SKILL.md`（导入的、项目里的、导入插件里的 `插件名:技能名`）；内置技能没有文件，返回 404 |
| POST | `/skills/import`、`/plugins/import` | 导入：`{ path }` 是网关机器上的文件夹，复制到配置目录，已有同名的不覆盖 |
| GET | `/plugin-market?search=&marketplace=&category=&offset=&limit=&refresh=` | 插件市场里筛过的一页（`MarketPluginPage`：`plugins`、`total`、`marketplaces`、`categories`），同名的只留一个，按市场、安装次数排序，完整列表缓存 10 分钟；`refresh=1` 先更新市场 |
| POST | `/plugin-market/install`、`/uninstall`、`/update` | `{ id }`（插件名@市场名），交给 Claude Code 安装、卸载、更新；更新返回 `{ message }` |
| PATCH | `/skills/:name` | 启用、停用技能：`{ enabled }` |
| DELETE | `/skills/:name`、`/plugins/:name` | 删除导入的技能、插件和它们的文件 |
| PUT | `/mcp-servers/:name` | 添加 MCP 服务器，同名覆盖（stdio：`command`、`args`、`env`；http / sse：`url`、`headers`） |
| PATCH | `/mcp-servers/:name` | 启用、停用 `{ enabled }` |
| DELETE | `/mcp-servers/:name` | 删除 |
| POST | `/mcp-servers/:name/auth` | 开始 OAuth 登录，返回 `{ state, authUrl }`；已经连上的返回 `done` |
| GET | `/mcp-servers/:name/auth` | 登录进度：`waiting`、`done`、`failed`（带 `error`），结束后留 5 分钟 |
| POST | `/mcp-servers/:name/auth/callback` | 交回调网址 `{ url }`（浏览器和网关不在同一台电脑上时） |
| DELETE | `/mcp-servers/:name/auth` | 放弃正在进行的登录 |
| GET | `/connectors?search=&cursor=` | 连接器市场：不传 `search` 是推荐的，传了查 MCP 注册表，返回 `{ connectors, nextCursor }` |
| POST | `/connectors` | 添加连接器 `{ id, name?, variables?, headers? }`，返回存成的 MCP 服务器名称 |
| GET | `/sessions/:id/tasks` | 会话的后台任务（打开会话时拉一次，之后靠 `tasks` 事件） |
| GET | `/sessions/:id/tasks/:taskId/output` | 后台 Bash 任务输出的最后 64 KB，只能读这个会话记下的输出文件 |
| POST | `/sessions/:id/tasks/:taskId/stop` | 停止后台任务（`Query.stopTask()`） |
| DELETE | `/sessions/:id/tasks` | 清掉已经结束的后台任务 |

鉴权：设置了 `API_TOKEN` 时所有接口要求 `Authorization: Bearer <token>`；SSE 因为 `EventSource` 不能带头，用 `?token=`。

## 8. 目录结构

```
gateway/
  src/
    index.ts              入口：监听端口、优雅退出（关掉所有子进程）
    app.ts                Fastify 组装：CORS、鉴权、错误处理、路由
    config.ts             环境变量
    agent/
      input-queue.ts      可推送的 AsyncIterable，作为 query 的流式输入
      session.ts          单个活跃会话：query、消费循环、状态、权限挂起
      session-manager.ts  活跃会话表、创建 / resume / 空闲回收、历史读取
      options.ts          拼 SDK Options（env、模型、系统提示、工具白名单）
      attachments.ts      附件保存、按 id 找回、拼用户消息
    shared/types.ts       网关和网页共用的类型
    events/event-hub.ts   按会话分频道的环形缓冲 + 订阅
    http/sse.ts           SSE 输出、心跳、Last-Event-ID 续传
    http/routes/*.ts      路由
client/
  src/
    api.ts                HTTP + SSE 封装
    state/session.ts      事件归并成消息列表
    components/*          侧边栏、消息、工具调用、权限卡片、输入框（附件选择、拖入、粘贴）
```

## 9. 路线图

1. **骨架（已完成）**：单工作目录、流式对话、工具调用展示、权限确认、打断、历史会话、附件。
2. **对话体验**：Markdown 和代码高亮、diff 展示（Edit / Write 的入参）、思考块、AskUserQuestion 选择题（已完成，见 §4）、斜杠命令（`supportedCommands()`）、模型切换（`setModel()`）、上下文用量（`getContextUsage()`）。
3. **自定义工具**（`createSdkMcpServer()` 进程内 MCP）：内置浏览器（已完成第一版，只有桌面版，见第 12 节）、外部浏览器（用户的 Chrome，原型，见第 13 节）、终端读取（已完成）、会话管理、桌面操作（agent-desktop，设计中，见 [agent-desktop.md](agent-desktop.md)）。
4. **多人部署**：沿用 codex-app-server 的 hub + 每用户一个容器，每个容器一个 `CLAUDE_CONFIG_DIR`。
5. **桌面版**：Electron 外壳。

## 10. 风险

- **许可**：Agent SDK 和 Claude Code 二进制都是 Anthropic 专有许可（"All rights reserved"），使用受 Anthropic 条款约束，官方文档没有专门说明能否配第三方模型。自用风险低；对外收费或多人统一出 key 之前，需要跟 Anthropic 确认。详见 <https://code.claude.com/docs/en/legal-and-compliance>。
- **引擎不可控**：二进制随 SDK 版本更新，行为、协议、对第三方 base URL 的支持都可能变。锁定 SDK 版本，升级前在测试环境验证。
- **一会话一进程**：每个活跃会话一个 Node 子进程（约 100–200 MB），靠空闲回收和并发上限（`MAX_ACTIVE_SESSIONS`）控制。

## 11. 对话日志

网关把用户的原始内容和模型的实际响应写到 `gateway/.data/logs/`（`LOG_DIR`），排查问题用，和 Fastify 的运行日志分开，实现在 `gateway/src/logging/conversation-log.ts`。

- **格式**：每行一条 JSON，`{ time, sessionId, event }`，`event` 就是发给网页的事件（SDK 消息原样）。桌面工具另记 `{ time, sessionId, desktop }`（`gateway/src/desktop/log.ts`）：`kind` 为 `cli` 是一次 agent-desktop 调用（实际参数、耗时、退出码、原始结果，错误里含不交给模型的 `suggestion`、`recovery`），`guard` 是一次目标检查（本应用的进程号、目标窗口 / 同名应用、拦没拦），`own-pids` 是桌面版报来的进程号；网关自己列窗口时没有会话，`sessionId` 为空。文件名 `conversation-日期[.序号].jsonl`，日期按网关本机时区，`time` 是 UTC。
- **记什么**：`user_message`、SDK 的 `assistant`（含思考和工具调用）、`user`（工具结果）、`result`、权限请求和回复、错误，以及 `api_retry`、`compact_boundary`、`task_notification` 等排查用得上的 system 消息。`stream_event` 是同一份内容的逐字片段，不记。
- **图片**：消息里的 base64 内容（`source.type` 是 `base64`）存成 `images/<内容哈希>.<扩展名>`，同一张图只存一份；日志里的 `source` 换成 `{ type: "file", media_type, file }`，`file` 是绝对路径。`tool_use_result` 里同样内容的副本只留长度。
- **不是 HTTP 抓包**：记录的是 SDK 交给网关的消息，不包含 Claude Code 发给模型接口的完整请求（系统提示、工具定义）和请求头，接口密钥不会写入。
- **限制**：单文件 `LOG_MAX_FILE_MB`（默认 20），超过换下一个序号；总量 `LOG_MAX_TOTAL_MB`（默认 500，含图片），超过从最旧的文件删；保留 `LOG_RETENTION_DAYS` 天（默认 14，图片再次出现时重新计时）；单条 `LOG_MAX_ENTRY_KB`（默认 512），超过只留开头一段并标 `truncated`。启动时、每小时、换文件时清理。`LOG_ENABLED=0` 关闭。
- **隐私**：日志里有完整的对话和工具输出，文件权限 600。删除会话不会删日志，要等保留期到期或手动删。写失败只记运行日志，不影响会话。

## 12. 内置浏览器（只有桌面版）

右侧面板的浏览器，用户和 AI 都能操作，每个对话会话有自己的标签页。网页版没有。做法参照 VS Code 的内置浏览器（`src/vs/platform/browserView`）：网页是原生网页视图，AI 用 Playwright 经 Electron 自带的调试接口操作，不开调试端口。

```
网关 worker 线程（每个会话一个）：REPL ──connectOverCDP(transport)──▶ postMessage ──▶
网关主线程：WorkerRepl ──▶ BrowserHost ──WebSocket /browser/host──▶
外壳：GatewayBridge ──▶ 这个会话的 CdpProxy ──▶ 各标签页的 webContents.debugger ──▶ 网页视图
```

- **标签页**（`desktop/src/browser/views.ts`）：每个一个 `WebContentsView`，分区 `persist:claude-browser`（登录状态所有会话共用），记着所属会话。显示中的那个叠放在主窗口面板的画面区域上（界面每一帧对一次位置，变了才经 preload 的 `browser.show` 告诉外壳，按界面缩放换算）；其他的放在屏幕外的停放窗口里继续渲染：从窗口里拿走的视图不出画面，AI 截图会一直等到超时。Windows 加 `disable-features=CalculateNativeWinOcclusion`（屏幕外的窗口会被当成被挡住、不再绘制）；macOS 会把屏幕外的窗口挪回来，停放窗口保持隐藏，截图期间接连 `capturePage`（`stayHidden`）让网页出画面。User-Agent 去掉 Electron；网页的权限请求除了写剪贴板都拒绝；下载直接存进标签页所属会话的工作目录（开始、结束发 `download` 事件，CDP 代理照 Chrome 报给 Playwright，见下面「下载」）；`target=_blank`、`window.open` 装进新视图，归同一个会话；焦点在网页里时 Ctrl+R / F5 刷新、F12 开发者工具、Alt+←/→ 后退前进。右键是系统菜单：链接（新标签页打开、复制地址）、图片（新标签页打开、复制图片、复制地址）、输入框（撤销、重做、剪切、复制、粘贴、全选）、选中文字（复制、用必应搜索），空白处是后退、前进、重新加载，最后都有「检查」（单独窗口的开发者工具，选中右键处的元素）。
- **CDP 代理**（`desktop/src/browser/cdp-proxy.ts`，参照 VS Code 的 `browserView/common/cdp/proxy.ts`）：Electron 只有每个网页各自的调试接口，没有浏览器级的。代理替这个会话扮演「一个浏览器」：浏览器级的命令（没有 sessionId：`Browser.getVersion`、`Target.setAutoAttach`、`getTargets`、`createTarget`、`closeTarget`、`activateTarget`……）自己回答，只报这个会话的标签页，所以 Playwright 看不到别的会话的标签页，也看不到界面窗口；发给标签页的转给那个标签页的 `webContents.debugger`。标签页在 Playwright 那边的会话号是 `S` + targetId，iframe、Worker 的子会话号由调试接口分配，原样转发。`createTarget` 新建视图时先发 `attachedToTarget` 再回复（Playwright 要求这个顺序）。`Emulation.setDeviceMetricsOverride` 吞掉（视口由面板决定）；`Page.captureScreenshot` 期间让后台标签页出画面。
- **连接**（`desktop/src/browser/bridge.ts`、`gateway/src/browser/host.ts`）：外壳启动后连网关的 `ws://…/browser/host`（设了 `API_TOKEN` 时外壳要有同样的 `DESKTOP_GATEWAY_TOKEN` 或 `API_TOKEN`），网关重启时每 2 秒重连。网关为每个会话的 Playwright 连接发 `open`，之后 `cdp` 消息双向转发，`close` 结束；外壳只认最新连上来的一个。
- **每个会话一个 worker 线程**（`gateway/src/browser/worker.ts`、`worker-repl.ts`、`worker-protocol.ts`）：内置浏览器的 Playwright 连接和 `browser_run_code` 的 REPL 都在这个会话自己的 worker 里（参照 Codex：js_repl 和桌面版的 node_repl 都是每个会话一个 Node 进程；网关本身是 Node，用 worker 线程代价更小）。模型的代码卡住、出了认不出的错误，影响的只是这个会话的浏览器工具，网关和别的会话照常。主线程这边是代理 `WorkerRepl`：工具调用（`run`、`snapshot`、`screenshot`、`tabs`）转给 worker、结果带回；worker 要连浏览器时发 `cdpOpen`，主线程向 `BrowserHost` 开这个会话的通道，之后 CDP 消息按连接编号双向转发；桌面版发来的标签页变化（`BrowserHost.listenTabEvents`）直接转给 worker。worker 第一次用到时才起（第一次调用多 1 秒多：加载 Playwright、连接）；`busy`（一轮结束先不关临时标签页）在主线程按还没返回的 `run` 计。worker 退出了（认不出的错误按 Node 默认让它退出），还在等的调用以「运行环境退出了，变量已清空，标签页还在」出错，没有调用在跑时这句放在下一次结果开头，下次调用起一个新的；删会话时 `terminate`。**不检测卡死**：卡住的 worker（比如回溯爆炸的正则）一直留着，这个会话的浏览器工具调用一直不返回（跑久了照样转后台），`busy` 一直是真，直到会话被删除。开发时 worker 入口是 `worker.ts`，worker 里先用 `tsx/esm/api` 的 `register()` 注册 tsx 的加载钩子再加载它：worker 不一定继承得到主线程的钩子（Linux 上的 Node 22.23 继承得到，Windows 上的 Node 22.22 继承不到，只有 Node 自带的类型擦除，`./repl.js` 映射不到 `repl.ts`）；构建后直接跑 `worker.js`。**内存**：每个用过内置浏览器的会话多一个 worker，实测约 90MB（Playwright 加载和连接后堆约 50MB），删会话或网关重启才释放。Chrome（第 13 节）所有会话共用一条连接，REPL 还在主线程。
- **浏览历史**（`desktop/src/browser/history.ts`）：Electron 的网页视图不写 Chrome 的历史数据库，外壳在主框架跳转时自己记（网址、标题、访问次数、最近访问时间，只记 http(s)，最多 5000 个），存在用户数据目录的 `browser-history.json`。地址栏输入时下面弹出建议：网址或标题包含输入里的每个词，按访问次数和远近排（网址以输入开头的靠前），上下键选、回车打开。
- **临时标签页**：AI 开的标签页（`Target.createTarget`，以及从它弹出的新页面）是临时的，网关在一轮结束（SDK 的 `result`）时发 `turnEnded`，外壳关掉这个会话里没留下的。留下的情况：AI 调用 `browser_keep_tab`（网关加的工具，留的是这个会话里 AI 最近操作过的标签页，CDP 代理按跳转、输入、读页面、截图这些命令记）、用户在地址栏里自己跳转过、这一轮结束时用户正在面板里看着它。模型常忘了留，`browser_run_code` 打开了新标签页或当前页跳转了时，网关问外壳这个会话现在有哪些没留下的临时标签页（`temporary` 请求，外壳回复标题、网址和哪个是 AI 最近操作的），有的话在结果后面列出来，说明一轮结束时会关、`browser_keep_tab` 留的是最近操作的那个。不能只看「打开了网页」：跳转的可能是用户开的、或者已经留下的标签页（以前一律附「这是你开的临时标签页」，在用户的标签页里跳转也这么说）。外壳没回复（没在运行、旧版本）时 2 秒后不附。说明、`browser_keep_tab` 的描述和这句提醒都写明两种结果各意味着什么（关掉：用户在面板里看不到、下一轮也不在；留下：用户能看到、能操作，下一轮还能接着用，直到用户关掉或删除会话），要不要留由模型自己判断，不写「用户要看的就留」这类做法。还有转到后台的 `browser_run_code` 在跑时，一轮结束先不关（见下面「AI 的工具」）。用户开的标签页一直留着。删除会话时网关发 `closeSession`，外壳关掉这个会话的所有标签页（AI 留下的、用户开的不会自动关，不关会一直留在后台，会话没了，面板里也看不到）。**重启后恢复**：外壳把开着的标签页（会话、网址、标题、留没留下、一个不随重启变的 `key`）存在用户数据目录的 `browser-tabs.json`，启动时重新打开；主窗口关闭、应用退出前先存一次，之后视图跟着窗口销毁的不算关闭。CDP 的 id 是新的，界面的面板状态（每个文件夹的标签页和当前标签，localStorage 的 `sidePanelStates`）按 `key` 对回来；终端标签按网关上还在不在，第一次对齐之前不接。
- **新会话页**：没有右侧面板（开关置灰），不能在这里开标签页，输入框的「标签页」按钮里也没有内置浏览器的标签页；标签页都属于建好的会话，不用转交。
- **引用标签页**（`client/src/components/TabPicker.tsx`）：输入框上面和「技能」「插件」并排的「标签页」，点开搜索标题或网址，分「内置浏览器」（这个会话的标签页，只有桌面版）和「Chrome」（第 13 节，开了外部浏览器时）两组，两组都没有时不显示按钮；每组第一行是浏览器本身，选中插入 `@内置浏览器` 或 `@Chrome`，用来指定用哪个浏览器（两个浏览器的 MCP 说明里各写了这个写法指什么），在输入框和消息里显示成浏览器图标加名字，整体删除；输入框里打 @ 只列项目文件。选中后在光标处插入 `@[标题](网址)`（输入框里只显示 `@[标题]`，网址由输入框记着，发送时补回完整格式；同名不同网址的标题后面加「(2)」区分），整体高亮、整体删除；消息里显示成带地球图标的标题，会话标题里只留标题。模型按浏览器说明里写的，用 `browser_tabs` 按网址找到它切过去。
- **AI 的工具**（`gateway/src/browser/tool.ts`、`repl.ts`）：参照 Codex 的浏览器（只有一个 `js` 工具，模型写脚本操作网页），以 `browser_run_code` 为主，用 SDK 的 `createSdkMcpServer` 自己实现，内置浏览器和第 13 节的外部浏览器共用（`browserMcpServer`）。以前挂的是 `playwright-core` 自带的 Playwright MCP（二十多个工具，点击、输入、等待各一个，`browser_wait_for` 一次最多等 30 秒）：网页里的 AI 要几分钟才出结果时，模型等一两次就回一句「等结果出来再告诉你」结束这一轮，可一轮结束后没有任何东西会叫醒它（网页变化不会发 `task_notification`）。服务器名 `inapp`（应用内的浏览器，和第 13 节的 `chrome` 一眼能分开；以前叫 `web`，旧会话记录里的工具名还是 `mcp__web__…`），工具全名如 `mcp__inapp__browser_run_code`（不叫 `browser`，免得和工具名自带的 `browser_` 前缀重复）。
  - `browser_run_code`：在常驻的 REPL 里跑 JavaScript（Playwright API），可以直接用 `page`（当前标签页）、`context`（`BrowserContext`）。每个会话在每个浏览器里一个 `vm` 上下文，放在模块级的表里（`replFor`），会话空闲关掉子进程、resume 后变量还在，删会话时清掉（`disposeRepls`），网关重启才清空。网关重启后恢复的会话，REPL 是新建的（空闲后恢复的 REPL 还在表里，不会新建），第一次调用浏览器工具时在结果开头说明「运行环境是新建的（应用重启过）：之前调用里定义的变量都已不在，page 指向现在最后一个标签页；标签页本身还在」，只说一次（`replFor` 的 `resumed`）。不说的话模型照旧用存着的变量，撞上 `ReferenceError` 才知道（实测：改配置重启网关后，模型写 `page = dbPage` 报错）。Codex 的 js_repl 不说（会话恢复后悄悄起新内核），只在自己重置内核时（超时、崩溃）在错误里说明。代码先用 acorn 改写（同 Node REPL 处理顶层 await 的办法）：顶层的 `const`/`let`/`var`/`class` 改成给全局变量赋值、`function` 声明提到最前面，变量名在外面用 `var` 声明，整段包进 async 函数，最后一条是表达式时 return 它；所以顶层可以 await，变量在之后的调用里还在，同名 `const` 可以重新声明。返回最后一个表达式的值（字符串原样，其他 `util.inspect`）和 `console.log` 的输出，`emitImage(buffer)` 返回图片；出错只返回错误信息（Playwright 的 Call log 留着，调用栈和颜色码去掉）。`timeout_ms` 默认 60 秒、最大 15 分钟，网页里的长任务在一次调用里等完。默认值比 Playwright 单个动作的默认超时（30 秒）长：两者一样长时，`timeout_ms` 几乎和动作超时同时到点，先返回的是笼统的「超过 timeout_ms」，Playwright 报的具体原因（哪个元素、不可见还是被挡住）没人接，就丢了；到时间或用户中断（MCP 请求的 `signal`）就不再等，但 vm 里的代码停不下来，会在后台跑到自己结束。SDK 内的 MCP 服务器调用默认不限时，挂 15 分钟不会被掐断。`vm` 不是安全边界，代码能拿到网关的 `process`，等同于 Bash，所以不放进 `allowedTools`：非「完全访问权限」时每次走权限卡片。
  - **跑久了自动转后台**：Claude Code 自带「MCP 调用跑太久就转成后台任务」（`task_type: mcp_task`，同终端里的 Ctrl+B），但非交互会话（SDK）默认不开，`agentEnv()` 给子进程设 `CLAUDE_AUTO_BACKGROUND_TASKS=1`（它也管 Bash 和子代理）和 `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`（默认 120 秒，这里 20 秒，`MCP_AUTO_BACKGROUND_MS`），环境里设了的不覆盖。前 20 秒这一轮停在那里等；之后工具先返回「still running after 20s. It was moved to the background as task …」，这一轮接着走，模型可以先回复用户、结束这一轮；网关里的代码照常跑完，结果以 `<task-notification>` 送回来，会话空闲时自动开始新的一轮（实测：60 秒的等待，第 43 秒转后台、第 49 秒模型回复「正在等结果」结束这一轮，第 85 秒通知到、新的一轮回复结果）。说明里如实交代：超过约 20 秒会转为后台任务、结束后结果作为通知送达、会话空闲时通知会开始新的一轮、网页自己的变化不会唤起它。运行中插话也会提前转后台：网关在主线程有工具调用正在跑时（`toolsInFlight`：发出了 `tool_use`、还没回 `tool_result`）发出的消息带 `priority: "now"`（`Session.send`；不带时 Claude Code 按 `later` 处理，要等这一轮结束才送到），正在跑的 MCP 调用马上转到后台、不打断，消息送到模型（实测：等待开始 5 秒后插话「1+1 等于几」，1 秒内转后台，模型先回答「2」，60 秒的结果之后以通知送回）；消息同时标 `origin: { kind: "human" }`（不标时 Claude Code 当作来源不明）。只在有工具调用在跑、没有待确认的权限时才用 `now`：模型正在生成文字时 `now` 会打断它（实测写到 371 字的文章停在半句、没有续写，直接回答了插话），这时不带，等这一轮写完再回答插话（实测文章完整写完 2229 字后回答「2」）。有转后台的代码还在跑时（`inappBusy`，REPL 的 `busy`），或者这一轮里有后台浏览器任务结束了（`Session.browserTaskEnded`：它的结果下一轮才交给模型，模型多半还要接着用那个标签页；实测任务在这一轮结束前 3 秒失败，标签页被关，下一轮 `page` 成了 undefined），一轮结束先不关内置浏览器的临时标签页，等下一轮结束再关。`page` 指向的标签页被关掉时 REPL 把它换成最后一个标签页，没有就是 undefined；其他变量不受影响。**标签页的变化和是谁做的要告诉模型**：模型下一次调用任何浏览器工具（`browser_run_code`、`browser_snapshot`、`browser_take_screenshot`、`browser_tabs`）时在结果开头说自上次调用以来的变化，`browser_run_code` 结束时在结果末尾说这次调用期间的变化（用户在 AI 运行时关的也在内），说一次就清掉；AI 自己开、关的不说。再附上 `page` 是不是因为标签页被关换掉了，和不是 AI 开的新标签页在 `context.pages()` 里的序号（「模型已经知道的标签页」之外、又不是它开的），代码自己等到弹出页并赋给 `page` 的不说。
  - **内置浏览器：桌面版知道每一次是谁做的**（`desktop/src/browser/views.ts` 的 `TabEvent`，经 `/browser/host` 发给网关，`BrowserHost.takeTabEvents` 按会话取走）。新开：`create()` 的 `openedBy`（AI 的 `Target.createTarget` 是 agent，面板的「+」、地址栏、右键「新标签页打开」是 user）；网页弹出的（`setWindowOpenHandler`）按弹出前 2 秒内原标签页上最近的一次点击按键是谁的：CDP 代理记 AI 每次发 `Input.*` 的时间，网页的 `input-event` 里离 AI 上次发输入不到 0.3 秒的是 AI 的（实测 CDP 发的输入也会触发 `input-event`），其余是用户的；都没有就是网页自己弹的；网址用 `window.open` / 链接的目标网址（刚登记时还没开始加载）。关闭：`close()` 带上原因，CDP 代理的 `Target.closeTarget` 是 agent，界面的 × 是 user，`turnEnded` 是 turn-end；没经过 `close()` 就销毁的是网页自己关的（`window.close`、崩溃）。用户在地址栏跳转、点后退、前进、刷新也发。一轮结束时自动关的会附一句事实：你开的标签页一轮结束时会自动关闭，除非调用过 `browser_keep_tab`。
  - **下载**（`desktop/src/browser/cdp-proxy.ts`）：外壳自己处理下载（`will-download` 里 `setSavePath`），存进标签页所属会话的工作目录，同名加 (1)、(2)：文件归会话，面板的文件树里看得到，模型也知道在哪。工作目录以网关为准：桌面版连上网关时、会话有了第一个标签页时发 `{ type: "sessionDir", session }` 问，网关用 `SessionManager.cwd` 回答，记在 `BrowserViews.sessionDirs`；问不到（网关不知道这个会话、还没回答）时存进系统的「下载」文件夹。Electron 的调试接口不报下载事件，Playwright 的 `download` 事件原本永远等不到（实测模型在网页里画好 canvas、用 `<a download>` 存图片，`page.waitForEvent('download')` 等满 30 秒以为没存成，其实文件早就在「下载」文件夹里）。CDP 代理照 Chrome 的协议补上：Playwright 连上时发 `Browser.setDownloadBehavior`（`allowAndName`，`downloadPath` 是它的临时目录，以前代理当空操作），记下目录；下载开始时取标签页主框架的 id 报 `Browser.downloadWillBegin`（Playwright 按 frameId 找到是哪个页面的下载），`suggestedFilename` 报实际存下的文件名（同名时带 (1)；以前报网页给的名字，模型拿它去「下载」文件夹找，找到的是之前同名的旧文件），结束时把文件硬链接（不在一个盘上就复制）成 `downloadPath/guid`，再报 `Browser.downloadProgress`（`completed`，取消、中断报 `canceled`）；`Browser.cancelDownload` 取消下载。这样 `waitForEvent('download')`、`download.path()`、`saveAs()`、`suggestedFilename()` 都和普通 Chrome 一样，说明里只交代下载存进会话的工作目录、`suggestedFilename()` 是实际的文件名。Playwright 的 `download` 对象没有进度（协议里的 `inProgress` 它收到也不管），内置浏览器的 REPL 另有全局函数 `downloads()`：经主线程（worker 的 `downloads` 消息）、`/browser/host`（`{ type: "downloads", session, id }`）问桌面版，`BrowserViews.downloadsOf` 读 Electron 下载对象上的实时数据（已收到、总共的字节数，速度，状态，暂停没有），返回这个会话进行中的和最近结束的下载（每个会话留最近 20 个结束了的）；按需取，不往网关推进度。以前试过另一种做法：下载结束时作为标签页变化写进工具结果，但调用常常在点了下载后马上返回、文件还没写完，要等下一次浏览器工具调用才送到，模型接着用 Bash 去找文件就一直看不到。
  - **Chrome：只能分出是不是 AI**（扩展不说是谁）。给 Playwright 的 `BrowserContext.newPage`、`Page.close` 加一层记录（改原型，只改一次；网关里调这两个方法的只有模型的代码），AI 开的、关的不说；其余关掉的写「不是你关的（用户在 Chrome 里关的，或网页自己关的）」，没有 opener 的新标签页是用户新开的，有 opener 的按时间写：代码运行期间弹出的、调用结束 2 秒内弹出的（上一次调用里的操作触发的）、其余的（用户点击或网页自己弹出）。用户在 Chrome 里开的、没进 Playwright 标签页组的看不到（扩展的限制）。
  - 实测（本机桌面版，带调试端口用脚本操作界面）：AI 点按钮弹出的、页面定时器弹出的、用户在网页里点击弹出的、一轮结束自动关的、用户在面板「+」新开的、用户点 × 关的、用户在地址栏跳转的，都按来源写对了。几次调用可以同时在跑，`console` 的输出记到最近开始、还没结束的那次。
  - 代码在它所在线程的事件循环里异步跑，`await` 等待时不影响别的调用。要防模型的代码卡住或弄垮它所在的线程：Chrome 的 REPL 在网关主线程，卡住的是整个网关；内置浏览器的在会话自己的 worker 里（见上面「每个会话一个 worker 线程」），卡住的只是这个会话的浏览器工具。下面这些在两处都照样做，中止的只是这次调用，变量和连接都还在：
    - **同步死循环**：改写时在每个循环体开头插一个检查（vm 里计数，每 1024 次看一次时间），事件循环超过 2 秒没转过来就抛错，`await` 之后、定时器回调里的循环也管得到；第一个 `await` 之前的同步部分另外用 `vm.runInContext` 的 `timeout`（2 秒）兜底，管回溯爆炸的正则这类。不在循环里、又在 `await` 之后的同步卡顿管不到。
    - **vm 上下文用 `vm.constants.DONT_CONTEXTIFY`**（Node 22.8 起）：普通的 vm 上下文访问全局变量要经拦截器，顶层变量都改成了全局变量，1e7 次循环读写一个全局变量要 9 秒，会被上面的检查误杀；这样只要 0.2 秒。
    - **没人接住的错误**：定时器、`page.on` 回调里抛的错，没有 `await` 的调用被拒绝的，按 Node 默认会让网关退出（以前 Playwright MCP 注册的 `unhandledRejection` 监听碰巧兜住了一部分）。`repl.ts` 挂上全局的 `uncaughtException`、`unhandledRejection`：每个 REPL 的代码用自己的文件名（`browser_run_code_<编号>.js`）跑，调用栈里有它、或者被拒绝的 Promise 是那个 vm 里建的，就记下来、下次调用时放在结果开头告诉模型；认不出的照 Node 默认的做法打印并退出（在 worker 里退出的只是这个 worker）。
  - `browser_snapshot`（`page.ariaSnapshot({ mode: "ai" })`，带 `[ref=e12]`，代码里用 `page.locator('aria-ref=e12')` 引用，前面列出所有标签页）、`browser_take_screenshot`（默认可见区域 PNG，`full_page` 整页 JPEG）、`browser_tabs`（`list`，`select` 把第几个设成 `page`），加上内置浏览器的 `browser_keep_tab`：只读，在 `allowedTools` 里不用确认。新开、关闭、跳转都在代码里做。这几个和代码共用 REPL 里的 `page`：代码里给 `page` 赋值就是切换当前标签页；`page` 关掉了或连接换了时换成最后一个标签页。
  - **给模型的文字只交代环境和数据，不教它怎么做**：MCP 的 `instructions`（`RUNTIME_FACTS` 两边共用）、工具描述、工具返回结果里的说明，写的都是事实：浏览器是什么、全局变量、返回什么、时间限制、超时和转后台会发生什么、什么会通知它、标签页的生命周期、标签页发生了什么变化。不写「先用 snapshot」「多步操作写在一次调用里」「怎么等」「什么时候用哪个工具」「要操作就 page = …」这类做法，决策留给模型。以前写过「循环检查页面内容、没好就 waitForTimeout(5000)」这样的例子，模型照着写了一个固定 36 次 × 5 秒的循环，完成判断是它自己补的、一直不成立，DeepSeek 半分钟就答完了，它等满 3 分钟。
  - 第一次调用工具时才 `chromium.connectOverCDP(transport)`；桌面版没开时工具返回错误，开了之后再调用就能用，断开后下次调用重连，所以每个会话都挂上。常驻哪些工具在 `gateway/config.yml` 的 `tools.alwaysLoad` 里配（默认两个浏览器的工具全部常驻，工具定义一共约 5000 字符；终端的工具也能配），`tools/list` 里给它们加 `_meta["anthropic/alwaysLoad"]`，其余的延迟加载、用到时 ToolSearch：不常驻时 GPT 类模型常在 ToolSearch 的 `select:` 里把工具名列了又列，写满 `max_output_tokens` 才停，界面「思考中」两分多钟。
- **面板**（`client/src/components/BrowserTab.tsx`、`SidePanel.tsx`）：新标签页顶部是地址栏（同 codex-app-server），输入网址这个标签页就变成浏览器；像网址的补上协议，否则用必应搜索。面板只显示当前会话的浏览器标签页，外壳推来标签页列表时把当前会话的、面板里还没有的（AI 开的）补成标签页，关掉的去掉；AI 切标签页时面板跟着切：Playwright 不发 `Target.activateTarget`，CDP 代理把 `Page.bringToFront`（不转给网页，Electron 的网页视图会去抢窗口焦点）和 AI 在标签页上的跳转、输入（`Page.navigate`、`Page.reload`、`Input.*`）都当作切过去，同一个标签页只切一次（用户手动切走后，AI 接着在原来的标签页上点不会把面板拉回来）；读页面（`Runtime.evaluate` 等）不算，Playwright 等元素时一直在发，算进去面板会来回闪。网关的 REPL 里 `page` 是全局对象上的访问器，模型给它赋了另一个标签页时调用 `bringToFront()`（REPL 自己因为标签页被关而换 `page` 时不调）。切换通知可能比面板补上 AI 新开的标签页先到，面板先记着，补上时再切。界面的对话框、菜单、地址栏建议盖住画面区域时（在画面区域上取 5×5 个点 `elementFromPoint`，离边 6px，避开面板左边缘调宽度的那条）先给网页拍一张快照贴在原位（`browser.snapshot`，`capturePage`），再把视图收起来，不然会挡住它们；露出来后叠回去。
- **网页图标**：桌面版在 `page-favicon-updated` 时取下网页声明的第一个图标，标签页信息里给一个 `favicon://icon/<编号>` 地址（主进程注册的特权协议，`views.ts` 的 `faviconResponse` 返回图片），面板标签和输入框的「标签页」选择器显示它，没有或加载失败时用地球（`SiteIcon`）。界面不直接按图标网址加载：有防护的网站会拦（DeepSeek 不带浏览器 Cookie 和请求头时返回 202 的验证页面）。取的时候先用内置浏览器的会话请求（带 Cookie，跨域的图标如 GitHub 的 githubassets.com 靠这个），拿到的不是图片再在标签页的网页里 `fetch`（和网页自己加载图标的条件一样，DeepSeek 靠这个）；只要图片、最多 2 MB，按网址缓存。不用 data: 地址是因为图标可能很大（DeepSeek 的 favicon.ico 有 205 KB），标签页信息每次变化都整份推给界面。跳到别的网站（域名不同）时清掉图标；同一个网站里跳转不清，图标网址没变时 Electron 不会再发 `page-favicon-updated`（DeepSeek 打开后马上跳到 /en/，清掉就再也没有了）。Chrome 那组标签页拿不到图标，选择器里用网站根目录的 `/favicon.ico` 试。
- **没做的**：页面批注；清除浏览历史的入口。macOS、Windows 还没实测；右键菜单没有自动化测过（系统菜单弹出后脚本关不掉）。

## 13. 外部浏览器（用户自己的 Chrome）

让 AI 操作用户自己的 Chrome，带着里面的登录状态和 Cookie，和第 12 节的内置浏览器并存。用的是 Playwright 官方的 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm)，网关这边是 `playwright-core` 自带的扩展模式，不另装依赖。网页版、桌面版都能用，但 Chrome 要和网关在同一台机器上。

```
网关：各会话的浏览器工具（REPL）──同一个 BrowserContext──▶ ChromeBridge ──本机中转（CDPRelayServer）──▶
Chrome：Playwright Extension ──chrome.debugger──▶ Playwright 标签页组里的标签页
```

- **开关**：`gateway/config.yml` 的 `externalBrowser.enabled`，默认开（写成 `false` 才关）。开着时每个会话多一个 MCP 服务器 `chrome`，工具全名如 `mcp__chrome__browser_run_code`。工具和内置浏览器是同一套（第 12 节，`browser/tool.ts` 的 `browserMcpServer`），没有 `browser_keep_tab`，REPL 和内置浏览器的分开。只读的工具（`READ_TOOL_NAMES`）不用确认，`browser_run_code` 非「完全访问权限」时走权限卡片。常驻也在 `tools.alwaysLoad` 里配，默认全部常驻。内置浏览器的说明里补一句「我的 Chrome」时用 `mcp__chrome__` 的工具。内置浏览器的说明里补一句「我的 Chrome」时用 `mcp__chrome__` 的工具。
- **连接**（`gateway/src/browser/chrome.ts`）：所有会话共用一条。扩展同一个 Chrome 配置只认一个客户端，第二个连上来会把第一个顶掉、把它的标签页移出组（microsoft/playwright#41838、#42015），所以不能像内置浏览器那样每个会话各连一次。第一次调用工具时才连：`resolveCLIConfigForMCP({ extension: true })` + `createBrowserWithInfo` 起中转、拉起 Chrome 打开扩展的 `connect.html`，等扩展连上：没设 token 时等用户在连接页上选标签页、点允许，不限时（工具调用一直挂着，用户可以中断）；设了 token 时自动连，30 秒连不上报错。之后各会话的 REPL 拿到同一个 `BrowserContext`（各自的 `page` 分开记）。断开后下次调用再连。连扩展用的还是 Playwright MCP 里的这两个函数，工具不用它的。`createBrowserWithInfo` 顺带的 `bind`（登记给 `playwright-cli` 接）连上后撤掉。
- **配置**：都是 Playwright 自己读的环境变量，写在 `gateway/.env.local`。`PLAYWRIGHT_MCP_EXTENSION_TOKEN` 是扩展里显示的 token（连接页上有复制按钮），连接页带上它就自动连、不显示批准界面；拿到它的进程都能不经提示操作用户的 Chrome，所以 `agentEnv()` 不把它传给 claude 子进程，模型在 Bash 里读不到。扩展里重新生成 token 并重启浏览器就作废旧的；`PLAYWRIGHT_MCP_PROFILE_DIR_NAME` 指定 Chrome 配置（默认是装了扩展的、最近用过的那个）；`PLAYWRIGHT_MCP_BROWSER`（如 `msedge`）、`PLAYWRIGHT_MCP_EXECUTABLE_PATH` 换浏览器。
- **能看到的标签页**：只有 Playwright 标签页组里的，也就是连接时用户选的，加上 AI 新开的；用户其他的标签页扩展不交出来。所有会话看到的是同一组。AI 开的标签页不自动关（说明里写明这一点，关不关由模型决定）。
- **引用标签页**：`GET /chrome/tabs` 列出组里的标签页（已经连上才有，不会为了列标签页去拉起连接页；后台冻结的标签页标题最多等 1 秒）。输入框上面的「标签页」里是「Chrome」那一组（每次打开时取一次）；选中后插入 `@chrome[标题](网址)`，消息里显示成「Chrome · 标题」，会话标题里只留标题。模型用 `mcp__chrome__browser_tabs` 按网址找到它切过去。
- **注意**：网关是从桌面版里起的（带 `no_new_privs`，见 CLAUDE.md）、Chrome 又没开着时，由网关拉起的 Chrome 也会带上这个标志，Chrome 的沙箱可能起不来；先把 Chrome 开着，或者用 `systemd-run --user` 单独起网关。Chrome 顶部会显示扩展正在调试浏览器的提示条。
- **没做的**：多会话各自隔离标签页、@ 引用用户全部的标签页（官方扩展做不到，要自己写扩展，复用第 12 节的 CDP 代理）。
