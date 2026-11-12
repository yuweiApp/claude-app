import { useEffect, useSyncExternalStore } from "react";
import { api, type SshConnectionInfo } from "../api";

/**
 * SSH 连接的列表（设置页、新会话的文件夹选择、侧边栏显示主机名用），整个网页共用一份。
 * 第一次用到时取；主页跟会话列表一起定时刷新，设置页打开时、改了以后调 refreshSshConnections。
 * 有连接正在连、正在准备远端时（设置页点的，或者会话用到主机时连的）每秒刷新，进度和连上的结果尽快显示出来
 */
let list: SshConnectionInfo[] = [];
let loaded = false;
let busyTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export function setSshConnections(next: SshConnectionInfo[]): void {
  list = next;
  loaded = true;
  listeners.forEach((l) => l());
  if (!busyTimer && next.some((c) => c.status === "connecting" || c.status === "deploying")) {
    busyTimer = setTimeout(() => {
      busyTimer = null;
      void refreshSshConnections();
    }, 1000);
  }
}

export function refreshSshConnections(): Promise<void> {
  return api.sshConnections().then(setSshConnections, () => undefined);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useSshConnections(): SshConnectionInfo[] {
  useEffect(() => {
    if (!loaded) void refreshSshConnections();
  }, []);
  return useSyncExternalStore(subscribe, () => list);
}

/** 连接的显示名；连接被删了时用 id */
export function sshName(id: string): string {
  return list.find((c) => c.id === id)?.name ?? id;
}
