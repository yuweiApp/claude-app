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

以桌面应用启动（先按上面装好 gateway 和 client 的依赖、配好 `.env.local`）：

```bash
cd desktop && npm install && npm start
```

桌面版会拉起网关（`node --import tsx`）和网页（Vite），关窗口时一起结束；网关或网页已经在跑就直接用。VS Code 里选「启动桌面应用」。环境变量 `DESKTOP_GATEWAY_URL`、`DESKTOP_CLIENT_URL` 改地址，`DESKTOP_NODE` 指定 node，`DESKTOP_USER_DATA` 指定单独的数据目录（开发时可以和已经开着的桌面版同时运行），网关设了 `API_TOKEN` 时用 `DESKTOP_GATEWAY_TOKEN` 告诉外壳。桌面版右侧面板有内置浏览器，AI 也能操作，见 [docs/README.md](docs/README.md) 第 12 节；还可以让 AI 操作你自己的 Chrome（`config.yml` 的 `externalBrowser`），见第 13 节。

会话记录、settings、skills 等都在 `gateway/.data/claude-home`（`CLAUDE_CONFIG_DIR`），没选文件夹的会话各在 `gateway/.data/workspace`（`WORKSPACE_DIR`）下新建一个 `scratch-日期-随机串` 目录，都不会碰本机的 `~/.claude`。

> 智能体能在网关所在机器上执行命令、读写文件。默认只监听 `127.0.0.1`；对外开放时务必设置 `API_TOKEN`。
>
> Agent SDK 和 Claude Code 是 Anthropic 专有许可，使用前看一下 [docs/README.md 的「风险」](docs/README.md#10-风险)。
