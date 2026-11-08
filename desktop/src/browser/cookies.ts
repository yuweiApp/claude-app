import type { Cookie, CookiesSetDetails, Session } from "electron";

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

const TO_CDP_SAME_SITE = { strict: "Strict", lax: "Lax", no_restriction: "None" } as const;
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
    url = `${secure ? "https" : "http"}://${domain.replace(/^\./, "")}${path ?? "/"}`;
  }
  const sameSite = str(c.sameSite) as keyof typeof FROM_CDP_SAME_SITE | undefined;
  const expires = typeof c.expires === "number" && c.expires > 0 ? c.expires : undefined;
  return {
    url,
    name: str(c.name),
    value: str(c.value),
    domain,
    path,
    secure,
    httpOnly: typeof c.httpOnly === "boolean" ? c.httpOnly : undefined,
    expirationDate: expires,
    sameSite: sameSite && FROM_CDP_SAME_SITE[sameSite] ? FROM_CDP_SAME_SITE[sameSite] : undefined,
  };
}
