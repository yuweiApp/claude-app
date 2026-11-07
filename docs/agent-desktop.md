# 桌面操作（agent-desktop）设计

> 状态：网关部分（第 13 节的 1–3 步）已实现，默认关（`config.yml` 的 `desktop.enabled`）；界面（第 4 步）和 Windows、macOS 实测（第 5 步）没做。全部做完后并进 [README.md](README.md) 作为第 14 节，这个文件删掉。
>
> 依据：agent-desktop 1.2.0 在本机（Ubuntu 24.04 + XFCE / X11）的实测；Windows、macOS 的部分来自 agent-desktop 编进二进制的平台说明（`skills get agent-desktop-windows` / `agent-desktop-macos`）和[官方文档](https://agent-browser.dev/desktop)，**没有实测**。主要平台是 Windows 和 macOS，Linux 能用就用、不保证。

## 1. 目标和范围

让模型操作**网关所在那台电脑**上的原生应用（记事本、Finder / 资源管理器、系统对话框、Office、各种 Electron 应用的原生部分）。[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) 读系统的无障碍树（macOS 是 AX API，Windows 是 UI Automation，Linux 是 AT-SPI），给出带 ref 的元素，按 ref 操作，不靠截图识别。

- 网页还是第 12 节（内置浏览器）、第 13 节（用户的 Chrome）的事。agent-desktop 自己也不操作网页内容（它对 Chromium 应用的办法是 `launch --cdp` 后交给别的工具），第一版不开放 `--cdp`。
- 不做：桌面画面的实时面板、录屏、多台电脑。

## 2. 为什么不直接挂 `agent-desktop mcp`

设置页现在就能把 `agent-desktop mcp` 当 stdio MCP 服务器加上（方案 A），实测不合适：

| | `agent-desktop mcp`（实测） | 本方案 |
|---|---|---|
| 工具数 / 定义大小 | 67 个，约 41000 字符（两个浏览器现在一共约 5000） | 3 个，可常驻 |
| 只读标记 | 一个都没有，读和写分不开，只能全部弹卡片或全部放行 | 只读的放行，有副作用的走卡片 |
| 说明 | 第一句是「先读 desktop_skills_get」，skill 里是做法和步骤 | 只写事实（CLAUDE.md 的约定） |
| `--headed`、`--session` | 启动时定死，所有调用共用 | 每次调用单独定 |
| 截图 | base64 放在 JSON 文字里，模型看到的是一长串字符 | 转成 MCP 图片 |
| 本应用的窗口 | 能读能点（见 6.1） | 网关拦掉 |

最后一行是决定性的：只有命令经过网关，才拦得住。

## 3. 结构

```
claude 子进程 ──进程内 MCP──▶ 网关 desktop 服务器 ──execFile，每次调用一个进程──▶ agent-desktop ──▶ 系统无障碍接口
                               │  guard：拦本应用的窗口、拦受管的参数
                               └─ 快照缓存：snapshot id → 应用、pid、窗口、元素（给 guard 和权限卡片用）
```

新目录 `gateway/src/desktop/`（另有 `commands.ts`：命令分类、拒绝的命令和参数、从参数里取 ref / 坐标 / `--app`）：

- `cli.ts`：找二进制、拼参数（加 `--session`、按需加 `--headed`）、`execFile`、解析 JSON 结果、超时和中断时杀进程。环境变量 `AGENT_DESKTOP_HOME` 设成 `gateway/.data/agent-desktop`（实测有效；要真实路径，带 `..` 会报 `private file parent must not contain parent traversal`；目录权限 700），不碰 `~/.agent-desktop`，同 `CLAUDE_CONFIG_DIR` 的做法。
- `guard.ts`：见第 6 节。
- `render.ts`：快照 JSON 转成缩进文本。
- `tool.ts`：`createSdkMcpServer`，写法同 `browser/tool.ts`（`alwaysLoad` 标记、`rememberResult` 给转后台的调用留结果）。

**每次起一个进程**，不常驻 `agent-desktop mcp`，也不用它的 C 库（`libagent_desktop_ffi`）：实测一次 0.1 秒左右（`status` 0.13 秒；`type` 1 秒，大部分是它自己的等待和校验），够用；全局参数能每次不同；卡住或崩溃只影响这一次调用。多个进程同时操作时，agent-desktop 自己有跨进程的「交互租约」排队（结果里的 `lease_contention_count`），网关不另加锁。

## 4. 工具

服务器名 `desktop`，工具全名 `mcp__desktop__snapshot` 这样（不再加 `desktop_` 前缀，理由同第 12 节不把服务器叫 `browser`）。

| 工具 | 对应命令 | 确认 |
|---|---|---|
| `snapshot` | `snapshot`，默认 `-i` | 不用（`allowedTools`） |
| `screenshot` | `screenshot` | 不用（`allowedTools`） |
| `run` | 其余命令，`args[0]` 是命令名 | 只读命令不用，其余走卡片（`canUseTool` 里按 `args[0]` 判断） |

### snapshot

参数：`app`、`window_id`、`root`（从某个 ref 往下）、`skeleton`、`max_depth`（上游最大 50）、`interactive_only`（默认 true）、`timeout_ms`（上游默认 3000；Windows 上 Electron 应用第一次读要等 10–25 秒才完整）。

结果转成文本，格式向 `browser_snapshot` 靠：

```
snapshot s191jb6hk0gciz（mousepad，窗口 w-1.1895-…）
- window "test.txt - Mousepad"
  - menu "File" [ref=@s191jb6hk0gciz:e2] (offscreen)
    - menuitem "Save" [ref=@s191jb6hk0gciz:e9] (disabled, offscreen)
  - textfield [ref=@s191jb6hk0gciz:e269] (focused) 可用：SetValue, TypeText, SetFocus: "hello\n"
```

- 没名字、没 ref 的 `group` 展开不显示（Chromium 应用里有很长的一串）。
- ref 写全（`@快照:eN`）：上游拒绝裸的 `@e9`，网关也不替模型补，免得两个快照的 ref 混淆。
- 有 ref 的元素后面带 `可用：Click, Select`（`available_actions`，决定哪些命令能用）；没有名字时才带描述（有名字的菜单项多半还有一句描述，全带上大一截）。
- 实测 Mousepad（271 个 ref，多数是没展开的菜单项）：JSON 46.6KB → 文本 21.4KB。

### screenshot

参数：`app`、`window_id`、`screen`（至少一个）。网关让 agent-desktop 把 PNG 存到临时目录、读出来转成 MCP 图片，再删掉（不解析它 JSON 里的 base64）。

- 上游行为（实测）：窗口被别的窗口挡住时拒绝截图（`reason: covered`），不会把挡在上面的内容截进来。
- macOS 要「屏幕录制」权限。
- 图片太大：原始大小超过 3.75MB（base64 后 5MB，模型接口的单张上限）时不返回图片，报大小和上限。缩小见第 12 节待定问题。

### run

参数：`args: string[]`（命令和它的参数，不含受管的全局参数）、`headed?: boolean`、`timeout_ms?`。

- 描述写事实：执行一条 agent-desktop 命令，返回它的 JSON 结果；`["<命令>", "--help"]` 返回这条命令的参数说明。说明（`instructions`）里列出命令名，每个一句，取自上游的 `--help`。参数说明本来就是「接口」，让模型自己用 `--help` 查，不在工具定义里重抄 67 个命令的参数。
- **不用确认的只读命令**：`find`、`get`、`is`、`list-apps`、`list-windows`、`list-displays`、`list-surfaces`、`list-notifications`、`wait`、`status`、`permissions`（不带 `--request` / `--guide`）、`version`、`skills`，以及任何命令的 `--help`。
- **走卡片的**：其余所有命令，`clipboard-get` 也算（只读，但剪贴板里常有密码、验证码）。
- **网关拒绝的**：
  - 命令：`mcp`、`session`、`trace`、`batch`（第一版：要逐条检查里面的命令，以后再开）。
  - 全局参数：`--session`、`--agent-id`、`--trace`、`--trace-strict`、`--screenshot`、`--debug`（受管或会写文件），`--headed` 只能经 `headed` 参数（卡片上要单独显示）。
  - `--force`：上游拿它放行 `alt+f4`、`win+l`、`cmd+q` 这类快捷键和强制结束进程，第一版拒绝。
  - `launch --cdp`。

### 返回给模型的内容

- 成功：`data` 的 JSON，不缩进。
- 失败：留 `code`、`message`、`details`、`disposition`（`delivery` 送没送到、`retry` 能不能重试，都是事实），去掉上游的 `suggestion`、`recovery`（「先 focus-window 再重试」这类是做法，同 CLAUDE.md 的约定）。
- 网关自己的错误（被拦、超时）写清楚是谁、因为什么：「这是本应用（claude-app）的窗口，桌面工具不能读取或操作它」「命令超过 timeout_ms 被网关终止，动作可能已经生效」。

### 说明（instructions）只写事实

- 操作的是运行网关的这台电脑上、当前登录用户的桌面；用户可能同时在用这台电脑。
- ref 只在产生它的快照里有效，界面变了会返回 `STALE_REF` 或 `AMBIGUOUS_TARGET`。
- 默认（不加 `headed`）经无障碍接口操作，不移动鼠标、不切换前台窗口；`headed` 用真实的鼠标键盘。
- 本应用自己的窗口不在结果里，也不能操作。
- 超过约 20 秒转后台、结束后作为通知送达（同 `RUNTIME_FACTS`）；屏幕上的变化不会通知它。
- 别的会话也可能在操作桌面（见 7.2）。

## 5. 权限卡片

`run` 的卡片显示：

- 命令行，比如 `click @s191jb6hk0gciz:e9`。
- ref 解析出来的目标，比如「mousepad 里的 menuitem「Save」」，查快照缓存（第 3 节）。
- `headed` 时加一行：会移动鼠标、切换前台窗口。

卡片标题「允许执行这条桌面操作？」，说明（`description`）由 `describeRun` 拼，都在 `Session.canUseTool` 里换掉 SDK 给的，网页不用改。

`run` 不给「本会话总是允许」（`canAlways` 置 false）：总是允许的规则是按工具名放行的，放行了就是这个会话以后的所有桌面操作。「完全访问权限」模式照样不弹卡片，这是用户自己选的；第 6 节的两道拦截不经过权限系统，在这个模式下照样生效。

## 6. 安全

### 6.1 本应用的窗口不能读、不能操作

实测和上游说明都表明：

- **Windows**：Chromium 138 起，任何 UIA 客户端连上来就暴露完整界面，不用加参数（我们是 Electron 44）。
- **macOS**：agent-desktop 需要时会自己打开 Chromium 的网页无障碍。
- **Linux**：实测桌面版主窗口只暴露出一个空的网页区域（Electron 在 Linux 上默认不开）；但停放后台标签页的屏幕外窗口 `claude-app-desktop`（-4000,-4000）读出了 325 个元素，是某个会话打开的网页。

不拦的话，模型能点自己的权限卡片「允许」，能改权限模式，还能读到所有会话的内置浏览器标签页，绕开 CDP 代理的「每个会话只看到自己的标签页」。

做法：

- 桌面版连上 `/browser/host` 时发一条 `hello`，带主进程的 `process.pid`。Electron 的窗口在 UIA / AX 里报的应该是主进程的 pid，Windows、macOS 上要实测；不对就把所有子进程的 pid 也带上（`app.getAppMetrics()`）。
- guard 按 pid 拦：
  - `snapshot`、`screenshot`、`find`：`--app` / `--window-id` 指向本应用的拒绝。没指定目标时上游读「当前前台的应用」，所以先 `list-windows` 看前台窗口，是本应用的就拒绝。
  - `list-apps`、`list-windows` 的结果里去掉本应用。
  - ref 动作：按 snapshot id 查快照缓存，是本应用的拒绝；缓存里没有的 snapshot id（不是经这个网关拍的）也拒绝。
  - 坐标动作（`mouse-click`、`mouse-move`、`hover` / `drag` 带坐标、`mouse-wheel`）：坐标落在本应用任何一个窗口的范围内就拒绝（不看叠放次序，宁可多拦）。
  - `press`：必须带 `--app` 或 `--window-id`，而且不能是本应用。不带的话按键送到前台窗口，前台可能正是本应用，焦点停在「允许」按钮上时一个 `return` 就点下去了。实测 Linux 上 `press` 不加 `--headed` 也走 XTEST 真实按键。
  - `close-app`、`focus-window`、`minimize` 等窗口命令指向本应用的拒绝。
- 网关没连着桌面版（网页版）时不知道 pid，这一层不起作用，靠 6.2。

### 6.2 桌面操作进行中收到的权限回复不算数

网页版开在用户的 Chrome、Edge、Safari 里时，界面属于用户的浏览器进程，6.1 拦不住。所以再加一层：网关记下正在执行的桌面写操作（`run` 的非只读命令，从开始到结束后 1 秒）。这期间收到的任何权限回复（任何会话的）都不生效，卡片留着，旁边提示「这次确认发生在 AI 操作桌面期间，没有生效，请再点一次」。

只拦「允许」，「拒绝」照常生效。实现：`Session.replyPermission` 抛 409，网页把错误信息显示出来，卡片还在（没发 `permission_resolved`）。

代价是用户恰好在这时候正常点确认，要再点一次。分辨不出点击是不是用户的：无障碍接口触发的点击在网页里也是 `isTrusted` 的，和键盘回车一样 `detail === 0`。

### 6.3 默认关

`config.yml` 加：

```yaml
desktop:
  enabled: false
```

不像 `externalBrowser` 默认开。打开后每个会话多一个 `desktop` 服务器，常驻在 `tools.alwaysLoad` 里配。网关对外开放（设了 `API_TOKEN`）时，打开它等于让远程的人操作这台电脑的桌面，README 里写明。

### 6.4 隐私

快照、截图、`clipboard-get` 的内容都会发给模型接口，也会写进对话日志（第 11 节）。上游的说明也提醒这些内容别放进公开日志。密码框的值无障碍接口一般不给（macOS 的 `AXSecureTextField` 等），要实测。

屏幕上的文字（网页、邮件、聊天）可能写着给 AI 的指令，上游文档没有处理。我们这边靠写操作的权限卡片和 6.1、6.2。

## 7. 会话和生命周期

### 7.1 快照命名空间

每次调用都带 `--session <网关的会话 id>`。实测 UUID 直接可用，不用先 `session start`（那个是建 trace 用的清单，会另起一个 `run-…` 编号）。快照存在 `$AGENT_DESKTOP_HOME/sessions/<id>/`。删会话时删掉这个目录（接在 `session-manager.ts` 调 `disposeRepls` 的地方）。上游的 ref 归属于会话：一个会话的 ref 在别的会话里用不了。

### 7.2 多个会话共用一个桌面

同一时间可能有几个会话在操作，用户自己也可能在用。网关知道自己经手的每一次操作，所以在下一次结果开头告诉模型：「自你上次调用以来，另一个会话执行过：click（mousepad）、type（mousepad）」（同第 12 节「标签页的变化和是谁做的」）。用户自己的操作网关不知道，说明里只写「用户可能同时在用这台电脑」。

### 7.3 超时、中断、转后台

- `timeout_ms` 默认 60 秒（`wait` 上游最多 30 秒）。到时间就杀进程，报「命令超过 timeout_ms 被网关终止，动作可能已经生效」（第 4 节）。
- MCP 请求的 `signal` 中断时也杀进程。
- 超过 20 秒转后台，沿用现在的 `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`，不用另做。

## 8. 平台

### macOS

- 「辅助功能」（macOS 27 起叫 Device Control and Data Access）授给**启动 agent-desktop 的那个应用**。按 TCC 的「负责进程」规则，从桌面版拉起的网关再拉起的 agent-desktop，归到桌面版（开发时是 Electron.app，打包后是 claude-app）；从终端起网关就归到终端。要实测。
- 截图要「屏幕录制」，部分命令要「自动化」（System Events）。
- 设置页加一块：显示 `permissions` 的结果，加一个按钮执行 `permissions --guide`（打开系统设置的对应页面、提示把哪个应用拖进去；新授权下一次调用就生效，不用重启）。
- `cmd+q` 等退出快捷键上游不带 `--force` 就拒绝。

### Windows

- 没有权限弹窗。受 UIPI 限制：以管理员身份运行的窗口操作不了，网关不提权。
- 最小化的窗口不能按 ref 操作（元素都是 `offscreen`），要先 `restore`；被挡住的窗口可以。
- 二进制没签名。npm 装的文件没有「来自网络」的标记，SmartScreen 一般不拦，杀毒软件可能拦。
- 上游默认拒绝 `alt+f4`、`win+l`、`win+d`、`alt+tab`、`win+r` 等。

### Linux（本机实测，不保证）

- 能用：`status`、`list-apps`、快照、无界面 `type`（中文正常，结果带校验后的值）、`press`（XTEST）、`close-app`、`find`、MCP 模式。
- 不能用：截图（本机显示是 16 位色深，报不支持；窗口被挡住时拒绝）、`focus-window`（XFCE 上超时）。
- Electron 应用的界面默认不暴露。

## 9. 安装和版本

- `gateway/package.json` 加 `agent-desktop`，版本写死（`--save-exact`，第一版 1.2.0）。
- npm 包 30MB，带全部平台的二进制和 macOS / Linux 的辅助程序；`postinstall` 把本机的那个链接到 `bin/agent-desktop`。没跑 `postinstall` 时（包管理器禁了安装脚本）是 Node 启动器，一次约 0.15 秒。
- 网关按 `process.platform` / `process.arch` 直接找 `bin/` 下对应的文件，不经 PATH，也不用用户全局安装。
- 升级后跑一遍第 11 节的清单。

## 10. 界面

- 工具调用：`run` 显示成命令行；`screenshot` 显示图片（现有的图片结果渲染应该直接能用）；`snapshot` 折叠。
- 权限卡片：见第 5 节；被 6.2 挡掉的回复要有提示。
- 设置页：桌面操作开没开（来自 `config.yml`，只读显示）、平台和权限状态、macOS 的授权引导按钮。
- 第一版不做右侧面板的桌面视图。

## 11. 实测清单（Windows、macOS 各一遍）

1. 从桌面版启动时，`status` / `permissions` 的结果；macOS 上授权归到哪个应用。
2. 记事本 / TextEdit：快照、`type`、`set-value`、`click` 菜单、`press` 保存，看看文件真的写进去了没有（Linux 上 `set-value` 改的是没保存的缓冲区）。
3. 资源管理器 / Finder：快照大小、`--skeleton` 加 `--root` 往下展开。
4. 截图：被挡住的窗口、整屏、高分屏的图片大小。
5. **本应用**：
   - 关掉 guard 时能不能读到、点中权限卡片（确认风险真实存在）。
   - 打开 guard 后 6.1 的每一条都拦得住。
   - 停放窗口拦得住。
   - 窗口报的 pid 和主进程 pid 是否一致。
6. 网页版开在 Chrome 里时，6.2 生效。
7. 两个会话同时操作，7.2 的提示正确。
8. Windows：管理员窗口、最小化窗口、Electron 应用第一次读的等待、杀毒软件。

## 12. 待定问题

- **截图太大怎么办**：现在超过上限就返回错误。网关没有图片库，要缩小的话：加 `sharp` 依赖，或经 `/browser/host` 交给桌面版用 `nativeImage` 缩小（网页版用不了）。
- 6.2 的「结束后 1 秒」够不够：无障碍点击到网页发出请求的延迟要实测。
- 要不要把 `batch` 开放出来（guard 要逐条检查）。
- 7.2 之外，要不要在结果里报「自上次调用以来新开 / 关闭的窗口」（每次多跑一次 `list-windows`，约 0.1 秒）。

## 13. 实施步骤

1–3 已完成，在本机（Linux）用脚本直接调这三个工具验证过（不经模型）：
- 拦截：别的会话的 ref、不带目标的 `press` / `find`、`app=electron` 和停放窗口的 `window_id`（模拟桌面版报来的 pid）、落在本应用窗口里的 `mouse-click`、`run snapshot`、`--force`、`close-app electron`，都按预期拒绝。
- `list-apps`、`list-windows` 的结果里去掉了本应用。
- 写操作进行中和结束后 1 秒内 `desktopWriteActive()` 为真，1.1 秒后为假。
- B 会话的下一次调用开头列出了 A 的 `type（mousepad）`、`press（mousepad）`。
- 删会话后状态目录里这个会话的目录被删掉。

没验证的：经模型的真实会话（工具加载、常驻、只读的 `run` 不弹卡片、卡片上的说明、409 的提示）。


1. 网关：`desktop/cli.ts`、`render.ts`、`tool.ts`，`config.yml` 的开关和常驻配置，`options.ts` 挂服务器、`allowedTools`，`Session.canUseTool` 放行只读的 `run`，删会话时清目录。
2. guard（6.1）：桌面版的 `hello` 带 pid，网关的快照缓存和各条拦截规则。
3. 权限回复拦截（6.2）。
4. 界面：权限卡片、工具调用的显示、设置页的状态和授权引导。
5. 按第 11 节在 Windows、macOS 上实测，把结果写回本文档，再并进 README.md 第 14 节。

**Windows 实测（home，2026-11-08，紫鸟浏览器、列应用和窗口）**：
- 窗口报的进程号和桌面版主进程一致：`list-apps`、`list-windows` 的结果里没有漏出本应用。`restore`、`focus-window`、整屏截图（两块屏，3840×2160 的那块由 Claude Code 缩到 2000×1125 给模型）都能用。
- 9 次报错，网关这边改了三处：
  - `restore --help` 被目标检查拦下（c9c99f5）。
  - GPT 把截图的可选参数都填上（`app`、`window_id` 和 `screen: 0` 一起给），agent-desktop 不接受，连错 4 次：现在给了窗口就不传 `--screen`。
  - 拒绝提示一律写「--app、--window-id 或 ref」，模型给只认 `--app` 的 `list-surfaces` 加了 `--window-id`，给 `click` 也加了 `--app`：现在按命令列出它接受的目标参数。
- agent-desktop 自己的规则：紫鸟（Chromium）里没名字的 `group` 不唯一，按 ref 点击返回 `AMBIGUOUS_TARGET`（`identity_not_unique`）；说明里补上了这条，以及这台电脑是什么系统。`find` 读 Chromium 应用时报过一次「树还很薄」。
- 快照渲染改成不认识的字段也原样带上（节点行尾、快照头的「其他：」），Windows 上快照节点有没有额外字段还没看到原始 JSON。

**拦不住的**：模型用 Bash 直接跑 `gateway/node_modules/agent-desktop/bin/agent-desktop`（或 xdotool、AppleScript 这类）就绕过了网关。这和 Bash 本身能做任何事一样，边界是 Bash 的权限卡片；「完全访问权限」下没有这道边界。
