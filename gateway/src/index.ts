import { buildApp } from "./app.js";
import { config } from "./config.js";

const { app, sessions } = buildApp();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "正在关闭：结束所有 claude 子进程");
  await sessions.closeAll();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info({ workspaceDir: config.workspaceDir, claudeConfigDir: config.claudeConfigDir }, "gateway 已启动");
