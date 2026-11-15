import type { FastifyInstance, FastifyReply } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import { CoreApiError, proxyCore } from "../../net/core.js";
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

  // 订阅模式：节点、选节点、测延迟、马上更新订阅（都经代理内核的控制接口，内核没在跑时 503）
  app.get("/proxy/nodes", async (_req, reply) => core(reply, () => proxyCore.nodes()));

  /** name 为 null 是「自动」 */
  app.put<{ Body: { name?: string | null } }>("/proxy/node", async (req, reply) =>
    core(reply, async () => {
      const name = req.body?.name;
      if (name !== null && typeof name !== "string") throw new BadRequestError("name 要是节点名，或者 null（自动）");
      await proxyCore.select(name);
      return proxyCore.nodes();
    }),
  );

  app.post("/proxy/nodes/delay", async (_req, reply) => core(reply, async () => ({ delays: await proxyCore.testDelay(), ...(await proxyCore.nodes()) })));

  app.post("/proxy/subscription/update", async (_req, reply) =>
    core(reply, async () => {
      await proxyCore.update();
      return proxyCore.nodes();
    }),
  );
}

/** 内核控制接口的错误原样带上状态码（节点不存在 400、内核没在跑 503） */
async function core<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CoreApiError) {
      void reply.code(err.status >= 400 && err.status < 600 ? err.status : 502).send({ error: err.message });
      return undefined;
    }
    throw err;
  }
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
    subscriptionUrl: str(b.subscriptionUrl),
    subscriptionInterval: typeof b.subscriptionInterval === "number" ? b.subscriptionInterval : undefined,
  };
}
