import type { FastifyInstance } from "fastify";
import { proxyCore } from "../../net/core.js";
import { proxySettingsView, saveProxySettings, testProxy } from "../../net/proxy.js";
import type { ProxySettingsInput } from "../../shared/types.js";

/**
 * 设置页「网络代理」：网关自己的请求马上按新设置走；claude 子进程的环境变量变了的，
 * 空闲会话马上换掉子进程（下次发消息时 resume），正在跑的这一轮结束后再换（见 SessionManager.recycleProxyStale）
 */
export function proxyRoutes(app: FastifyInstance): void {
  app.get("/proxy", async () => proxySettingsView());

  app.put<{ Body: ProxySettingsInput }>("/proxy", async (req) => saveProxySettings(req.body));

  /** 按请求体里的设置测一次，不保存 */
  app.post<{ Body: ProxySettingsInput }>("/proxy/test", async (req) => testProxy(req.body));

  // 订阅模式：节点、选节点、测延迟、马上更新订阅（都经代理内核的控制接口，内核的错误原样带上状态码：节点不存在 400、内核没在跑 503）
  app.get("/proxy/nodes", async () => proxyCore.nodes());

  /** name 为 null 是「自动」 */
  app.put<{ Body: { name: string | null } }>("/proxy/node", async (req) => {
    await proxyCore.select(req.body.name);
    return proxyCore.nodes();
  });

  app.post("/proxy/nodes/delay", async () => ({ delays: await proxyCore.testDelay(), ...(await proxyCore.nodes()) }));

  app.post("/proxy/subscription/update", async () => {
    await proxyCore.update();
    return proxyCore.nodes();
  });
}
