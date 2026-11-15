import { buildApp } from "./app.js";
import { config } from "./config.js";
import { initProxy } from "./net/proxy.js";
import { disconnectAll } from "./ssh/hosts.js";

// 网关自己发的请求（fetch 等）按设置页「网络代理」走，要在发出任何请求之前设好
await initProxy();

const { app, sessions, terminals } = buildApp();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "正在关闭：结束所有 claude 子进程");
  terminals.closeAll();
  await sessions.closeAll();
  disconnectAll();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info({ workspaceDir: config.workspaceDir, claudeConfigDir: config.claudeConfigDir }, "gateway 已启动");
