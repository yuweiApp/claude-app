import { useEffect, useSyncExternalStore } from "react";
import { api, type SshConnectionInfo } from "../api";

/**
 * SSH 连接的列表（设置页、新会话的文件夹选择、侧边栏显示主机名用），整个网页共用一份。
 * 第一次用到时取，设置页改了调 refreshSshConnections
 */
let list: SshConnectionInfo[] = [];
let loaded = false;
const listeners = new Set<() => void>();

export function setSshConnections(next: SshConnectionInfo[]): void {
  list = next;
  loaded = true;
  listeners.forEach((l) => l());
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
