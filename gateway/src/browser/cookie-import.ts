import { getDomain } from "tldts";
import type { CookieImportResult, CookieSitesView } from "../shared/types.js";
import { externalCookies } from "./external.js";
import type { BrowserHost } from "./host.js";

/**
 * 设置页「浏览器」的导入登录状态：把外部浏览器（用户的 Chrome 等）里选定站点的 cookie 写进内置浏览器。
 * 分两步，cookie 的值只在网关和桌面版之间传，不给网页：
 * 1. cookieSites：经扩展的连接读出整个配置的 cookie，只回站点和条数；
 * 2. importCookieSites：再读一次（连接已经在了），挑出选定站点的，交给桌面版写进本机会话的分区（desktop/src/browser/cookies.ts 的 importCookies）。
 * 只带过去 cookie，localStorage、IndexedDB 里的登录信息带不过去
 */

/** cookie 的 domain 归到哪个站点：可注册域名（按公共后缀表，包括 github.io 这类私有后缀）；IP、localhost、公共后缀本身是主机本身 */
export function siteOf(domain: string): string {
  const host = domain.replace(/^\./, "").toLowerCase();
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

export async function cookieSites(id: string, signal?: AbortSignal): Promise<CookieSitesView> {
  const cookies = await externalCookies(id, signal);
  const counts = new Map<string, number>();
  for (const c of cookies) {
    const site = siteOf(c.domain);
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  const sites = [...counts].map(([site, count]) => ({ site, count })).sort((a, b) => a.site.localeCompare(b.site));
  return { sites };
}

export async function importCookieSites(id: string, sites: string[], host: BrowserHost, signal?: AbortSignal): Promise<CookieImportResult> {
  const wanted = new Set(sites);
  const cookies = (await externalCookies(id, signal)).filter((c) => wanted.has(siteOf(c.domain)));
  if (!cookies.length) return { imported: 0, failed: [] };
  return host.importCookies(cookies);
}
