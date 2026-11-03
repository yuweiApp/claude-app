# CLAUDE.md

项目说明见 [README.md](README.md)，技术方案见 [docs/README.md](docs/README.md)。这里只记录开发流程。

## 常用命令

```bash
# Claude Code 的 shell 不一定读 ~/.profile
export PATH="$HOME/.local/node/bin:$PATH"

# 类型检查（改完代码后都要跑一遍）
npm --prefix gateway run typecheck
npm --prefix client run typecheck
npm --prefix desktop run typecheck
```

## 开发服务

用预览工具按 [.claude/launch.json](.claude/launch.json) 启动，不要用 Bash 起常驻服务：

- `gateway`：`tsx watch src/index.ts`，`127.0.0.1:8788`，配置在 `gateway/.env.local`
- `client`：Vite，`http://localhost:5180`，`/api` 代理到网关

端口和 codex-app-server（8787 / 5173，5173 被占时它的 Vite 会顺延到 5174、5175）错开，两个项目可以同时开。

**网关不要直接从 Claude 桌面版的终端面板或预览工具里起。** 桌面版拉起的进程带 `no_new_privs`，子进程会一路继承：`ping` 靠文件 capability（`cap_net_raw`）拿权限，这时就失效了（报 `missing cap_net_raw+p capability or setuid?`），`sudo` 也用不了。本机 `net.ipv4.ping_group_range` 又是关着的，模型会误判成"宿主机禁了 ICMP"。改在 systemd 用户实例下起，进程就不在桌面版的进程树里：

```bash
systemd-run --user --pty --same-dir --collect --unit=claude-app-gateway --setenv=PATH="$PATH" npm --prefix gateway run dev
```

在项目根目录执行，Ctrl-C 停止。检查方法：`grep NoNewPrivs /proc/<网关 pid>/status` 应为 0。网页（Vite）不受影响，照常起。

桌面版（`desktop/`）会自己拉起网关，同理：从桌面版终端里 `npm start` 起的网关也带 `no_new_privs`。需要 ping 时先用上面的命令单独起网关，桌面版检测到已经在跑就不再拉起。

## 约定

- 网关和网页共用的类型只放 `gateway/src/shared/types.ts`，client 通过 tsconfig paths 引用；SDK 类型也经 paths 从 `gateway/node_modules` 引用，client 不单独装 SDK。
- SDK 消息原样转发给网页，不在网关里另造协议，见技术方案「事件流」。
- 升级 `@anthropic-ai/claude-agent-sdk` 时版本写死（`--save-exact`），升级后用实际模型跑一遍对话、工具调用和权限确认。

## Git

- 文件保持 LF（`.gitattributes`）。
- 提交信息用中文，一句话写清楚改了什么。
- 用户没要求就不提交、不推送。
