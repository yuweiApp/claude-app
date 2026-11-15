import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import { ProxySettingsError, proxySettingsView, saveProxySettings, testProxy } from "../../net/proxy.js";
import type { ProxySettingsInput } from "../../shared/types.js";

/**
 * 设置页「网络代理」：网关自己的请求马上按新设置走；claude 子进程的环境变量变了的，
 * 空闲会话马上换掉子进程（下次发消息时 resume），正在跑的这一轮结束后再换（见 SessionManager.recycleProxyStale）
 */
export function proxyRoutes(app: FastifyInstance): void {
  app.get("/proxy", async () => proxySettingsView());

  app.put<{ Body: ProxySettingsInput }>("/proxy", async (req) => {
    try {
      return saveProxySettings(input(req.body));
    } catch (err) {
      if (err instanceof ProxySettingsError) throw new BadRequestError(err.message);
      throw err;
    }
  });

  /** 按请求体里的设置测一次，不保存 */
  app.post<{ Body: ProxySettingsInput }>("/proxy/test", async (req) => testProxy(input(req.body)));
}

function input(body: ProxySettingsInput | undefined): ProxySettingsInput {
  const b = body ?? ({} as ProxySettingsInput);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    mode: b.mode,
    url: str(b.url),
    username: str(b.username),
    password: str(b.password),
    noProxy: Array.isArray(b.noProxy) ? b.noProxy.filter((v): v is string => typeof v === "string") : undefined,
  };
}
