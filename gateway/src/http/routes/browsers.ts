import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import { addCustomBrowser, BrowserSettingsError, browserSettingsView, removeCustomBrowser, setTabGroup, updateBrowser } from "../../browser/browser-settings.js";

/** 设置页「浏览器」：检测到的和手动添加的外部浏览器、启用开关、配置、扩展 token。改动对之后启动的会话生效 */
export function browserRoutes(app: FastifyInstance): void {
  const call = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof BrowserSettingsError) throw new BadRequestError(err.message);
      throw err;
    }
  };

  /** 每次都重新检测 */
  app.get("/browsers", async () => browserSettingsView());

  app.patch<{ Body: { tabGroup?: boolean } }>("/browsers", async (req) => {
    if (typeof req.body?.tabGroup === "boolean") setTabGroup(req.body.tabGroup);
    return browserSettingsView();
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; profile?: string | null; token?: string | null } }>("/browsers/:id", async (req) => {
    const { enabled, profile, token } = req.body ?? {};
    call(() =>
      updateBrowser(req.params.id, {
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(profile === null || typeof profile === "string" ? { profile } : {}),
        ...(token === null || typeof token === "string" ? { token } : {}),
      }),
    );
    return browserSettingsView();
  });

  /** 手动添加：返回新的 id 和是不是看着像 Chromium 内核（不像也照样加上，只是提示） */
  app.post<{ Body: { name?: string; executablePath?: string; userDataDir?: string } }>("/browsers", async (req) => {
    const added = call(() => addCustomBrowser({ name: String(req.body?.name ?? ""), executablePath: String(req.body?.executablePath ?? ""), userDataDir: req.body?.userDataDir }));
    return { ...added, view: browserSettingsView() };
  });

  app.delete<{ Params: { id: string } }>("/browsers/:id", async (req) => {
    call(() => removeCustomBrowser(req.params.id));
    return browserSettingsView();
  });
}
