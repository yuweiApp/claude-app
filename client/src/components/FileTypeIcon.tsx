import { useEffect, useSyncExternalStore } from "react";
import { useIsDark } from "../theme";

/**
 * 文件、文件夹图标（文件树、@ 引用文件的候选、面板标签页共用），同 codex-app-server 的 fileIcons.tsx：
 * 用 Material Icon Theme 按文件名、扩展名、文件夹名显示彩色图标（见 fileIconTheme.ts）。
 * 映射表按需加载，加载好之前先占好位置，加载完所有图标一起显示
 */

type IconTheme = typeof import("./fileIconTheme");

let theme: IconTheme | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function loadTheme() {
  loading ??= import("./fileIconTheme").then(
    (m) => {
      theme = m;
      listeners.forEach((l) => l());
    },
    () => {
      // 加载失败：下次再用到时重试
      loading = null;
    },
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 图标主题（还没加载好时 null）和当前是不是深色界面（浅色界面有的图标换浅色版） */
function useIconTheme() {
  useEffect(loadTheme, []);
  const t = useSyncExternalStore(subscribe, () => theme);
  const dark = useIsDark();
  return { theme: t, dark };
}

function IconImg({ src, size, className }: { src: string | undefined; size: number; className?: string }) {
  const cls = className ? `file-type-icon ${className}` : "file-type-icon";
  // 还没加载好：空着占位，不跳动
  if (!src) return <span className={cls} style={{ width: size, height: size }} aria-hidden="true" />;
  return <img className={cls} src={src} width={size} height={size} alt="" draggable={false} aria-hidden="true" />;
}

/** 文件图标，按文件名、扩展名 */
export function FileTypeIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const { theme: t, dark } = useIconTheme();
  return <IconImg src={t?.fileIconUrl(name, dark)} size={size} className={className} />;
}

/** 文件夹图标（展开时是打开的文件夹），按名字显示（src、node_modules、.git 等） */
export function FolderTypeIcon({ open, name = "", size = 16, className }: { open: boolean; name?: string; size?: number; className?: string }) {
  const { theme: t, dark } = useIconTheme();
  return <IconImg src={t?.folderIconUrl(name, open, dark)} size={size} className={className} />;
}
