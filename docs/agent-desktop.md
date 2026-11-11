# 桌面操作（agent-desktop）设计

> **2026-11-11 改造**：去掉了网关包的那层（自定义的 snapshot / screenshot 工具和参数、快照转文字、错误改写、靠 `list-windows` 的拦截和坐标检查），改成命令和参数原样交给 agent-desktop 的命令行、结果原样返回，再改成只有一个工具 `run_code`（JavaScript 里用 `desktop()` 执行命令，可以连着执行多条，同 `browser_run_code`），不弹权限卡片。起因和别人的做法见第 2 节。Linux 上经 MCP 客户端直接调用验证过，没经模型、没在 macOS / Windows 上跑过（第 11 节的验收）。
>
> 状态：网关部分（第 13 节的 1–3 步）已实现，默认关（`config.yml` 的 `desktop.enabled`）；界面（第 4 步）和 Windows、macOS 实测（第 5 步）没做。全部做完后并进 [README.md](README.md) 作为第 14 节，这个文件删掉。
>
> 依据：agent-desktop 1.2.0 在本机（Ubuntu 24.04 + XFCE / X11）的实测；Windows、macOS 的部分来自 agent-desktop 编进二进制的平台说明（`skills get agent-desktop-windows` / `agent-desktop-macos`）和[官方文档](https://agent-browser.dev/desktop)，**没有实测**。主要平台是 Windows 和 macOS，Linux 能用就用、不保证。

## 1. 目标和范围

让模型操作**网关所在那台电脑**上的原生应用（记事本、Finder / 资源管理器、系统对话框、Office、各种 Electron 应用的原生部分）。[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) 读系统的无障碍树（macOS 是 AX API，Windows 是 UI Automation，Linux 是 AT-SPI），给出带 ref 的元素，按 ref 操作，不靠截图识别。

- 网页还是第 12 节（内置浏览器）、第 13 节（用户自己的 Chrome、Edge 等）的事。agent-desktop 自己也不操作网页内容（它对 Chromium 应用的办法是 `launch --cdp` 后交给别的工具）；网关试过把这一步接上，没走通，已删除，见第 14 节。
- 不做：桌面画面的实时面板、录屏、多台电脑。

## 2. 接法

### 为什么不直接挂 `agent-desktop mcp`

设置页现在就能把 `agent-desktop mcp` 当 stdio MCP 服务器加上，实测不合适：67 个工具、约 41000 字符（两个浏览器一共约 5000）；`--headed`、`--session` 启动时定死、所有调用共用；截图的 base64 放在 JSON 文字里；本应用的窗口能读能点（6.1）。

### 为什么不再包一层

改造前网关自己定义了 `snapshot`、`screenshot` 两个工具（参数挑着抄上游的）、把快照改写成缩进文字、去掉错误里的 `suggestion` / `recovery`、每次调用前读 `list-windows` 判断窗口归属和坐标。2026-11-11 在 macOS 上让模型用 Fotor（Qt）文生图，问题都出在这层：

| 问题 | 现象 |
|---|---|
| 上游的参数用不了 | Fotor 的介绍页是 Qt 模态对话框（layer 8、`AXDialog`），按窗口读一直超时；`snapshot --app … --surface focused` 0.13 秒就能读到、按 ref 能点。我们的 `snapshot` 没抄 `--surface`，`run` 又不执行 `snapshot`，skill 里写着的做法模型用不了 |
| 越补越多的规则 | 给了 `window_id` 就不传 `--app`、给了窗口就不传 `--screen`，都是为了绕开模型乱填我们自己定义的参数 |
| 输出和 skill 对不上 | skill 讲 JSON envelope（`data.tree`、`ref_id`、`available_actions`），模型看到的是改写过的文字 |
| 多出来的等待 | 介绍页开着时 `list-windows` 每次等满 5 秒报 `TIMEOUT`（`frontmost_window_join`），网关的检查、浮窗、截图说明每次调用都要先读一遍，额外等 5–10 秒 |

介绍页超时的根本原因是上游 bug：窗口列表只收 layer 0 的窗口，无障碍接口报的前台窗口是 layer 8 的对话框，对不上就重试到超时（[issue #548](https://github.com/vercel-labs/agent-desktop/issues/548)，修复 [PR #394](https://github.com/vercel-labs/agent-desktop/pull/394)、[#594](https://github.com/vercel-labs/agent-desktop/pull/594) 都没合并，1.2.0 仍有）。改造后 bug 还在，但模型能用 `--surface focused` 绕开，网关也不再每次多等。

### 别人怎么接

| | 接入 | 给模型的结果 |
|---|---|---|
| agent-desktop 官方 README | 模型在 shell 里直接调 CLI，或 `agent-desktop mcp` | 原样的 envelope |
| [cc-haha](https://github.com/NanmiCoder/cc-haha)（Windows / Linux） | 一个 MCP 工具 `desktop`，`{command, args, headed}`，`command` 是上游全部命令名的枚举，`args` 是 argv 数组、不经过 shell；宿主管 `--session`、超时、截图转图片，授权在设置里一次 | 原样的 envelope，截图转 MCP image |

我们照 cc-haha：命令行原样透传。再加一个 `run_code`，参照我们自己的 `browser_run_code`（Playwright 脚本控制浏览器）：一次调用里连着执行多条命令、按结果判断、循环等待，不用每一步都往返一次模型。

## 3. 结构

```
claude 子进程 ──进程内 MCP──▶ 网关 desktop 服务器 ──execFile，每条命令一个进程──▶ agent-desktop ──▶ 系统无障碍接口
                               │  run_code：vm 里的 desktop() 一条条调用
                               └─ execute()：拦截检查、6.2 / 7.2 的记录、浮窗、超时、截图
```

`gateway/src/desktop/`：

- `cli.ts`：找二进制、拼参数（加 `--session`、按需加 `--headed`）、`execFile`、解析 JSON 结果、超时和中断时杀进程。环境变量 `AGENT_DESKTOP_HOME` 设成 `gateway/.data/agent-desktop`（要真实路径，带 `..` 会报 `private file parent must not contain parent traversal`；目录权限 700），不碰 `~/.agent-desktop`。
- `commands.ts`：上游 1.2.0 的命令名（`AGENT_DESKTOP_COMMANDS`，升级时对一遍 `agent-desktop --help`）、只读命令、拒绝的命令和参数、从参数里取 ref / `--app` / 等待时限。
- `guard.ts`：第 6、7 节；另外记着见过的窗口（`list-windows` 的结果）、应用（`list-apps`）和快照编号归属哪个会话。
- `repl.ts`：`run_code` 的 vm（改写、顶层 await、循环检查、后台错误认领都用 `browser/repl.ts` 导出的）。
- `log.ts`：每次 agent-desktop 调用和 guard 的判断写进对话日志（格式见 [README.md](README.md) 第 11 节）。
- `tool.ts`：`execute()`、`run_code` 工具、说明。

**每条命令起一个进程**，不常驻 `agent-desktop mcp`，也不用它的 C 库：实测一次 0.1 秒左右；全局参数能每次不同；卡住或崩溃只影响这一次。多个进程同时操作时，agent-desktop 自己有跨进程的「交互租约」排队，网关不另加锁。

## 4. 工具

服务器名 `desktop`，只有一个工具 `run_code`，在 `allowedTools` 里，不弹权限卡片（用户定的：桌面工具默认开放），`config.yml` 的 `tools.alwaysLoad` 里常驻。以前还有一个 `run`（一次一条命令，`{command, args, headed, timeout_ms}`），2026-11-11 去掉，用户要验证只用 `run_code` 的效果。

### run_code

`{ code: string, timeout_ms?: number }`。每个会话一个常驻的 vm 上下文（删会话时删掉），顶层 await，顶层的 const / let / function 在之后的调用里还在，最后一个表达式的值和 console 输出作为结果（同 `browser_run_code`，超过 40000 字符只留开头）。

- `await desktop(command, args?, { headed?, timeout_ms? })`：执行一条命令，经 `execute()`（拦截、6.2、7.2、浮窗、超时）。`command` 是上游 1.2.0 的命令名（`AGENT_DESKTOP_COMMANDS`），`args` 原样交给 agent-desktop、不经过 shell，`headed` 加 `--headed`，`timeout_ms` 是这条命令的进程期限（7.3）。返回 envelope 解析成的对象，`ok: false` 也是返回不抛错（和命令行一样，模型按 `error.code`、`disposition` 判断）；`--help` 返回文字；被拒绝、超时被终止、调用被中断时抛错。
- `snapshot`、`screenshot` 和其他命令一样经 `desktop()`，上游的参数（`--surface`、`--root`、`--skeleton`、`--timeout-ms`……）都能用。网关不替模型加 `-i`、`--compact`，也不改 `--timeout-ms` 的默认值（skill 里写着 Chromium 慢时调大）。
- 网关代管、不接受的参数：`--session`（网关按会话 id 加）、`--agent-id`、`--trace`、`--trace-strict`、`--debug`、`--screenshot`（写含屏幕内容的 HTML 文件）、`--stdin`、`--headed`（用 `headed` 给）、`--force`（放行 `cmd+q`、`alt+f4` 和强制结束进程）、`--cdp`（第 14 节）。
- 不执行的命令：`mcp`、`session`、`trace`、`batch`（多步就写在代码里）。
- `screenshot`：`[PATH]` 由网关给（临时目录，读完删掉），模型给了路径就拒绝。`data` 里多一个 `image`（Buffer），不自动给模型，`emitImage(buffer, mime)` 加进结果。
- 有 `setTimeout`、`fetch`、`Buffer`、`URL` 等，没有 `require`、`process`。同步执行超过 2 秒（中间没有 await）中止；`timeout_ms` 到了先返回，代码可能还在跑；调用被中断时正在执行的命令被杀掉，这次调用之后的 `desktop()` 抛错。
- vm 不是安全边界，跑在网关主线程里，等同于 Bash（`browser_run_code` 同理）。定时器里抛的错、没 await 的失败由 `browser/repl.ts` 的全局处理认领（vm 文件名 `desktop_run_code_<编号>.js`），下一次调用时告诉模型，不会让网关退出。

### 返回给模型的内容

- agent-desktop 的 envelope 原样返回（不缩进），包括 `suggestion`、`recovery`：skill 本身就是做法，结果里的建议和 skill 一致。只去掉本应用的条目（6.1）。
- 快照不再改写成文字。代价是 token 多一倍左右（Mousepad 实测 JSON 46.6KB、改写后的文字 21.4KB），验收时量一次，太大再考虑 JSON 层面的精简（去掉空字段），不回到自定义文字格式。
- `screenshot`：envelope 去掉临时文件的 `path`，`width`、`height` 改成返回的图片尺寸，加 `original_width`、`original_height`、`format`（png / jpeg），模型 `emitImage` 后作为 MCP 图片返回。缩小规则：macOS 按 `scale_factor` 缩回点的尺寸（实测 iMac 全屏 Fotor 4616×2398、6.5MB，超过模型接口 base64 后 5MB 的单张上限），图片像素和桌面坐标一一对应；Windows 的桌面坐标本来就是像素，不缩；之后还超过 3.75MB 改 JPEG（质量 80），再超过每次缩到 3/4。
- 网关自己的错误（被拦、超时）是一句话，用模型看得到的东西说（desktop()、本应用），不提网关。
- 上游行为（实测）：窗口被挡住时拒绝截图（`reason: covered`）；最小化的窗口要等约 5 秒才报错（Windows），网关不再提前判断。macOS 截图要「屏幕录制」权限。

### 说明（instructions）

例外于 CLAUDE.md 的「只写事实」：开头让模型第一次使用前用 `desktop("skills", ["get", …])` 读 agent-desktop 自带的 skill（`skills get desktop`、`skills get platform`）并照着做，再说明 skill 里的命令行对应 `desktop()` 的 `command` 和 `args`（不经过 shell）。以前只列出有 `skills` 命令，实测 Windows 上模型从来不读。其余只写事实：环境（平台、agent-desktop 版本、用户可能同时在用）、`run_code` 的接口和规则、用户已允许 headed（skill 写着只有用户明确允许才用，模型照着就不敢用，见第 13 节 macOS）、bounds 和坐标命令同一套坐标、代管的参数、截图的缩小规则和字段、模态对话框的已知问题（见下）、本应用窗口的规则、超时和转后台、别的会话的操作、`@desktop` 引用的格式。约 2800 字符。

说明不区分平台（用户定的：规则都一样，不要只对 macOS 加），只有第一句写这台电脑是什么系统、用哪个无障碍接口。截图的缩小代码仍只在 macOS 上按缩放缩小（Windows 的桌面坐标本来就是像素），说明里只写「缩小到桌面坐标的尺寸，1 个像素对应 1 个桌面坐标单位」，两边都成立。

已知问题写成事实（macOS 上实测，说明里不写平台）：应用弹出模态对话框（layer 不为 0）时，读全局窗口列表的命令（不带 `--app` 的 `list-windows`、按 `--window-id` 的命令、`screenshot`）一直重试到超时，`TIMEOUT` 的 `details.kind` 是 `global_window_inventory_unstable`、`last_kind` 是 `frontmost_window_join`，结果里的 `suggestion` 说应用可能忙或没响应；对话框关掉后恢复；`list-windows --app` 和 `snapshot --app … --surface focused` 不受影响，后者读到的就是这个对话框。没写的时候模型照 `suggestion` 以为 Fotor 卡住了，直接停下来让用户去看（第 13 节 macOS 第三轮），skill 里只笼统写着菜单、对话框用 `--surface`。

## 5. 权限

`run_code` 不弹卡片（`allowedTools`），「总是允许」也就用不上。下面第 6 节的拦截不经过权限系统，照样生效。

## 6. 安全

### 6.1 本应用的窗口不能读、不能操作

实测和上游说明都表明：

- **Windows**：Chromium 138 起，任何 UIA 客户端连上来就暴露完整界面，不用加参数（我们是 Electron 44）。
- **macOS**：agent-desktop 需要时会自己打开 Chromium 的网页无障碍。
- **Linux**：实测桌面版主窗口只暴露出一个空的网页区域（Electron 在 Linux 上默认不开）；但停放后台标签页的屏幕外窗口 `claude-app-desktop`（-4000,-4000）读出了 325 个元素，是某个会话打开的网页。

不拦的话，模型能点自己的权限卡片「允许」，能改权限模式，还能读到所有会话的内置浏览器标签页，绕开 CDP 代理的「每个会话只看到自己的标签页」。

做法（2026-11-11 起只留不用另外读窗口列表的检查，以前每次调用前读 `list-windows`，是 Fotor 那次额外等待的来源）：

- 桌面版连上 `/browser/host` 时发一条 `hello`，带自己的进程号（主进程和子进程）。连上时网关读一次 `list-apps`，记下本应用的应用名。
- `list-apps`、`list-windows`（和任何结果、错误 details 里）带 `pid` 的条目，是本应用的就去掉。
- `--window-id` 在见过的 `list-windows` 结果里（模型自己调的，和输入框「Computer Use」查的）属于本应用的，拒绝；没见过的照常交给 agent-desktop。
- `--app`、`launch` / `close-app` 的应用名是本应用的，拒绝。和本应用同名的还有其他进程（开发模式下 Electron 应用都叫 `electron.exe`）时照实说分不出来，让模型按窗口 id 指定。
- ref 必须是这个会话经网关拿到的（快照编号记在网关里；本应用的窗口拍不了快照，也就拿不到它的 ref）。上游的 ref 本来就归属于会话。
- **不要求指定目标**（2026-11-11 去掉）：不带 `--app` / `--window-id` 的 `snapshot`、`screenshot`、`find`、`press`、窗口命令照上游的规则作用于前台窗口，前台是本应用时能读到、能按键到本应用（比如焦点停在「允许」按钮上时 `press return`）。以前网关要求这些命令带目标，是网关自己加的规则，和上游的行为不一样，去掉了；权限卡片靠 6.2。
- **不查坐标**：坐标点击（`mouse-click --xy` 等，要 `headed`）能点到本应用的窗口。权限卡片靠 6.2。
- 网关没连着桌面版（网页版）时不知道 pid，这一层不起作用，靠 6.2。

### 6.2 桌面操作进行中收到的权限回复不算数

网页版开在用户的 Chrome、Edge、Safari 里时，界面属于用户的浏览器进程，6.1 拦不住。所以再加一层：网关记下正在执行的桌面写操作（`run_code` 里 `desktop()` 执行的非只读命令，从开始到结束后 1 秒）。这期间收到的任何权限回复（任何会话的）都不生效，卡片留着，旁边提示「这次确认发生在 AI 操作桌面期间，没有生效，请再点一次」。

只拦「允许」，「拒绝」照常生效。实现：`Session.replyPermission` 抛 409，网页把错误信息显示出来，卡片还在（没发 `permission_resolved`）。

代价是用户恰好在这时候正常点确认，要再点一次。分辨不出点击是不是用户的：无障碍接口触发的点击在网页里也是 `isTrusted` 的，和键盘回车一样 `detail === 0`。

### 6.3 默认关

`config.yml` 加：

```yaml
desktop:
  enabled: false
```

不像 `externalBrowser` 默认开。打开后每个会话多一个 `desktop` 服务器（`run_code`，不弹权限卡片），常驻在 `tools.alwaysLoad` 里配。网关对外开放（设了 `API_TOKEN`）时，打开它等于让远程的人操作这台电脑的桌面，README 里写明。

### 6.4 隐私

快照、截图、`clipboard-get` 的内容都会发给模型接口，也会写进对话日志（第 11 节）。上游的说明也提醒这些内容别放进公开日志。密码框的值无障碍接口一般不给（macOS 的 `AXSecureTextField` 等），要实测。

屏幕上的文字（网页、邮件、聊天）可能写着给 AI 的指令，上游文档没有处理。桌面工具不弹权限卡片，这里只有 6.1、6.2。

## 7. 会话和生命周期

### 7.1 快照命名空间

每次调用都带 `--session <网关的会话 id>`。实测 UUID 直接可用，不用先 `session start`（那个是建 trace 用的清单，会另起一个 `run-…` 编号）。快照存在 `$AGENT_DESKTOP_HOME/sessions/<id>/`。删会话时删掉这个目录（接在 `session-manager.ts` 调 `disposeRepls` 的地方）。上游的 ref 归属于会话：一个会话的 ref 在别的会话里用不了。

### 7.2 多个会话共用一个桌面

同一时间可能有几个会话在操作，用户自己也可能在用。网关知道自己经手的每一次操作，所以在下一次结果开头告诉模型：「自你上次调用以来，另一个会话执行过：click（mousepad）、type（mousepad）」（同第 12 节「标签页的变化和是谁做的」）。用户自己的操作网关不知道，说明里只写「用户可能同时在用这台电脑」。

### 7.3 超时、中断、转后台

- `timeout_ms` 默认 60 秒、最多 10 分钟。到时间就杀进程，报「命令运行超过 N 毫秒被终止，动作可能已经生效」（第 4 节）。
- 命令自己会等的（`wait` 的 `[MS]` 和 `--timeout`，上游默认 30 秒、最多 24 小时；`launch` 的 `--timeout`，默认 30 秒；`snapshot` 的 `--timeout-ms`，默认 3 秒；任何命令带 `--wait-for` / `--wait-for-gone` 时的 `--wait-timeout`，默认 30 秒）：进程期限取 `timeout_ms` 和「等待时限 + 5 秒」里大的那个（同样不超过 10 分钟），写在说明里。`run_code` 里每条 `desktop()` 同样按这个规则，`run_code` 自己的 `timeout_ms` 管整段代码。不然 `wait --timeout 60000` 配默认的 `timeout_ms` 60000，上游等满正要返回 `TIMEOUT`（`details.kind: wait_timeout`，带最后看到的窗口标题）时进程被杀，模型拿到的是「被终止，动作可能已经生效」。
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
- 最小化的窗口也不能截图：返回 `INVALID_ARGS`「Cannot capture a minimized window」（实测要 5 秒多，它先试着截、超时才报错），`restore` 之后能截。
- 二进制没签名。npm 装的文件没有「来自网络」的标记，SmartScreen 一般不拦，杀毒软件可能拦。
- 上游默认拒绝 `alt+f4`、`win+l`、`win+d`、`alt+tab`、`win+r` 等。

### Linux（本机实测，不保证）

- 能用：`status`、`list-apps`、快照、无界面 `type`（中文正常，结果带校验后的值）、`press`（XTEST）、`close-app`、`find`、MCP 模式。
- 不能用：截图（本机显示是 16 位色深，报不支持；窗口被挡住时拒绝）、`focus-window`（XFCE 上超时）。
- Electron 应用的界面默认不暴露。

## 9. 安装和版本

- `gateway/package.json` 加 `agent-desktop`，版本写死（`--save-exact`，第一版 1.2.0）。
- npm 包 30MB，带全部平台的二进制和 macOS / Linux 的辅助程序；`bin/agent-desktop` 是 Node 启动器，macOS、Linux 上 `postinstall` 把它换成本机原生程序的硬链接，Windows 上不换（只改 `node_modules/.bin` 里的 `.cmd`）。经启动器每次多起一个 node 进程：home 上实测 `version` 原生 40 毫秒、经启动器 170 毫秒，网关带着调试参数时还要等调试器连上。
- 网关按 `process.platform` / `process.arch` 直接找 `bin/agent-desktop-<平台>-<架构>`（Windows 加 `.exe`），没有时才用 `bin/agent-desktop`（启动器）；不经 PATH，也不用用户全局安装。以前 Windows 上找的是不存在的 `bin/agent-desktop.exe`，一直在走启动器。
- 升级后跑一遍第 11 节的清单。

## 10. 界面

- 工具调用：`run_code` 一行显示代码第一行，展开是整段代码（以前会话里的 `run` 照旧显示成命令行）；截图照常渲染成图片（`client/src/components/Steps.tsx`）。
- 被 6.2 挡掉的权限回复（别的工具的卡片）有提示。
- 设置页：桌面操作开没开（来自 `config.yml`，只读显示）、平台和权限状态、macOS 的授权引导按钮。
- 引用窗口：输入框上面的「Computer Use」（`client/src/components/DesktopPicker.tsx`，窗口来自网关的 `GET /desktop/windows`，本应用自己的去掉）第一行插入 `@桌面`，选中窗口插入 `@desktop[标题](window:窗口 id "应用名")`：和浏览器标签页的引用同一个结构（Markdown 链接前面加 @），应用名（`list-windows` 的 `app_name`）放在 Markdown 的链接标题里。窗口标题常重名、看不出是哪个程序（两个「桌面 - 文件资源管理器」），窗口关掉重开后 id 也会变，带上应用名模型对不上 id 时还能按应用找回。以前的引用没有链接标题，照样解析。输入框和消息里显示成显示器图标加「桌面 · 标题」，悬停显示应用名；桌面工具的说明里写了这两种写法指什么。
- 不做右侧面板的桌面视图；改成对话区右上角的浮窗（`client/src/components/DesktopTargetFloat.tsx`）：
  - 显示这个会话最近操作的软件（应用图标、应用名、窗口标题），这一轮进行中带一个闪烁的点。目标由网关从手上有的东西算，不为它另外读窗口列表：参数（`--window-id`、`--app`、`launch` / `close-app` 的应用名、ref 所属快照的应用和窗口）、调用结果（`snapshot` 的 `data.app`、`data.window`）、见过的 `list-windows` 结果（按窗口 id 查标题）；只知道应用名时，和上次报的是同一个应用就沿用上次的窗口，否则只显示应用名。变了才发 `desktop_target` 事件。调用一开始按参数发，结束后按结果再发（`launch` 只在结束后发）。
  - 点开是那个窗口的实时画面，只看不能点：桌面版用 `desktopCapturer` 按窗口标题找采集源（`desktop/src/capture.ts`；agent-desktop 的窗口 id 和采集源的 id 对不上，所以按标题），网页用 `getUserMedia`（`chromeMediaSource: desktop`）取视频流。不用 agent-desktop 的 `screenshot` 轮询：每张起一个进程，而且上游拒绝截被挡住的窗口，看预览时本应用正好挡在上面。
  - 放大：铺满对话消息区（`.scroll-area`，标题行下面、输入框上面，四周留 8px），画面 `object-fit: contain` 按比例缩放、不拉伸，多出来的地方留底色；按 Esc 缩回。
  - 画面缩放（同图片查看器，复用 `ImageThumb.tsx` 的 `useZoomPan`，它改成图片、视频都能用，视频按 `videoWidth` 算相对原始像素的百分比）：滚轮以鼠标处为中心缩放，双指捏合，放大后拖动平移，双击在适应大小和 2 倍之间切换，右下角工具条缩小、放大、点百分比还原；换了窗口、放大缩小浮窗时还原。采集分辨率平时上限 1920×1200，放大到超过画面原始像素（100%）时重新取一路上限 4096×2560 的流，新的就绪了才停旧的（不闪），回到适应大小再换回来；换成高分辨率后百分比变小，所以用「还在放大」判断要不要换回，免得来回切。
  - Windows 10 1903+（Windows Graphics Capture）和 macOS（ScreenCaptureKit）上被挡住的窗口也有画面，最小化的没有；macOS 要给本应用开「屏幕录制」。网页版没有窗口采集，只显示名字。
  - 待实测：Windows、macOS 上两边的窗口标题是否一致（标题前后加了应用名时按包含匹配，只有一个匹配才用）。

## 11. 实测清单（Windows、macOS 各一遍）

改造后的验收：

1. Fotor 介绍页：模型能用 `snapshot --app "Fotor Photo Editor" --surface focused` 读到「立即开始」「不再提示」并按 ref 点击；介绍页开着时每次调用不再额外等 5 秒（对话日志 `.data/logs/conversation-*.jsonl` 里每次 `desktop:cli` 的 `ms`，以及没有网关自己的 `list-windows`）。
2. Fotor 首页的功能方块（没有 ref）：截图（Retina 缩小后）、按坐标 `mouse-click --headed`。
3. Windows 紫鸟（Chromium）：快照、按 ref 点击、重名 `group` 的 `AMBIGUOUS_TARGET`。
4. 快照大小：Fotor、紫鸟、资源管理器各量一次 JSON 原样返回的大小。
5. 只有 `run_code` 时：模型能不能照 skill 用 `desktop()`，会不会在一次调用里做多步（点击后 `wait`、读结果、再点），截图经 `emitImage` 返回。
6. `run_code` 不弹卡片；6.2 照样生效（模型操作期间点别的工具的「允许」不算数）。
7. 本应用的窗口：6.1 的每一条（按应用名、按 `list-windows` 里的窗口 id）都拦得住；`list-apps`、`list-windows` 里没有本应用。
8. 两个会话同时操作，7.2 的提示正确。

更早的清单（改造前定的，部分已在第 13 节做过）：`status` / `permissions` 的结果和 macOS 上授权归到哪个应用；记事本 / TextEdit 的 `type`、`set-value`、菜单、`press` 保存；资源管理器 / Finder 的 `--skeleton` 加 `--root`；被挡住的窗口和整屏截图；网页版开在 Chrome 里时 6.2 生效；Windows 的管理员窗口、最小化窗口、Electron 第一次读的等待、杀毒软件。

## 12. 待定问题

- 6.2 的「结束后 1 秒」够不够：无障碍点击到网页发出请求的延迟要实测。
- `batch` 还拒绝着：多步有了 `run_code`，`batch` 要开的话得逐条检查里面的命令（cc-haha 放开了）。
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
- 第二轮（紫鸟提交插件）：
  - `snapshot` 读紫鸟 3 秒超时（`walk_root_unread`，模型照说明填了默认值 3000）：网关的默认期限改成 15000，读完就返回。
  - `mouse-click` 被判为落在本应用窗口里：紫鸟挪到主屏后盖住了 Claude App，以前不看叠放次序。现在前台窗口不是本应用、又盖住这个坐标时放行（点击落在前台窗口上）。
  - 截图结果附上屏幕 / 窗口在桌面坐标里的范围、缩放和图片像素大小：两块屏 125%、150%，副屏从 x=1920 开始，模型拿到的图还被 Claude Code 缩小过。
  - `find` 报「Chromium 的树还很薄」：agent-desktop 的 Windows 说明里写，Chromium 窗口被完全挡住时树会一直停在第一次读到的那一小部分。模型因此改用坐标点击（真实鼠标，要把紫鸟切到前台），挡住了用户的窗口。
- 第三轮（2026-11-10，截图 @desktop 引用的窗口「树屿森 SYS」，是 codex-app-server 的桌面版）：
  - 模型把引用里的窗口标题填进 `app`，和 `window_id` 一起给，agent-desktop 先按 `--app` 找应用，报 `APP_NOT_FOUND`：现在 `snapshot`、`screenshot` 给了 `window_id` 就不传 `--app`。
  - 模型改填进程名 `electron.exe`：开发模式下本应用和 codex-app-server 的桌面版都叫 `electron.exe`，网关按应用名拦下，还报「这是本应用的窗口」，模型以为真是本应用。现在同名的还有其他进程时，错误信息照实说（应用名和本应用相同、分不出来，按窗口 id 指定时看窗口所属的进程）。
  - 改完再试：网关放行（按窗口 id 查到 pid 38508，不是本应用），agent-desktop 报不能截最小化的窗口（第 8 节），模型 `restore` 后截图成功。这一轮靠新加的桌面日志（`log.ts`）对上了每一步。
  - 日志里每次调用的 stderr 都是 Node 调试器的输出：Windows 上一直在经 Node 启动器调用，改成直接调用原生程序（第 9 节）。
  - 改完：`skills get` 746 → 67 毫秒，`list-windows` 1–1.4 秒 → 0.35–0.46 秒。截最小化窗口仍要 4.9 秒（上游），一次截图跑 3 遍 `list-windows`：网关改成看到最小化直接返回、`list-windows` 留 1 秒共用（第 4 节 screenshot）。
- 快照渲染改成不认识的字段也原样带上（节点行尾、快照头的「其他：」），Windows 上快照节点有没有额外字段还没看到原始 JSON。

**macOS 实测（iMac，2026-11-11，Fotor 用文生图生成图片）**：
- Fotor（Qt）首页的功能方块在无障碍树里只有 `statictext "智能图片生成"` 和 `image`，上层 `group` 也没有可用操作，没有 ref，只能按坐标用真实鼠标点（`mouse-click --headed --xy`）。很多应用都会这样（自绘控件、canvas、游戏），要靠截图和坐标这条路。
- 模型拿到了 `find` 给的坐标，但没用 headed：skill 写着只有用户明确允许才用，截图又因为超过上限没返回图片。改了两处：说明里写明用户已允许 headed、不需要另外确认，以及 bounds 和坐标命令是同一套坐标；截图按 Retina 缩放缩小（第 4 节 screenshot）。
- `--xy` 不切换前台：当时本应用全屏在前台、盖住了 Fotor，坐标点击会落在本应用上（网关拒绝）。
- 第二轮（小猫）：headed 和缩小后的截图都用上了，填好描述、点了生成，停在积分为 0 的购买页。中间一分半钟没有动静：点开「智能图片生成」后 Fotor 弹出介绍页，这期间 `list-windows` 每次等满 5 秒报 `TIMEOUT`（`global_window_inventory_unstable`，`APP_UNRESPONSIVE`），按窗口 id 的快照等了 30 秒、截图 5 秒失败，`list-windows --app` 和截整屏不受影响；Fotor 的窗口 id 也从 w-3616 换成了 w-3671。网关改了两处：`list-windows` 读失败后的处理（不反复等、坐标拦截不再放空，6.1）和窗口 id 不在了直接返回（6.1）。
- 根本原因（复现过）：介绍页是 Fotor 的模态对话框（`AiEditChooseImageGuideWidget`，`AXDialog`，CoreGraphics layer 8）。无障碍接口说前台窗口是它，agent-desktop 的窗口列表只收 layer 0 的窗口，两边对不上（`frontmost_window_join`），读整个窗口列表、按窗口 id 的命令都一直重试到超时。`snapshot` 加了 `surface` 参数，`surface: focused` 能读到这个对话框并按 ref 操作（第 4 节 snapshot）。
- 浮窗显示「窗口已经关闭」：找到了采集源，视频流随即结束，原因没查清。Fotor 的窗口标题在 `list-windows` 里一会儿是「Fotor」、一会儿是「Fotor Photo Editor」，可能按标题匹配错了窗口。

- 第三轮（2026-11-11，改造后，小狗）：模型先读了 skill，按 `snapshot` / `screenshot` / `mouse-click --headed` 找到并点开「智能图片生成」（第一次点击时 Fotor 不在前台，没点上；`focus-window` 后再点才点开）。介绍页弹出后 `snapshot --window-id`、`screenshot --app`、`list-windows` 都超时（`frontmost_window_join`），模型照 `suggestion`（「应用可能忙或没响应」）判断 Fotor 卡住，结束了这一轮，没试 `--surface focused`。当时经 ssh 直接跑 `snapshot --app "Fotor Photo Editor" --surface focused -i --compact`，0.14 秒读到对话框和「立即开始」「不再提示」的 ref，`list-windows --app` 也正常。说明里补上了这条已知问题（第 4 节说明）。另外：macOS 截窗口的图带阴影，图片 2308×1199、窗口 bounds 2240×1131（四边约多 34），图片像素和桌面坐标比例是 1:1，但原点不是窗口的原点，说明里还没写。

**拦不住的**：模型用 Bash 直接跑 `gateway/node_modules/agent-desktop/bin/agent-desktop`（或 xdotool、AppleScript 这类）就绕过了网关。这和 Bash 本身能做任何事一样，边界是 Bash 的权限卡片；「完全访问权限」下没有这道边界。

## 14. CDP 接管（试过，已删除）

想法：Windows 上紫鸟（Electron）的无障碍树不可靠（窗口被挡住时停在第一次读到的一小部分，没名字的 `group` 按 ref 点不了，模型只好切到前台用真实鼠标点），于是用 agent-desktop 的 `launch --cdp` 以本机调试端口重新启动应用，网关用 Playwright `connectOverCDP` 连上去，模型用 `mcp__cdp__` 一组工具（同浏览器那一套）操作网页内容，不经无障碍接口、不抢前台。`config.yml` 的 `desktop.cdp` 开关，提交 4aaeab5 里实现过，Linux 上拿 Electron 实测能用。

没走通，代码已删除，`desktop()` 照旧拒绝 `--cdp`：

- 紫鸟（6.50，Windows 实测）主进程启动时检查命令行，正式版里带 `--remote-debugging-port` 或 `--inspect` 就打印「Remote debugging is not allowed.」并退出（app.asar 里的代码），agent-desktop 等满 30 秒报 `cdp_endpoint_unavailable`。绕开启动器、直接带实例参数（`--use-chromium-request --user-data-dir=…`）启动也一样。它还在开发者工具打开时自动关掉。紫鸟只在官方的 WebDriver 模式里给店铺窗口（另起的浏览器内核进程）开调试端口，客户端界面本身不开。
- 其余限制：只能用于新启动的进程（已在运行时返回 `cdp_requires_fresh_launch`，要先关掉应用，丢掉用户在里面的状态）；端口开着时本机任何程序都能控制这个应用。
