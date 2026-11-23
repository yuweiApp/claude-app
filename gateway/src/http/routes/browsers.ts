import type { FastifyInstance, FastifyReply } from "fastify";
import { addCustomBrowser, browserSettingsView, removeCustomBrowser, setTabGroup, updateBrowser } from "../../browser/browser-settings.js";
import { cookieSites, importCookieSites } from "../../browser/cookie-import.js";
import type { BrowserHost } from "../../browser/host.js";
import { BadRequestError } from "../../errors.js";

/** 设置页「浏览器」：检测到的和手动添加的外部浏览器、启用开关、配置、扩展 token。改动对之后启动的会话生效 */
export function browserRoutes(app: FastifyInstance, host: BrowserHost): void {
  /** 每次都重新检测 */
  app.get("/browsers", async () => browserSettingsView());

  app.patch<{ Body: { tabGroup: boolean } }>("/browsers", async (req) => {
    setTabGroup(req.body.tabGroup);
    return browserSettingsView();
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; profile?: string | null; token?: string | null } }>("/browsers/:id", async (req) => {
    updateBrowser(req.params.id, req.body);
    return browserSettingsView();
  });

  /** 手动添加：返回新的 id 和是不是看着像 Chromium 内核（不像也照样加上，只是提示） */
  app.post<{ Body: { name: string; executablePath: string; userDataDir?: string } }>("/browsers", async (req) => {
    const added = addCustomBrowser(req.body);
    return { ...added, view: browserSettingsView() };
  });

  app.delete<{ Params: { id: string } }>("/browsers/:id", async (req) => {
    removeCustomBrowser(req.params.id);
    return browserSettingsView();
  });

  /**
   * 导入登录状态（browser/cookie-import.ts）：先列出这个浏览器里有 cookie 的站点，再把选定站点的写进内置浏览器。
   * 没连上时要等用户在浏览器的连接页上点允许，不限时；网页不等了（关掉对话框、断开）就不再等
   */
  const importing = async <T>(reply: FastifyReply, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!host.connected) throw new BadRequestError("内置浏览器只在桌面版里有：桌面版没有运行，或者还没连上网关");
    const abort = new AbortController();
    const onClose = () => abort.abort();
    reply.raw.once("close", onClose);
    try {
      return await fn(abort.signal);
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      reply.raw.off("close", onClose);
    }
  };

  app.post<{ Params: { id: string } }>("/browsers/:id/cookies", async (req, reply) => importing(reply, (signal) => cookieSites(req.params.id, signal)));

  app.post<{ Params: { id: string }; Body: { sites: string[] } }>("/browsers/:id/cookies/import", async (req, reply) => {
    if (!req.body.sites.length) throw new BadRequestError("没有选站点");
    return importing(reply, (signal) => importCookieSites(req.params.id, req.body.sites, host, signal));
  });
}
