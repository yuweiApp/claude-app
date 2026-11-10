import { useSyncExternalStore } from "react";

/**
 * 皮肤（同 codex-app-server 的 skin.ts，只取了暖白画布和极光两款）：只改外观，不动功能。
 * 选了皮肤时在 <html> 上设 data-skin 和几个颜色变量，skins.css 据此换配色、铺背景；深浅色仍由颜色模式（theme.ts）决定，皮肤在两种下都能用。
 * 选的皮肤 id 存在 localStorage 的 skin 里；index.html 的内联脚本在样式生效前就套上，变量的值和这里的预设一致。
 */
export interface SkinPreset {
  id: string;
  name: string;
  desc: string;
  /** 浅色下的强调色（按钮、选中、链接） */
  accent: string;
  /** 深色下的强调色 */
  darkAccent: string;
  /** 背景里三团光晕的颜色；实色皮肤没有光晕 */
  colors?: [string, string, string];
}

export const SKIN_PRESETS: SkinPreset[] = [
  {
    id: "warm-canvas",
    name: "暖白画布",
    desc: "暖白画布：浅色维米尔，深色伦勃朗",
    accent: "#3f5b7d",
    darkAccent: "#c9a46a",
  },
  {
    id: "aurora",
    name: "极光",
    desc: "紫色到青色的流动光带",
    accent: "#7c5cff",
    darkAccent: "#a18bff",
    colors: ["#7c5cff", "#2dd4bf", "#60a5fa"],
  },
];

const KEY = "skin";
const listeners = new Set<() => void>();

function read(): SkinPreset | null {
  try {
    const id = localStorage.getItem(KEY);
    return SKIN_PRESETS.find((p) => p.id === id) ?? null;
  } catch {
    return null;
  }
}

let current = read();

/** 皮肤的变量写在 <html> 上：预览卡片也用同样的变量名，各自写在卡片上 */
export function skinVars(p: SkinPreset): Record<string, string> {
  const vars: Record<string, string> = { "--skin-accent": p.accent, "--skin-accent-dark": p.darkAccent };
  p.colors?.forEach((c, i) => (vars[`--skin-c${i + 1}`] = c));
  return vars;
}

const VARS = ["--skin-accent", "--skin-accent-dark", "--skin-c1", "--skin-c2", "--skin-c3"];

/** 与 index.html 里的内联脚本一致 */
function apply() {
  const root = document.documentElement;
  for (const v of VARS) root.style.removeProperty(v);
  if (!current) {
    delete root.dataset.skin;
    return;
  }
  root.dataset.skin = current.id;
  for (const [k, v] of Object.entries(skinVars(current))) root.style.setProperty(k, v);
}
apply();

/** 换皮肤；null 是原来的外观 */
export function setSkin(preset: SkinPreset | null) {
  current = preset;
  try {
    if (preset) localStorage.setItem(KEY, preset.id);
    else localStorage.removeItem(KEY);
  } catch {
    // 存不了时只在本次打开期间生效
  }
  apply();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前皮肤（null 是原来的外观） */
export function useSkin(): SkinPreset | null {
  return useSyncExternalStore(subscribe, () => current);
}
