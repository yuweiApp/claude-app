# claude-app

用 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)（底层是 Claude Code 引擎）做的网页版编程助手，形态参照 Claude 桌面版的 Code 标签页。模型通过 `ANTHROPIC_BASE_URL` 接 newapi / DeepSeek 等 Anthropic 格式接口。

```
浏览器 (React) ──HTTP/SSE──▶ gateway (Fastify) ──Agent SDK──▶ claude 子进程（每个活跃会话一个）──▶ 模型接口
```

| 目录 | 说明 |
| --- | --- |
| [docs/](docs/README.md) | 技术方案：架构、会话模型、事件流、权限、模型接入、接口、路线图、风险 |
| gateway/ | Node 22 + TypeScript + Fastify：会话生命周期、SSE 断线续传、权限请求挂起与回复、历史会话、附件上传 |
| client/ | Vite + React 19 + TypeScript：会话列表、流式对话、工具调用折叠、权限确认、中断、附件 |
| desktop/ | Electron 桌面版：拉起网关和网页，在应用窗口里打开 |

## 快速开始

```bash
cd gateway && npm install && cp .env.example .env.local   # 填 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN、模型名
npm run dev                                               # http://127.0.0.1:8788
```

`gateway/config.yml` 是功能上的配置（比如哪些 MCP 工具常驻、不用先 ToolSearch），改完要重启网关。

```bash
cd client && npm install && npm run dev                   # http://localhost:5180
```

以桌面应用启动（先装好 gateway 和 client 的依赖，模型密钥由登录账号提供）：

```bash
cd desktop && npm install && npm start
```

桌面版启动时先显示账号密码登录页，使用与 `codex-app-server` 相同的树屿森 New API 账号；默认服务地址为 `https://dashboard.shuyusen.club`，可用 `NEWAPI_URL` 指定。只提供登录和退出，账号开启二次验证时会继续要求验证码。登录信息由系统凭证服务加密保存在 Electron 用户数据目录的 `account.json`，不保存密码；下次启动自动进入应用。左下角头像菜单可「退出登录」，程序会清除本机登录信息、注销服务器登录会话，并重启外壳回到登录页。

登录后用该账号的模型密钥拉起独立网关（`node --import tsx`）和网页（Vite），关窗口时一起结束。模型默认优先选择账号可用的 Claude Sonnet，也可通过 `DESKTOP_DEFAULT_MODEL` 指定。账号注入的模型配置优先于 `gateway/.env.local`；各账号的会话、工作目录和内置浏览器数据分别保存，模型密钥不传给网页。桌面版默认尝试网关端口 8788、网页端口 5180，端口占用时另选空闲端口，不复用已运行服务。环境变量 `DESKTOP_GATEWAY_URL`、`DESKTOP_CLIENT_URL` 可固定本机 HTTP 地址（指定端口需要空闲），`DESKTOP_NODE` 指定 node，`DESKTOP_USER_DATA` 指定单独的数据目录。VS Code 里选「启动桌面应用」。网页单独启动时仍使用网关的 `.env.local` 和 `API_TOKEN` 配置。

桌面版右侧面板有内置浏览器，AI 也能操作，见 [docs/README.md](docs/README.md) 第 12 节；还可以让 AI 操作你自己的 Chrome、Edge 等 Chromium 内核浏览器（设置页「浏览器」），见第 13 节。还可以让 AI 操作这台电脑上的原生应用（`config.yml` 的 `desktop`，默认关，用 [agent-desktop](https://github.com/vercel-labs/agent-desktop)），见 [docs/agent-desktop.md](docs/agent-desktop.md)。

会话记录、settings、skills 等都在 `gateway/.data/claude-home`（`CLAUDE_CONFIG_DIR`），没选文件夹的会话各在用户数据目录的 `claude-app/workspace`（`WORKSPACE_DIR`；Windows 是 `%LOCALAPPDATA%\claude-app\workspace`，macOS 是 `~/Library/Application Support/claude-app/workspace`，Linux 是 `~/.local/share/claude-app/workspace`）下新建一个 `scratch-日期-随机串` 目录，都不会碰本机的 `~/.claude`。

## Windows 打包

在 Windows x64、Node.js 22 或更新版本下执行：

```powershell
npm --prefix desktop ci
npm --prefix desktop run dist
```

生成 `desktop/release/sys-claude-<版本>-win-x64-setup.exe` 和对应的 `.sha256` 校验文件，同时保留 `desktop/release/win-unpacked/` 供直接运行。只需生成未安装目录时使用 `npm --prefix desktop run pack`。版本号取 `desktop/package.json` 的 `version`。当前产物未做发布者代码签名。

打包脚本会自动构建前端、网关和桌面外壳，缺少依赖时使用各目录的锁文件安装。安装版由编译后的网关托管前端，随包携带构建机使用的 Node.js 运行时、生产依赖及当前平台的 Claude Code 可执行文件，不依赖项目源码、Vite 或用户预装的 Node.js。安装版默认使用本机端口 18788，占用时自动选择空闲端口；日志写入 Electron 用户数据目录的 `logs/`。模型凭证仍由用户登录后取得，不打入安装包。

桌面端、网关的 TypeScript 构建及 Vite 发布构建均关闭 sourcemap。发布暂存目录中的业务 JavaScript（含登录页内联脚本及前端各个动态加载的分块）使用 `javascript-obfuscator` 混淆标识符，并对字符串数组做 RC4 编码；外壳封装为 ASAR。第三方依赖保留原有许可证，不做额外混淆；源码类型文件、`.map`、调试符号、`.env` 和开发数据不进入发布资源。混淆和字符串编码用于提高代码阅读成本，运行时代码仍可还原；账号密钥继续使用系统凭证服务加密保存。

`dist` 和 `pack` 在打包前会验证发布版网关、API 鉴权、静态资源、原生终端，以及真实 Electron 中受保护的登录页和前端。封装后会用独立的测试数据目录启动生成的 EXE，验证生产主进程、ASAR preload、登录表单和账号通信；验证失败会使打包命令失败。暂存资源及每个文件的 SHA-256 清单在 `desktop/build/`；`npm --prefix desktop run verify:release` 可单独复查暂存产物，`npm --prefix desktop run verify:package` 可复查 EXE。安装包封装完成前会再次检查资源目录和 `app.asar`，拒绝带入源码、sourcemap 或环境文件。

> 智能体能在网关所在机器上执行命令、读写文件。默认只监听 `127.0.0.1`；对外开放时务必设置 `API_TOKEN`。
>
> Agent SDK 和 Claude Code 是 Anthropic 专有许可，使用前看一下 [docs/README.md 的「风险」](docs/README.md#10-风险)。
