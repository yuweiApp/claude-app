# MCP Apps

MCP Apps（SEP-1865，规范 `ext-apps/specification/2026-01-26/apps.mdx`，状态 Stable）让 MCP 服务器给工具配一个界面：工具在 `_meta.ui.resourceUri` 里声明一个 `ui://` 资源（一段 HTML），宿主调用这个工具时把界面渲染在对话里，界面和宿主经 `postMessage` 用 JSON-RPC 通信，可以收到工具的参数和结果，也能自己调用同一个服务器的工具、往对话里发消息。

这里的宿主是网关加网页：网关负责和 MCP 服务器打交道（经 Claude Code），网页负责渲染和桥接。

## 1. 现状

- 本项目：第 1、2 期已经做了（第 5 节），`config.yml` 的 `mcpApps.enabled` 默认关。关着时声明了界面的工具显示成普通工具调用，网关也不开沙箱代理的端口。
- SDK 0.3.331 / 自带的 CLI 已经有宿主要用的东西：

| 能力 | 怎么用 | 说明 |
| --- | --- | --- |
| 向 MCP 服务器声明支持 | 子进程环境变量 `CLAUDE_CODE_MCP_APPS_HOST=1` | 设了之后 CLI 在 MCP `initialize` 里带 `capabilities.extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }`（实测服务器收到了；不设时没有）。很多服务器看到这个才注册带界面的工具。类型声明里没写，是从 CLI 二进制里读出来的 |
| 工具的 `_meta.ui` | `Query.mcpServerStatus()` 的 `tools[]._meta` | 能力标记 `mcp_tool_ui_meta_v1`。只留 `ui`（`resourceUri`、`visibility`）和旧的 `ui/resourceUri`，其余 `_meta` 键都过滤掉（实测如此；不设 `CLAUDE_CODE_MCP_APPS_HOST` 时也有）。`tools[]` 里没有 `description` |
| 读界面资源 | `Query.readMcpResource(server, uri)`（`@alpha`） | 能力标记 `mcp_read_resource_v1`。只收 `ui://`，返回 `contents[]`（`text` / `blob`、`mimeType`、资源自己的 `_meta`，里面有 `ui.csp`、`ui.permissions`） |
| 界面调工具 | 控制请求 `{ subtype: "mcp_call", tool, arguments, result_not_for_model, check_permissions, soft_error_result }` | 能力标记 `mcp_call_result_not_for_model_v1`、`mcp_call_check_permissions_v1`、`mcp_call_soft_error_result_v1`。`Query` 上没有公开方法，运行时的 `query.request(req)` 能发（同 `cancelAsyncMessage` 的写法），回的是 `{ subtype: "success", response: { content, structuredContent, _meta } }`。结果不进模型上下文；`check_permissions` 让它照模型自己调用一样走权限规则和钩子，要确认时走 `canUseTool`，网页上就是现有的权限卡片。**不管 `visibility`**：实测 `visibility: ["model"]` 的工具也能调成功，所以网关自己拦。服务器收到的 `_meta["claudecode/toolUseId"]` 是 `toolu_mcp_call_…` |

限制：SDK 类型（进程内）的 MCP 服务器不能用 `readMcpResource` 和 `mcp_call`，网关自带的服务器（浏览器、终端、桌面、visualize）都是这种，不过它们本来也没有界面，不受影响。

- 官方 SDK `@modelcontextprotocol/ext-apps`（MIT）的 `app-bridge` 入口是宿主这边的协议实现：`AppBridge`（初始化握手、版本协商、消息校验、推参数和结果、取消、卸载、宿主上下文、显示模式，界面的调工具、读资源、发消息、开链接等请求交给宿主挂的处理函数）、`PostMessageTransport`、`buildAllowAttribute`。网页用它，不自己实现协议（见 2.3 节）。两层沙箱里宿主和代理之间的两条消息 SDK 也有（`onsandboxready`、`sendSandboxResourceReady`），代理页本身和按声明生成 CSP 不在 npm 包里，官方仓库的 `examples/basic-host` 有现成代码（见 5.1 节）。

## 2. 方案

### 2.1 开关

`config.yml` 加一项（暂定 `mcpApps.enabled`，默认关）。打开时网关给子进程设 `CLAUDE_CODE_MCP_APPS_HOST=1`。关着时完全是现在的行为，以下所有路径都不走。

### 2.2 网关

新目录 `gateway/src/mcp-apps/`，不改已有模块的逻辑，只在入口处挂上：

1. **工具表**：会话的子进程起来、MCP 服务器状态变化（重连、`reloadPlugins`）后，取一次 `mcpServerStatus()`，整理成 `工具全名 → { server, resourceUri, visibility }`（全名按 CLI 的规则规范化：非 `[a-zA-Z0-9_-]` 换成 `_`）。以状态类事件 `mcp_apps` 发给网页（同 `context`，只在变化时发，回放挤掉了补发）。
2. **读资源**：`GET /sessions/:id/mcp-apps/resource?server=&uri=` → `readMcpResource`。检查 `mimeType` 是 `text/html;profile=mcp-app`，`blob` 解成文字，连同 `_meta.ui`（`csp`、`permissions`、`prefersBorder`）返回。按 `(server, uri)` 在会话里缓存，服务器重连时清掉。
3. **界面调工具**：`POST /sessions/:id/mcp-apps/call`，参数 `{ toolUseId, tool, arguments }`：
   - 网关按 `toolUseId` 找到这个界面属于哪个服务器，被调的工具必须在**同一个服务器**上，并且 `visibility` 含 `app`（没声明 `visibility` 按规范默认 `["model","app"]`），不满足就直接拒绝；
   - 通过后发 `mcp_call`，带 `result_not_for_model: true`、`check_permissions: true`、`soft_error_result: true`，结果原样返回网页。
4. **界面要读的其他资源**（`resources/read`）：同样只收同一个服务器的 `ui://`。

### 2.3 网页

新组件 `McpAppView`（不改 `Widget`），和界面之间的协议全交给官方 SDK 的 `AppBridge`（构造时 MCP 客户端传 `null`，界面的请求由下面挂的处理函数接）：

- **认出来**：`toUnits` 里多一种单元 `mcp_app`：`tool_use` 的名字在 `mcp_apps` 工具表里、并且有 `resourceUri` 的，单独一个单元，像部件一样不折叠进过程。调用出错的退回成过程里的一步（同部件）。
- **沙箱**：规范要求网页宿主用**两层 iframe**：外层是另一个源上的沙箱代理（`allow-scripts allow-same-origin`），由它按声明的 CSP 再套一层装界面。原因是界面需要一个真实的源：单层 `srcdoc` 加不给 `allow-same-origin` 的话源是 `null`，界面 `fetch` 它声明的 `connectDomains` 时 CORS 大多不过，`localStorage` 也用不了。做法（`gateway/src/mcp-apps/sandbox.ts`，代码照搬官方示例，见 5.1 节）：
  - 网关另开一个端口 `MCP_APPS_SANDBOX_PORT`（默认 8791；8789、8790 是局域网分享和公网分享的入口）只提供代理页，和网页不同源。平时监听 `HOST`（默认 127.0.0.1），局域网分享开着时改成 0.0.0.0（`LanServer.onSynced` 跟着调整），分享停了改回来。端口被占用时只记日志。
  - `/config` 的 `mcpAppsSandboxPort` 告诉网页端口，网页按自己的主机名拼地址（本机 `localhost:8791`，局域网访客 `<局域网地址>:8791`）。没开、没监听上、或者是公网分享的访客时是 `null`（局域网入口转发时带上 `x-share-scope`，网关据此判断）。
  - 公网分享只经 SSH 转了一个端口，访客和 `null` 的情况一样**退回单层** `srcdoc`（不给 `allow-same-origin`），CSP 用 `<meta>`。网页不是 `http:` 时也退回单层（`http` 的代理页会被当成混合内容拦下）。
  - 代理页只认本项目网页（`SHARE_CLIENT_URL` 的端口）和局域网分享入口（`SHARE_PORT`）嵌入它，主机名要和代理页的一样（都是本机地址的算一样）。
- **CSP**：网关按资源的 `_meta.ui.csp` 生成（`buildCsp`，规则同官方示例的 `buildCspHeader`：`connectDomains` → `connect-src`；`resourceDomains` → `script-src`、`style-src`、`img-src`、`font-src`、`media-src`、`worker-src`；`frameDomains` → `frame-src`，没给是 `'none'`；`baseUriDomains` → `base-uri`，没给是 `'none'`；另外固定给 `'unsafe-inline'`、`'unsafe-eval'`、`blob:`、`data:`，`object-src 'none'`；含分号、引号、空格的地址去掉）。两层时是代理页的 HTTP 头（地址里的 `?csp=`），单层时网页把资源接口返回的 `cspPolicy` 以 `<meta http-equiv>` 插在 `<head>` 最前面。`permissions` 对应 iframe 的 `allow`（camera、microphone、geolocation、clipboard-write），外层 iframe 和代理页建的内层都给。
- **桥**（`AppBridge` + `PostMessageTransport`，网页这边只挂处理函数、在合适的时候调 `sendToolInput` / `sendToolResult` 等）：

| 方向 | 方法 | 处理 |
| --- | --- | --- |
| 界面 → 宿主 | `ui/initialize` | 回 `protocolVersion`、`hostInfo`、`hostCapabilities`、`hostContext`（`theme`、`styles.variables` 用本项目主题变量映射到规范里的 `--color-*`、`--font-*`、`--border-radius-*`，`displayMode: "inline"`、`availableDisplayModes`、`containerDimensions: { maxWidth }`、`locale`、`timeZone`、`platform`；不给 `toolInfo`，见第 4 节） |
| 界面 → 宿主 | `ui/notifications/initialized` | 之后才开始发下面的通知（规范：收到这个之前宿主不能发任何东西） |
| 宿主 → 界面 | `ui/notifications/tool-input-partial` | 模型还在写参数时（`stream_event` 的 `input_json_delta` 记进 `streaming.app`，同部件生成期间的做法），用 `partial-json` 解析出能取到的部分参数。参数完整前界面就先显示，和完整后的单元用同一个 key（`app:工具调用 id`），React 沿用同一个界面，不重新加载 |
| 宿主 → 界面 | `ui/notifications/tool-input` | 参数完整后发一次 |
| 宿主 → 界面 | `ui/notifications/tool-result` | 工具结果到了；历史里已有结果的，初始化完直接依次发 input 和 result |
| 宿主 → 界面 | `ui/notifications/tool-cancelled` | 工具结果是出错的（被拒绝、被中断、执行出错），`reason` 是出错的文字。界面照样显示（不再退回成过程里的一步），出错原因写在界面下面 |
| 宿主 → 界面 | `ui/notifications/host-context-changed` | 主题、皮肤、宽度变了 |
| 宿主 → 界面 | `ui/resource-teardown` | 卸载前（切走会话、单元被移除），最多等一小会儿 |
| 界面 → 宿主 | `tools/call`、`resources/read` | 转给网关（2.2 节第 3、4 条） |
| 界面 → 宿主 | `ui/message` | 以用户身份发一条消息，同部件的 `sendPrompt`（一轮进行中时排队） |
| 界面 → 宿主 | `ui/open-link` | 同回复里的链接（`FileLinkContext.openUrl`） |
| 界面 → 宿主 | `ui/notifications/size-changed` | 设 iframe 高度，复用部件那套防止无限变高的处理 |
| 界面 → 宿主 | `ui/update-model-context` | `POST /sessions/:id/mcp-apps/context`：网关按工具调用记最后一份（只取 text 块和 `structuredContent`，两样都空就删掉），下一条用户消息（包括界面的 `ui/message`）发出时，每份拼成一段 `<mcp-app-context server tool tool_use_id>` 文字块放在消息最前面交给模型，之后清掉。网页显示用户消息时按标签去掉这一段。记在会话对象里，子进程回收后就没了 |
| 界面 → 宿主 | `ui/request-display-mode` | 一期只支持 `inline`，回当前模式；以后再加全屏（右侧面板） |
| 界面 → 宿主 | `notifications/message` | 记日志，不显示 |
| 界面 → 宿主 | `ping` | 回 `{}` |

- **刷新、恢复会话、分享页**：界面资源按 `tool_use` 的名字重新读，参数和结果来自会话记录，重新显示（界面里的操作状态不保留，同部件）。

### 2.4 工具结果给界面的那份

`tool-result` 要的是 MCP 的 `CallToolResult`（`content`、`structuredContent`、`_meta`）。SDK 消息里的 `tool_result` 是 Claude Code 处理过、给模型看的版本（实测：有 `structuredContent` 时交给模型的文字是它的 JSON，服务器自己的 `content` 文字没给模型）。原始的从这两处取：

- 实时：user 消息上的 `tool_use_result` 是 `{ content, structuredContent, _meta }`（实测有）。网页按 tool_use id 记进 `SessionView.toolRaw`。
- 历史：`getSessionMessages` 不返回它，但会话文件里那一行有 `mcpMeta: { structuredContent, _meta }`。网关读历史时补成消息上的 `mcp_meta`（`agent/history.ts`，只在开了 `mcpApps` 时），网页一样记进 `toolRaw`。

交给界面的是 `{ content: [{ type: "text", text: tool_result 的文字 }], structuredContent, _meta }`，服务器原来的 `content` 没处取，只能用给模型的那份文字。

## 3. 会影响到已有逻辑的地方（需要确认）

开关打开后，下面这些不是新路径能隔开的：

1. **MCP 服务器看到的能力变了**：设了 `CLAUDE_CODE_MCP_APPS_HOST` 后，所有外部 MCP 服务器都会看到宿主支持 MCP Apps，有的会多注册工具、或者工具描述和返回内容变了，模型看到的工具列表会跟着变。
2. **带界面的工具不再自动转后台**：CLI 里看到，开了这个开关时声明了 `_meta.ui` 的工具调用不按 `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`（现在 20 秒）转后台。
3. **CLI 的工具列表缓存按开关分开**：缓存键里带了这一项，切换开关后第一次连接要重新拉。
4. **只给界面用的工具（`visibility: ["app"]`）**：实测 CLI 已经不把它交给模型（`system/init` 的 `tools` 里没有），网关不用处理。
5. **对话渲染**：`toUnits` 多一种单元，只对在工具表里、并且有 `resourceUri` 的工具生效，其余工具调用的显示不变。
6. **历史消息**：开了 `mcpApps` 时，网关读历史给 MCP 工具结果的消息多带一个 `mcp_meta` 字段（2.4 节），其余不变。
7. **多监听一个端口**（第 2 期）：开了 `mcpApps` 时网关监听 `MCP_APPS_SANDBOX_PORT`（默认 8791），只提供静态的代理页；局域网分享开着时这个端口对局域网开放。局域网入口转发给网关的请求多带一个 `x-share-scope` 头。
8. **用户消息的内容**（第 2 期）：界面调用过 `ui/update-model-context` 后，下一条用户消息交给模型时前面多一段 `<mcp-app-context>`，会话记录里也有，网页不显示。
9. **网页依赖**（第 2 期）：`partial-json` 0.1.7（MIT，没有依赖），解析模型还没写完的参数。

## 4. 实测结果（2026-11-25，SDK 0.3.331）

用一个自己写的测试服务器（一个带界面的工具 `show_counter`、一个 `visibility: ["app"]` 的 `increment`、一个 `visibility: ["model"]` 的 `model_only`，资源声明了 `csp`），先用脚本直接调 SDK，再在网关和网页里跑真实会话（gpt-6-luna）：

| 项 | 结果 |
| --- | --- |
| 扩展声明 | 设了 `CLAUDE_CODE_MCP_APPS_HOST=1` 服务器收到 `extensions["io.modelcontextprotocol/ui"]`，不设没有 |
| 工具的 `_meta.ui` | 原样有 `ui.resourceUri`、`ui.visibility`、`ui/resourceUri`，自定义键被过滤 |
| `readMcpResource` | 返回 `text`、`mimeType`、资源的 `_meta.ui`（`csp`、`prefersBorder`） |
| `mcp_call` | 见第 1 节；不检查 `visibility`，网关拦下 `model_only` 返回 403 |
| 只给界面的工具 | 不在模型的工具列表里 |
| `tool_use_result` | 实时有 `structuredContent`、`_meta`；历史从会话文件的 `mcpMeta` 补（2.4 节） |
| 网页 | 界面显示、`ui/initialize`、`tool-input`、`tool-result`、`size-changed`、`tools/call`（`increment` 成功、`model_only` 被拒）、`ui/message`（发出消息、模型回复）、`ui/open-link` 都通；网关重启后打开历史会话，网页取工具表（网关 resume 子进程）后照样显示，`structuredContent` 也在 |

### 真实的第三方服务器

用 MCP 官方的示例服务器（npm 上的 `@modelcontextprotocol/server-basic-vanillajs`、`@modelcontextprotocol/server-map`，2.0.4，界面用官方 SDK `@modelcontextprotocol/ext-apps` 2.0.4 写的）：

- **初始化结果要过官方 SDK 的校验**：一开始界面一直停在初始化。原因是 `hostContext.toolInfo.tool` 在 SDK 的 schema 里是完整的 MCP `Tool`，必须有 `inputSchema`，网关的工具表（`mcpServerStatus()` 的 `tools[]` 里没有 `inputSchema`）只给得出 `name`，校验不过，SDK 就不发 `ui/notifications/initialized`。现在不给 `toolInfo`（它是选填的）。其余字段用 SDK 导出的 `McpUiInitializeResultSchema` 校验过。之后协议换成了 SDK 自己的 `AppBridge`（见第 5 节），基础版和自己的测试服务器重新跑过一遍：初始化、界面调工具、发消息、日志、开链接、调只给模型用的工具被拒（界面收到 JSON-RPC 错误 -32603，带网关的原因）都通。
- **基础版（`get-time`）**：界面显示工具结果里的时间；界面里「Get Server Time」（`tools/call`，带 `_meta.progressToken`）、「Send Message」（`ui/message`，`content` 是数组）、「Send Log」（`notifications/message`）、「Open Link」（`ui/open-link`）都通。
- **地图版（`show-map`，CesiumJS 三维地球）**：资源声明了 `connectDomains`、`resourceDomains`（`*.openstreetmap.org`、`cesium.com`、`*.cesium.com`），CSP 按它拼，CesiumJS 能从 `cesium.com` 加载（`null` 源不影响 `<script>`）。之后创建 WebGL 失败，界面在连上宿主之前就停了，一直显示「正在加载」。这是开发机的浏览器面板本身没有 WebGL（`getContext("webgl")` 也是 null，Linux 开发机没有 GPU），不是 CSP 的问题，要在 Windows / macOS 上再看。另外 CSP 拦下了几次 `eval` 和 `wasm-eval`：规范的 CSP 里没有 `'unsafe-eval'`、`'wasm-unsafe-eval'`，这里也没加；官方 `examples/basic-host` 的 CSP 加了 `'unsafe-eval'`、`blob:` 和 `worker-src`（注释说是给 CesiumJS、Three.js 这类用 worker 的库），第 2 期照它来（5.1 节）。
- 界面在连上宿主之前出错时（上面这种），宿主一直显示「正在加载」，没有超时，也看不到界面里的报错。

没测到的：`check_permissions` 要确认时的权限卡片（测试会话是完全访问权限）、深色主题下的样式变量、地图版在有 WebGL 的环境里的显示。

### 第 2 期（2026-11-25）

开发机上用自己的测试服务器（加了 `ui/update-model-context`、`localStorage` 的按钮，显示界面自己的源和收到的通知）和官方示例：

| 项 | 结果 |
| --- | --- |
| 两层沙箱 | 界面的源是 `http://localhost:8791`（代理页的），`localStorage` 能用；代理页的 CSP 头按声明生成；官方基础版在两层里初始化、调工具都通；地图版不再报 CSP 拦下 `eval`，只剩 WebGL 创建失败（开发机的问题，见上） |
| 部分参数 | 模型写约 300 字的参数期间界面收到 12 次 `tool-input-partial`，之后依次是 `tool-input`、`tool-result`，界面没有重新加载 |
| 取消 | 权限改成默认、在权限卡片上拒绝：界面收到 `tool-cancelled`（`reason` 是「用户拒绝了这次操作」），界面下面显示出错原因 |
| 给模型的内容 | 界面更新后发下一条消息，会话记录里用户消息前面有 `<mcp-app-context>`，模型答出了界面给的暗号；网页上的用户消息不显示这一段 |
| 局域网分享 | 开分享后代理页改成监听 0.0.0.0，访客经 `127.0.0.1:8789/share/…` 打开，`/config` 给了 8791，界面的源是 `http://127.0.0.1:8791`，访客在界面里调工具成功；停分享后改回 127.0.0.1 |
| 单层退回 | 代理端口被占用时 `/config` 给 `null`，界面用 `srcdoc`、`<meta>` 里是同一份 CSP，官方基础版照常能用；带 `x-share-scope: public` 请求 `/config` 也是 `null` |
| 初始化超时 | 地图版 20 秒没完成初始化，「正在加载」换成提示 |

没测到的：公网分享的访客实际打开（只测了 `/config`）、Windows / macOS 上的桌面版。

## 5. 分期

1. **验证**（已做，第 2 期又改了一部分，以 2.3 节为准）：开关（`config-file.ts`、`config.ts` 的 `agentEnv`）；网关 `mcp-apps/apps.ts`、会话的 `mcpAppTools` / `mcpAppResource` / `mcpAppCall`、`mcp_apps` 事件（状态类）、`/sessions/:id/mcp-apps/{tools,resource,call}`；网页 `McpAppView.tsx`（单层 `srcdoc`，不给 `allow-same-origin`，源是 `null`；iframe 的 `allow` 用 `buildAllowAttribute` 按资源的 `permissions` 生成）。协议用 `@modelcontextprotocol/ext-apps` 2.1.0 的 `AppBridge`（网页的依赖，连同它要求的 `@modelcontextprotocol/client`、`@modelcontextprotocol/core` 2.4.0 和 `zod` 4.6.7，都写死版本）：挂了 `oninitialized`（发 `tool-input`，有结果就发 `tool-result`）、`onsizechange`、`oncalltool`（经网关）、`onmessage`（同部件的 `sendPrompt`）、`onopenlink`、`onrequestdisplaymode`（只回 `inline`）、`onloggingmessage`；主题和宽度变了 `setHostContext`；卸载时 `teardownResource` 后 `close`。没挂处理函数的请求（`ui/update-model-context`、`resources/read`、`ui/download-file` 等）由 SDK 回「方法不存在」。还没有：`tool-input-partial`、`tool-cancelled`，分享页（`ShareApp`）不显示界面。
2. **完整的一期**（已做）：沙箱代理端口（`mcp-apps/sandbox.ts`）、`ui/update-model-context`（`mcp-apps/context` 接口、`Session.mcpAppContext`）、`tool-input-partial`、`tool-cancelled`、分享页显示（访客页用的是同一个 `Chat`，局域网访客两层、公网访客单层）。另外界面 20 秒没完成初始化时提示。每一项用哪个现成的实现见 5.1 节。
3. **以后**：全屏和画中画（右侧面板）、`permissions`（摄像头、麦克风）、SSH 远程会话、公网分享的访客也用两层（SSH 再转一个端口）。

### 5.1 第 2 期用到的现成实现（2026-11-25 查）

| 项 | 现成的 | 自己写的 |
| --- | --- | --- |
| 两层沙箱代理（已做） | 协议：`AppBridge` 的 `onsandboxready`（收 `ui/notifications/sandbox-proxy-ready`）、`sendSandboxResourceReady`（发 `ui/notifications/sandbox-resource-ready`，带 `html`、`csp`、`permissions`）。代理页：官方仓库 `examples/basic-host/src/sandbox.ts`（约 140 行）和 `sandbox.html`。CSP：同目录 `serve.ts` 的 `sanitizeCspDomains`、`buildCspHeader` | 网关另开端口提供代理页和 CSP 头；把示例代码搬进来，按本项目改（下面） |
| `ui/update-model-context` | `AppBridge.onupdatemodelcontext`（官方示例里挂了，`hostCapabilities` 声明 `updateModelContext`） | 交给 Claude Code：按 2.3 节，网关记最后一份，下一条用户消息发出时附上。官方 SDK 管不到 Claude Code 这一侧 |
| `ui/notifications/tool-input-partial` | `AppBridge.sendToolInputPartial`；不完整的 JSON 用 `partial-json`（npm，0.1.7，MIT，无依赖）解析 | 从 `stream_event` 的 `input_json_delta` 拼参数（`session.ts` 里部件生成期间已经在拼），解析后推给界面。部件的 `partialLoadingMessages` 只取 `loading_messages`，不通用，不复用 |
| `ui/notifications/tool-cancelled` | `AppBridge.sendToolCancelled`（官方示例在调用失败时发） | 一轮被中断、工具被拒绝或出错时调用 |
| 分享页显示界面 | 无 | 本项目的功能：`ShareApp` 里复用 `McpAppView`，读资源、调工具走分享的接口 |

**官方代理页的做法**：

- 代理页在另一个端口（示例是 8081，网页 8080），`sandbox="allow-scripts allow-same-origin"`。CSP 由服务器按地址里的 `?csp=`（资源 `_meta.ui.csp` 的 JSON）设成 HTTP 头，不用 `<meta>`（界面改不了），并且不缓存。
- 代理页里再建内层 iframe（`allow-scripts allow-same-origin allow-forms`，宿主可以在 `sandbox-resource-ready` 里改），`allow` 用 `buildAllowAttribute(permissions)`。界面 HTML 用 `document.write` 写进去，不用 `srcdoc`（注释说 CesiumJS 在 `srcdoc` 里不能用），所以界面的源和 CSP 都是代理页的。
- 自检：不在 iframe 里、没有 `referrer`、`referrer` 不是允许的地址时直接报错；能访问到 `window.top` 说明隔离没生效，也报错。
- 转发：父窗口来的消息检查来源是不是 `referrer` 的源，内层来的检查是不是自己的源；发回父窗口时指定源，不用 `*`。

**搬过来要改的**：

- 允许嵌入的地址：示例只认 `localhost` / `127.0.0.1`，要加上局域网分享的地址、桌面版加载网页用的地址。
- CSP 规则比我们现在的宽：`default-src 'self' 'unsafe-inline'`，`script-src` 多了 `'unsafe-eval' blob: data:`，`style-src`、`img-src`、`font-src`、`media-src` 多了 `blob: data:`，多了 `worker-src 'self' blob:`，`base-uri` 没声明时是 `'none'`。照它来，替换 `McpAppView.tsx` 里的 `buildCsp`。
- 代理页的源：网关的端口 `MCP_APPS_SANDBOX_PORT`（默认 8791），局域网分享时这个端口也对外（见 2.3 节）；公网分享的访客退回单层。
- 许可证：官方仓库正在从 MIT 换到 Apache-2.0（新代码是 Apache-2.0，部分旧代码还是 MIT），搬过来的文件开头注明出处和许可证。

**看过没用的**：`@mcp-ui/client`（7.1.1，Apache-2.0）的 `AppRenderer` 是包好的 React 组件，但代理页仍要自己托管，而且它依赖 `@modelcontextprotocol/ext-apps` ^1.2、`@modelcontextprotocol/sdk` 1.x、`zod` 3，和这里的 2.1.0、`zod` 4 对不上。
