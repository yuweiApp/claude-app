import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api";

/**
 * Claude 回复里像文件路径的行内代码，问网关是不是工作目录里存在的文件（POST /files/exists）。
 * 同一时刻要问的攒成一批发；存在的一直记着，不存在的过一会儿再问（文件可能是这一轮刚写的）
 */

const RETRY_MS = 5000;
type Entry = { exists: true } | { exists: false; at: number } | { pending: true };

const cache = new Map<string, Entry>();
const queue = new Map<string, Set<string>>();
let scheduled = false;
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

const keyOf = (cwd: string, path: string) => `${cwd}\n${path}`;

function flush() {
  scheduled = false;
  const batches = [...queue];
  queue.clear();
  for (const [cwd, set] of batches) {
    const paths = [...set];
    api.filesExist(cwd, paths).then(
      (exists) => {
        const yes = new Set(exists);
        const at = Date.now();
        for (const p of paths) cache.set(keyOf(cwd, p), yes.has(p) ? { exists: true } : { exists: false, at });
        notify();
      },
      () => {
        const at = Date.now();
        for (const p of paths) cache.set(keyOf(cwd, p), { exists: false, at });
        notify();
      },
    );
  }
}

function request(cwd: string, path: string) {
  const key = keyOf(cwd, path);
  const entry = cache.get(key);
  if (entry && ("pending" in entry || entry.exists || Date.now() - entry.at < RETRY_MS)) return;
  cache.set(key, { pending: true });
  let set = queue.get(cwd);
  if (!set) queue.set(cwd, (set = new Set()));
  set.add(path);
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 0);
  }
}

/** path（相对 cwd）是不是存在的文件；还不知道时是 false，问到了再重新渲染。path 为 null 时不问 */
export function useFileExists(cwd: string | null, path: string | null): boolean {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (cwd && path) request(cwd, path);
  });
  if (!cwd || !path) return false;
  const entry = cache.get(keyOf(cwd, path));
  return !!entry && "exists" in entry && entry.exists;
}
