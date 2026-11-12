import { useSyncExternalStore } from "react";
import { desktop, type BrowserDownload } from "../desktop";

/**
 * 内置浏览器里的下载（只有桌面版有）：页面加载时就订阅外壳推来的变化，不等标签页的组件挂上，
 * 点开一个直接下载的链接时，新标签页还没显示出来下载就可能已经开始了。
 * 下载条上关掉的记在 dismissed 里，之后不再显示（外壳那边的记录不动）
 */
let all: BrowserDownload[] = [];
const dismissed = new Set<string>();
const listeners = new Set<() => void>();
const cache = new Map<string, BrowserDownload[]>();

function update(next: BrowserDownload[]): void {
  all = next;
  cache.clear();
  for (const l of listeners) l();
}

const browser = desktop?.browser;
if (browser?.onDownload) {
  browser.onDownload((d) => {
    const i = all.findIndex((x) => x.guid === d.guid);
    update(i < 0 ? [...all, d] : all.map((x, j) => (j === i ? d : x)));
  });
  void browser.downloads().then((list) => {
    // 先推来的（更新）为准
    const known = new Set(all.map((d) => d.guid));
    update([...list.filter((d) => !known.has(d.guid)), ...all].sort((a, b) => a.startTime - b.startTime));
  }, () => undefined);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** 这个标签页里没关掉的下载，先开始的在前 */
function downloadsOf(tabId: string): BrowserDownload[] {
  let list = cache.get(tabId);
  if (!list) {
    list = all.filter((d) => d.tabId === tabId && !dismissed.has(d.guid));
    cache.set(tabId, list);
  }
  return list;
}

export function useTabDownloads(tabId: string): BrowserDownload[] {
  return useSyncExternalStore(subscribe, () => downloadsOf(tabId));
}

/** 下载条上关掉这几个 */
export function dismissDownloads(guids: string[]): void {
  for (const g of guids) dismissed.add(g);
  update(all);
}
