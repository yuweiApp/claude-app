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
- **空闲回收**：`idle` 超过 `SESSION_IDLE_MS`（默认 30 分钟）就 `close()`，子进程退出。下次再发消息时用 `resume` 重新拉起，对话历史从 jsonl 读回，用户无感。

新会话由 gateway 生成 UUID 作为 `options.sessionId` 传给 SDK，所以创建接口能马上返回会话 id，不用等 `system/init`。

### 2.2 历史会话

不另建数据库，直接用 SDK 读 Claude Code 落盘的 jsonl，返回给网页的也是 SDK 的数据格式：

- 列表：`listSessions()`（不传 dir，所有工作目录），`GET /sessions` 原样返回 `SDKSessionInfo`，只加上活跃会话的 `state`
- 消息：`getSessionMessages(id)`（`SessionMessage`）
- 改名：`renameSession(id, title)`
- 技能和插件：输入框上面的「技能」「插件」选择后写进输入框。技能写成消息开头的 `/技能名`（Claude Code 只认开头），插件写成 `@插件名`，只是文字引用，Claude Code 没有对应的命令。用技能的消息在历史里是 `<command-message>` 标签加一条技能内容，网页还原成 `/技能名 内容`，技能内容不显示。
- 引用文件：有项目文件夹时，输入框里打 `@` 弹出项目里的文件、文件夹，选中写成 `@相对路径`（带空格的加引号 `@"a b.txt"`），和 Claude Code 命令行的 @ 引用一样交给 SDK。输入框里只列文件，插件用上面的「插件」按钮；也没有 `/` 命令菜单，技能用「技能」按钮。候选来自网关 `GET /files?cwd=&q=`：`q` 为空列第一层，以 `/` 结尾列那个文件夹，否则在整个项目里按名字搜（git 仓库用 `git ls-files` 按 `.gitignore` 过滤，列表缓存 10 秒）。技能名、插件和文件引用在输入框里高亮，删除、移动光标都按一个整体。
- 导入技能和插件：技能文件夹要有 `SKILL.md`，复制到 `$CLAUDE_CONFIG_DIR/skills/<名称>/`，Claude Code 自己发现；插件文件夹要有 `.claude-plugin/plugin.json`，复制到 `$CLAUDE_CONFIG_DIR/gateway-plugins/<名称>/`，通过 `options.plugins` 加载，它的技能叫 `插件名:技能名`。桌面版用系统对话框选文件夹，网页用 `GET /folders` 浏览。
- 停用技能：停用的名称存在 `$CLAUDE_CONFIG_DIR/gateway-disabled-skills.json`。有停用的技能时，网关把其余技能作为 `options.skills` 白名单传给 SDK，模型看不到停用的技能，调 Skill 工具也会被拒绝；这个白名单管不到用户自己输入的 `/技能名`，所以网关在新建和发送时再拦一次，返回 400。白名单在拉起 claude 进程时确定，已经活跃的会话要等进程重启才更新，`/技能名` 的拦截立即生效。内置技能只能停用；删除只针对导入的技能，是删文件，SDK 没有对应接口。
- MCP 服务器：设置页添加的存在 `$CLAUDE_CONFIG_DIR/gateway-mcp-servers.json`（权限 600，请求头和环境变量可能有令牌），启用的通过 `options.mcpServers` 传给会话，对新会话和子进程重启后的会话生效。插件或配置文件带来的服务器只显示，不能在设置页改。
- 标题：新会话发出第一条消息时，网关直接请求模型接口概括成简短标题（`gateway/src/agent/title.ts`，失败时取提问第一行），用 `renameSession()` 写成自定义标题，之后不再变。网页显示 `customTitle`，没有时用 `firstPrompt`；`summary` 没有自定义标题时跟着最新一条提问变，不用它。

### 2.3 项目（文件夹）

和 Claude 桌面版 Code 标签页一致：**项目就是会话的文件夹（工作目录）**，没有单独的项目列表。Claude Code 按工作目录存会话（`$CLAUDE_CONFIG_DIR/projects/<编码后的目录>/`），`SDKSessionInfo.cwd` 就是会话所在的文件夹；桌面版自己的会话记录（`claude-code-sessions/…/local_<id>.json`）里也只记 `cwd`。

- 侧边栏「会话」按文件夹分组（桌面版的 Group by › Project），组名取目录最后一级，悬停有「在 {文件夹} 中新建会话」。没选文件夹的会话跑在默认工作目录 `WORKSPACE_DIR`，分组叫「无文件夹」（桌面版的 No folder）。
- 新会话在输入框上面一栏「选择文件夹」（桌面版的 Choose a folder，样式同 codex-app-server 新聊天页）：最近用过的文件夹，或「选择文件夹…」打开对话框浏览网关这台机器上的文件夹（`GET /folders`）。
- `POST /sessions` 带 `cwd`（必须是已存在的目录，支持 `~`），子进程在这个目录里跑；续接会话时用 `getSessionInfo(id).cwd` 找回原来的目录。
- 附件存在默认工作目录下，其他文件夹里的会话启动时用 `additionalDirectories` 把附件目录加进来，读附件不用确认。

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
| `user_message` | `{ uuid, content }` | 用户发的消息（gateway 推进队列时发出，SDK 默认不回显用户输入） |
| `state` | `{ state, model?, permissionMode? }` | 会话状态变化 |
| `permission_request` | `{ requestId, toolName, input, title?, description?, decisionReason? }` | `canUseTool` 挂起的权限请求 |
| `permission_resolved` | `{ requestId, behavior }` | 已回复或超时、取消 |
| `error` | `{ message }` | 子进程异常退出等 |
| `tasks` | `{ tasks: BackgroundTask[] }` | 会话的后台任务有变化，整个列表（见下面「后台任务」） |
| `reset` | — | 续传点已不在缓冲里 |

SDK 消息原样转发，不在 gateway 里做第二套协议。原因：SDK 类型比较全，转一遍只会丢字段；客户端可以直接 `import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'`。

### 3.3 客户端归并规则

- 打开会话：先连 SSE，再拉 `GET /sessions/:id/messages` 的历史，两边按 `uuid` 去重合并。
- `stream_event` 只用来拼"正在生成"的那段文字；收到对应的完整 `assistant` 消息后丢掉临时内容。模型的思考（`thinking` 块）不显示。
- 工具调用：`assistant` 里的 `tool_use` 块和随后 `user` 消息里同 `tool_use_id` 的 `tool_result` 配对显示。
- `parent_tool_use_id` 不为空的是子代理里的消息，折叠在对应的 Agent 工具调用下面。
- 后台任务（会话标题后面的按钮，点开是弹窗）：网关按会话记后台任务（`gateway/src/agent/tasks.ts`）。SDK 的 `task_started` / `task_updated` / `task_notification` 里没有时间，开始、结束时间按网关收到的时间记；命令取自对应的 Bash `tool_use`，输出文件路径取自放到后台时立即返回的 `tool_result`（运行中就能看输出）或完成通知。只列放到后台的任务，`ambient`、`skip_transcript` 的不列。任务记录跟会话走，子进程空闲回收后还在，会话删除或网关重启时丢掉；子进程退出时还在运行的任务记为已停止。
- 后台任务（Bash 后台命令、后台子代理）完成时，如果模型空闲，Claude Code 会拿通知自动开始新的一轮，没有用户消息。历史里这条通知存成内容是 `<task-notification>` 的 user 消息；实时事件里只有 `system/task_notification`，之后网关的状态从 `idle` 变回 `running`。网页把两者都显示成一行「后台任务已完成：…」作为新一轮的开头，按 `task:<task_id>` 去重。一轮还在进行时完成的任务，Claude Code 会把通知并进当前这一轮（只有一个 result；历史里这条通知夹在这一轮中间，前一条 assistant 的 `stop_reason` 是 `tool_use`），这种不分轮、对话里也不显示：历史里按 `stop_reason` 判断，实时按收到通知后这一轮里有没有再发出模型请求（`status: requesting`）判断；通知到时已经在路上的请求不带它，响应回来后通知还会开新的一轮。

## 4. 权限

- `permissionMode` 默认 `bypassPermissions`（完全访问，`DEFAULT_PERMISSION_MODE` 可改），可选 `acceptEdits`、`plan`、`bypassPermissions`（需要 `allowDangerouslySkipPermissions`）。运行中通过 `query.setPermissionMode()` 切换。
- 需要确认时 SDK 调 `canUseTool(toolName, input, { signal, suggestions, title, description, decisionReason })`。gateway 生成 `requestId`，发 `permission_request` 事件，返回一个 Promise 挂起，等 `POST /sessions/:id/permissions/:requestId` 回复：
  - 允许：`{ behavior: 'allow', updatedInput: input }`；勾"以后都允许"时带上 `updatedPermissions: suggestions`
  - 拒绝：`{ behavior: 'deny', message }`
- `signal` 中止（用户打断）或超过 `PERMISSION_TIMEOUT_MS`（默认 10 分钟）时自动拒绝，并发 `permission_resolved`。
- `AskUserQuestion` 也走 `canUseTool`，入参里是问题和选项。客户端单独渲染成选择题，用户的回答通过 `updatedInput.answers` 返回（第一版先按普通权限处理，见 §9）。

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
- 兼容性需要实测：工具调用格式、`thinking` 块、prompt caching 字段、并行工具调用。不兼容时优先在 newapi 侧修，其次关掉对应特性（如 `MAX_THINKING_TOKENS=0`）。

## 7. HTTP 接口（第一版）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 网关状态 |
| GET | `/config` | 工作目录、默认模型、默认权限模式、默认推理强度（`DEFAULT_EFFORT`，默认 high）、上传大小上限 |
| GET | `/models` | 可选的模型（SDK 的 `ModelInfo` 格式）：接 newapi 时是它 `/v1/models` 里的对话模型，直连 Anthropic 时是 `Query.supportedModels()`；缓存 5 分钟 |
| GET | `/sessions` | 所有文件夹的会话，SDK 的 `SDKSessionInfo` 加活跃会话的 `state` |
| POST | `/sessions` | 新建会话并发送第一条消息 `{ text, attachments?, cwd?, model?, effort?, permissionMode? }` → `{ sessionId }`；`cwd` 是会话的文件夹，`model` 是模型列表里的 value |
| GET | `/sessions/:id/messages` | 历史消息 |
| POST | `/sessions/:id/messages` | 发送消息 `{ text, attachments? }`（文字和附件至少有一样）；会话不活跃时自动 resume |
| POST | `/uploads` | 上传附件（multipart，可多个）→ `{ attachments: [{ id, name, path, size }] }` |
| GET | `/folders?path=` | 网关机器上一个文件夹里的子文件夹 `{ path, parent, home, entries }`，不传 path 是主目录，支持 `~` |
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
| PATCH | `/skills/:name` | 启用、停用技能：`{ enabled }` |
| DELETE | `/skills/:name`、`/plugins/:name` | 删除导入的技能、插件和它们的文件 |
| PUT | `/mcp-servers/:name` | 添加 MCP 服务器，同名覆盖（stdio：`command`、`args`、`env`；http / sse：`url`、`headers`） |
| PATCH | `/mcp-servers/:name` | 启用、停用 `{ enabled }` |
| DELETE | `/mcp-servers/:name` | 删除 |
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
2. **对话体验**：Markdown 和代码高亮、diff 展示（Edit / Write 的入参）、思考块、AskUserQuestion 选择题、斜杠命令（`supportedCommands()`）、模型切换（`setModel()`）、上下文用量（`getContextUsage()`）。
3. **自定义工具**（`createSdkMcpServer()` 进程内 MCP）：内置浏览器（复用 codex-app-server 的 CDP 方案，或直接挂 `@playwright/mcp`；DeepSeek 不看图时用无障碍树快照，不用截图 + 坐标）、终端读取、会话管理。
4. **多人部署**：沿用 codex-app-server 的 hub + 每用户一个容器，每个容器一个 `CLAUDE_CONFIG_DIR`。
5. **桌面版**：Electron 外壳。

## 10. 风险

- **许可**：Agent SDK 和 Claude Code 二进制都是 Anthropic 专有许可（"All rights reserved"），使用受 Anthropic 条款约束，官方文档没有专门说明能否配第三方模型。自用风险低；对外收费或多人统一出 key 之前，需要跟 Anthropic 确认。详见 <https://code.claude.com/docs/en/legal-and-compliance>。
- **引擎不可控**：二进制随 SDK 版本更新，行为、协议、对第三方 base URL 的支持都可能变。锁定 SDK 版本，升级前在测试环境验证。
- **一会话一进程**：每个活跃会话一个 Node 子进程（约 100–200 MB），靠空闲回收和并发上限（`MAX_ACTIVE_SESSIONS`）控制。

## 11. 对话日志

网关把用户的原始内容和模型的实际响应写到 `gateway/.data/logs/`（`LOG_DIR`），排查问题用，和 Fastify 的运行日志分开，实现在 `gateway/src/logging/conversation-log.ts`。

- **格式**：每行一条 JSON，`{ time, sessionId, event }`，`event` 就是发给网页的事件（SDK 消息原样）。文件名 `conversation-日期[.序号].jsonl`，日期按网关本机时区，`time` 是 UTC。
- **记什么**：`user_message`、SDK 的 `assistant`（含思考和工具调用）、`user`（工具结果）、`result`、权限请求和回复、错误，以及 `api_retry`、`compact_boundary`、`task_notification` 等排查用得上的 system 消息。`stream_event` 是同一份内容的逐字片段，不记。
- **图片**：消息里的 base64 内容（`source.type` 是 `base64`）存成 `images/<内容哈希>.<扩展名>`，同一张图只存一份；日志里的 `source` 换成 `{ type: "file", media_type, file }`，`file` 是绝对路径。`tool_use_result` 里同样内容的副本只留长度。
- **不是 HTTP 抓包**：记录的是 SDK 交给网关的消息，不包含 Claude Code 发给模型接口的完整请求（系统提示、工具定义）和请求头，接口密钥不会写入。
- **限制**：单文件 `LOG_MAX_FILE_MB`（默认 20），超过换下一个序号；总量 `LOG_MAX_TOTAL_MB`（默认 500，含图片），超过从最旧的文件删；保留 `LOG_RETENTION_DAYS` 天（默认 14，图片再次出现时重新计时）；单条 `LOG_MAX_ENTRY_KB`（默认 512），超过只留开头一段并标 `truncated`。启动时、每小时、换文件时清理。`LOG_ENABLED=0` 关闭。
- **隐私**：日志里有完整的对话和工具输出，文件权限 600。删除会话不会删日志，要等保留期到期或手动删。写失败只记运行日志，不影响会话。
