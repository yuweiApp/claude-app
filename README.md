# claude-app

用 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)（底层是 Claude Code 引擎）做的网页版编程助手，形态参照 Claude 桌面版的 Code 标签页。模型通过 `ANTHROPIC_BASE_URL` 接 newapi / DeepSeek 等 Anthropic 格式接口。

```
浏览器 (React) ──HTTP/SSE──▶ gateway (Fastify) ──Agent SDK──▶ claude 子进程（每个活跃会话一个）──▶ 模型接口
```

| 目录 | 说明 |
| --- | --- |
| [docs/](docs/README.md) | 技术方案：架构、会话模型、事件流、权限、模型接入、接口、路线图、风险 |
| gateway/ | Node 22 + TypeScript + Fastify：会话生命周期、SSE 断线续传、权限请求挂起与回复、历史会话 |
| client/ | Vite + React 19 + TypeScript：会话列表、流式对话、工具调用折叠、权限确认、中断 |

## 快速开始

```bash
cd gateway && npm install && cp .env.example .env.local   # 填 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN、模型名
npm run dev                                               # http://127.0.0.1:8788
```

```bash
cd client && npm install && npm run dev                   # http://localhost:5174
```

会话记录、settings、skills 等都在 `gateway/.data/claude-home`（`CLAUDE_CONFIG_DIR`），默认工作目录是 `gateway/.data/workspace`（`WORKSPACE_DIR`），都不会碰本机的 `~/.claude`。

> 智能体能在网关所在机器上执行命令、读写文件。默认只监听 `127.0.0.1`；对外开放时务必设置 `API_TOKEN`。
>
> Agent SDK 和 Claude Code 是 Anthropic 专有许可，使用前看一下 [docs/README.md 的「风险」](docs/README.md#9-风险)。
