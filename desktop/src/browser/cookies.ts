import { WebContentsView, type Cookie, type CookiesSetDetails, type Session } from "electron";

/**
 * 浏览器级的 Storage.getCookies / setCookies / clearCookies（CDP 代理的 browserCommand 用）。
 * Playwright 的 context.cookies()、addCookies()、clearCookies() 发的就是这几条，
 * page.request / context.request 发请求前也要先取 cookie、收到 Set-Cookie 后写回去。
 * 调试接口挂在单个标签页上，没有浏览器级的 Storage 域，这里用标签页共用的 Electron 会话的 cookies 接口实现，
 * 和 CDP 的 Network.Cookie 格式互相转换
 */

/** CDP 的 Network.Cookie（只列 Playwright 用到的） */
interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** 秒；会话 cookie 是 -1 */
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** CDP 的 Network.CookieParam（Storage.setCookies 的 cookies 一项） */
interface CdpCookieParam {
  name?: unknown;
  value?: unknown;
  url?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  sameSite?: unknown;
  expires?: unknown;
}

/** cookie 的 domain 换成网址里的主机：去掉前导点，IPv6 地址加方括号 */
const hostOf = (domain: string) => {
  const host = domain.replace(/^\./, "");
  return host.includes(":") ? `[${host}]` : host;
};

const TO_CDP_SAME_SITE ={ strict: "Strict", lax: "Lax", no_restriction: "None" } as const;
const FROM_CDP_SAME_SITE = { Strict: "strict", Lax: "lax", None: "no_restriction" } as const;

export async function getCookies(ses: Session): Promise<{ cookies: CdpCookie[] }> {
  const list = await ses.cookies.get({});
  return { cookies: list.map(toCdp) };
}

export async function setCookies(ses: Session, params: Record<string, unknown>): Promise<object> {
  const cookies = Array.isArray(params.cookies) ? (params.cookies as CdpCookieParam[]) : [];
  // 和 Chrome 一样，有一个设置失败整条命令报错
  await Promise.all(cookies.map((cookie) => ses.cookies.set(fromCdp(cookie))));
  return {};
}

export async function clearCookies(ses: Session): Promise<object> {
  await ses.clearStorageData({ storages: ["cookies"] });
  return {};
}

function toCdp(c: Cookie): CdpCookie {
  const sameSite = c.sameSite ? TO_CDP_SAME_SITE[c.sameSite as keyof typeof TO_CDP_SAME_SITE] : undefined;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? "",
    path: c.path ?? "/",
    expires: c.session || c.expirationDate === undefined ? -1 : c.expirationDate,
    size: c.name.length + c.value.length,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    session: !!c.session,
    ...(sameSite ? { sameSite } : {}),
  };
}

function fromCdp(c: CdpCookieParam): CookiesSetDetails {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const domain = str(c.domain);
  const path = str(c.path);
  const secure = typeof c.secure === "boolean" ? c.secure : undefined;
  // Electron 必须给 url：没给时用 domain、path 拼一个（去掉表示子域名也适用的前导点）
  let url = str(c.url);
  if (!url) {
    if (!domain) throw new Error(`Cookie ${String(c.name)} 没有 url，也没有 domain`);
    url = `${secure ? "https" : "http"}://${hostOf(domain)}${path ?? "/"}`;
  }
  const sameSite = str(c.sameSite) as keyof typeof FROM_CDP_SAME_SITE | undefined;
  const expires = typeof c.expires === "number" && c.expires > 0 ? c.expires : undefined;
  return {
    url,
    name: str(c.name),
    value: str(c.value),
    // CDP 里 domain 不带前导点的是 host-only cookie（只发给这个主机）。Electron 收到 domain 一律补上前导点、当成子域名也适用的，
    // __Host- 开头的还会因为带了 Domain 被拒，所以 host-only 的不传 domain，由 url 定主机
    domain: domain?.startsWith(".") ? domain : undefined,
    path,
    secure,
    httpOnly: typeof c.httpOnly === "boolean" ? c.httpOnly : undefined,
    expirationDate: expires,
    sameSite: sameSite && FROM_CDP_SAME_SITE[sameSite] ? FROM_CDP_SAME_SITE[sameSite] : undefined,
  };
}

/**
 * 从外部浏览器导入的一条 cookie：Playwright context.cookies() 的格式（网关 browser/cookie-import.ts 读出来、经 /browser/host 发来，两边各写一份）。
 * domain 带前导点的是子域名也适用的，不带的是 host-only；expires 是秒，会话 cookie 是 -1；
 * 分区 cookie 带 partitionKey（顶层站点，如 https://example.com）和 _crHasCrossSiteAncestor
 */
export interface ImportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: string;
  _crHasCrossSiteAncestor?: boolean;
}

/** 导入结果：写进去的条数，写不进去的每条的域名、名字和原因 */
export interface ImportCookiesResult {
  imported: number;
  failed: { domain: string; name: string; error: string }[];
}

/**
 * 把外部浏览器的 cookie 写进一个分区（内置浏览器的登录状态）。
 * 不用 session.cookies.set：它没有 partitionKey，分区 cookie 会写成普通的。改在这个分区里开一个不显示的网页视图，
 * 经它的调试接口逐条发 Network.setCookie（和 Chrome 自己的写法一致：domain 不带点就是 host-only，__Host- 也写得进），写完关掉
 */
export async function importCookies(partition: string, cookies: ImportedCookie[]): Promise<ImportCookiesResult> {
  const view = new WebContentsView({ webPreferences: { partition, javascript: false } });
  const wc = view.webContents;
  const result: ImportCookiesResult = { imported: 0, failed: [] };
  try {
    await wc.loadURL("about:blank");
    wc.debugger.attach("1.3");
    for (const c of cookies) {
      try {
        await wc.debugger.sendCommand("Network.setCookie", toSetCookieParams(c));
        result.imported++;
      } catch (err) {
        result.failed.push({ domain: c.domain, name: c.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach();
    wc.close();
  }
  return result;
}

/** 换成 CDP Network.setCookie 的参数：host-only 的给 url 不给 domain，子域名也适用的给带点的 domain */
function toSetCookieParams(c: ImportedCookie): Record<string, unknown> {
  const path = c.path || "/";
  return {
    name: c.name,
    value: c.value,
    ...(c.domain.startsWith(".") ? { domain: c.domain } : { url: `${c.secure ? "https" : "http"}://${hostOf(c.domain)}${path}` }),
    path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    ...(c.expires > 0 ? { expires: c.expires } : {}),
    ...(c.partitionKey ? { partitionKey: { topLevelSite: c.partitionKey, hasCrossSiteAncestor: c._crHasCrossSiteAncestor ?? true } } : {}),
  };
}
