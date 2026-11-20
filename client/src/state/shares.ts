import { useEffect, useSyncExternalStore } from "react";
import { api, type SharesView } from "../api";

/**
 * 局域网分享、公网分享（见 docs/lan-share.md）：本机侧栏用的分享列表，整个网页共用一份。
 * 第一次用到时取；主页跟会话列表一起定时刷新（访客清空会话后分享换了 id），开关分享后用接口返回的
 */
let view: SharesView | null = null;
/** 侧栏底部的提示（链接已复制、出错了），几秒后消失 */
let notice: string | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function setView(next: SharesView): void {
  view = next;
  emit();
}

export function refreshShares(): Promise<void> {
  return api.shares().then(setView, () => undefined);
}

function showNotice(text: string): void {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = null;
    emit();
  }, 4000);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useShares(): SharesView | null {
  useEffect(() => {
    if (!view) void refreshShares();
  }, []);
  return useSyncExternalStore(subscribe, () => view);
}

export function useShareNotice(): string | null {
  return useSyncExternalStore(subscribe, () => notice);
}

/** 这个会话的局域网分享链接，每个局域网地址一条；没分享到局域网时空数组 */
export function shareLinks(v: SharesView | null, sessionId: string): { address: string; url: string }[] {
  const share = v?.shares.find((s) => s.sessionId === sessionId);
  if (!v || !share?.lan) return [];
  // 一个局域网地址都没有（没联网）时用页面自己的主机名，至少本机能打开
  const addresses = v.addresses.length ? v.addresses : [location.hostname];
  return addresses.map((address) => ({ address, url: `http://${address}:${v.port}/share/${share.token}` }));
}

/** 这个会话的公网分享链接；没分享到公网、还没连上服务器时是 null */
export function publicShareLink(v: SharesView | null, sessionId: string): string | null {
  const share = v?.shares.find((s) => s.sessionId === sessionId);
  if (!v?.tunnel.url || !share?.public) return null;
  return `${v.tunnel.url}/share/${share.token}`;
}

async function copy(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    showNotice(`分享链接已复制：${url}`);
  } catch {
    showNotice(`分享链接：${url}`);
  }
}

export async function startShare(sessionId: string): Promise<void> {
  try {
    const next = await api.shareSession(sessionId);
    setView(next);
    const first = shareLinks(next, sessionId)[0];
    if (first) await copy(first.url);
  } catch (e) {
    showNotice(`分享失败：${(e as Error).message}`);
  }
}

export async function stopShare(sessionId: string): Promise<void> {
  try {
    const next = await api.unshareSession(sessionId);
    setView(next);
    const publicLeft = next.shares.some((s) => s.sessionId === sessionId && s.public);
    showNotice(publicLeft ? "已停止局域网分享，经公网打开的访客不受影响" : "已停止分享，访客的页面已断开");
  } catch (e) {
    showNotice(`停止分享失败：${(e as Error).message}`);
  }
}

/** 分享到公网：连上设置里的服务器（没连着、上次出错时），自检通过后复制链接。已经分享了再调用就是重新复制 */
export async function startPublicShare(sessionId: string): Promise<void> {
  showNotice("正在连接服务器…");
  try {
    const next = await api.shareSessionPublic(sessionId);
    setView(next);
    const url = publicShareLink(next, sessionId);
    if (url) await copy(url);
    else showNotice("公网地址还没就绪，稍后再点「复制公网链接」");
  } catch (e) {
    showNotice(`分享到公网失败：${(e as Error).message}`);
  }
}

export async function stopPublicShare(sessionId: string): Promise<void> {
  try {
    const next = await api.unshareSessionPublic(sessionId);
    setView(next);
    const lanLeft = next.shares.some((s) => s.sessionId === sessionId && s.lan);
    showNotice(lanLeft ? "已停止公网分享，局域网里的访客不受影响" : "已停止分享，访客的页面已断开");
  } catch (e) {
    showNotice(`停止公网分享失败：${(e as Error).message}`);
  }
}

export function copyShareLink(url: string): void {
  void copy(url);
}
