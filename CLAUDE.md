# CLAUDE.md

项目说明见 [README.md](README.md)，技术方案见 [docs/README.md](docs/README.md)。这里只记录开发流程。

## 常用命令

```bash
# Claude Code 的 shell 不一定读 ~/.profile
export PATH="$HOME/.local/node/bin:$PATH"

# 类型检查（改完代码后都要跑一遍）
npm --prefix gateway run typecheck
npm --prefix client run typecheck
```

## 开发服务

用预览工具按 [.claude/launch.json](.claude/launch.json) 启动，不要用 Bash 起常驻服务：

- `gateway`：`tsx watch src/index.ts`，`127.0.0.1:8788`，配置在 `gateway/.env.local`
- `client`：Vite，`http://localhost:5174`，`/api` 代理到网关

端口和 codex-app-server（8787 / 5173）错开，两个项目可以同时开。

## 约定

- 网关和网页共用的类型只放 `gateway/src/shared/types.ts`，client 通过 tsconfig paths 引用；SDK 类型也经 paths 从 `gateway/node_modules` 引用，client 不单独装 SDK。
- SDK 消息原样转发给网页，不在网关里另造协议，见技术方案「事件流」。
- 升级 `@anthropic-ai/claude-agent-sdk` 时版本写死（`--save-exact`），升级后用实际模型跑一遍对话、工具调用和权限确认。

## Git

- 文件保持 LF（`.gitattributes`）。
- 提交信息用中文，一句话写清楚改了什么。
- 用户没要求就不提交、不推送。
