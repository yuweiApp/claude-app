import { useSyncExternalStore } from "react";

/**
 * 右侧面板里改了没保存的文件内容（同 codex-app-server 的 state/fileDrafts）：
 * 切到别的标签页再回来还在，标签页上显示圆点，关标签页时问要不要丢掉。键是「项目文件夹 + 相对路径」
 */
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

const key = (cwd: string, path: string) => `${cwd}\n${path}`;
const emit = () => listeners.forEach((l) => l());

export function getDraft(cwd: string, path: string): string | undefined {
  return drafts.get(key(cwd, path));
}

export function setDraft(cwd: string, path: string, text: string | undefined): void {
  const k = key(cwd, path);
  if (text === undefined ? !drafts.has(k) : drafts.get(k) === text) return;
  if (text === undefined) drafts.delete(k);
  else drafts.set(k, text);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHasDraft(cwd: string, path: string | null): boolean {
  return useSyncExternalStore(subscribe, () => path !== null && drafts.has(key(cwd, path)));
}
