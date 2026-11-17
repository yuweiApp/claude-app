import { buildApp } from "./app.js";
import { config } from "./config.js";
import { initProxy, stopProxy } from "./net/proxy.js";
import { disconnectAll } from "./ssh/hosts.js";

// 网关自己发的请求（fetch 等）按设置页「网络代理」走，要在发出任何请求之前设好
await initProxy();

const { app, sessions, terminals, lan } = buildApp();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "正在关闭：结束所有 claude 子进程");
  terminals.closeAll();
  await lan.close();
  await sessions.closeAll();
  await stopProxy();
  disconnectAll();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info({ workspaceDir: config.workspaceDir, claudeConfigDir: config.claudeConfigDir }, "gateway 已启动");
// 有局域网分享（上次留下的）就开始监听局域网入口；失败只记日志，网关照常用
await lan.sync();
