import { useSyncExternalStore } from "react";

/**
 * 颜色模式（同 codex-app-server 的 theme.ts）：浅色 / 深色 / 跟随系统，记在 localStorage。
 * <html> 上的 data-theme 总是实际生效的 light 或 dark（跟随系统时按系统设置算出来），样式只认这个属性，不再直接用 prefers-color-scheme。
 * index.html 里有一段同样逻辑的内联脚本，在样式加载前就设好，刷新时不会先闪一下浅色。
 */
export type Theme = "light" | "dark" | "system";

const KEY = "theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let current = read();

/** 当前实际是不是深色（跟随系统时看系统设置） */
export function isDark(): boolean {
  return current === "dark" || (current === "system" && darkQuery.matches);
}

function apply() {
  document.documentElement.dataset.theme = isDark() ? "dark" : "light";
}
apply();

const notify = () => listeners.forEach((l) => l());
darkQuery.addEventListener("change", () => {
  apply();
  notify();
});

export function setTheme(theme: Theme) {
  current = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // 无痕模式等存不了时，只在本次打开期间生效
  }
  apply();
  notify();
}

/** 颜色模式或系统深浅色变化时回调；返回取消订阅的函数 */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 设置里选的颜色模式 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, () => current);
}

/** 当前实际是不是深色 */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeTheme, isDark);
}
