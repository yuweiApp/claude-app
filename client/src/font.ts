import { useSyncExternalStore } from "react";

/**
 * 字体（设置「外观」里的「字体」）：界面字体、代码字体、对话字号，记在 localStorage 的 font 里（JSON）。
 * 生效方式是在 <html> 的 style 上设 --font-ui、--font-mono、--chat-font-size，没改过的不设，用 styles.css :root 里的默认值。
 * index.html 的内联脚本按同样的逻辑在样式生效前套上，刷新时不先闪一下默认字体。
 */
export interface FontPreset {
  id: string;
  label: string;
  /** CSS font-family；默认那一项为空，用 styles.css 里的 */
  family: string;
}

/** 选「自定义」时的 id，字体名在 uiCustom / monoCustom 里 */
export const CUSTOM_FONT = "custom";

export const UI_FONTS: FontPreset[] = [
  { id: "default", label: "系统默认", family: "" },
  { id: "sans", label: "黑体（苹方、微软雅黑）", family: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif' },
  { id: "serif", label: "宋体（衬线）", family: 'Georgia, "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", SimSun, serif' },
  { id: "kai", label: "楷体", family: '"Kaiti SC", STKaiti, KaiTi, "AR PL UKai CN", serif' },
];

export const MONO_FONTS: FontPreset[] = [
  { id: "default", label: "系统默认", family: "" },
  { id: "cascadia", label: "Cascadia Code", family: '"Cascadia Code", "Cascadia Mono", ui-monospace, Consolas, monospace' },
  { id: "sf", label: "SF Mono / Menlo", family: '"SF Mono", SFMono-Regular, Menlo, ui-monospace, monospace' },
  { id: "jetbrains", label: "JetBrains Mono", family: '"JetBrains Mono", ui-monospace, Consolas, monospace' },
  { id: "consolas", label: "Consolas", family: 'Consolas, "Courier New", monospace' },
];

/** 对话字号（像素）：消息和输入框的正文 */
export const CHAT_SIZE = { min: 12, max: 20, default: 15 };

export interface FontSettings {
  ui: string;
  uiCustom: string;
  mono: string;
  monoCustom: string;
  size: number;
}

const KEY = "font";
const DEFAULTS: FontSettings = { ui: "default", uiCustom: "", mono: "default", monoCustom: "", size: CHAT_SIZE.default };
const listeners = new Set<() => void>();

function read(): FontSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<FontSettings> | null;
    return v && typeof v === "object" ? normalize({ ...DEFAULTS, ...v }) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function normalize(s: FontSettings): FontSettings {
  const size = Number.isFinite(s.size) ? Math.min(CHAT_SIZE.max, Math.max(CHAT_SIZE.min, Math.round(s.size))) : CHAT_SIZE.default;
  return {
    ui: s.ui === CUSTOM_FONT || UI_FONTS.some((p) => p.id === s.ui) ? s.ui : "default",
    uiCustom: typeof s.uiCustom === "string" ? s.uiCustom : "",
    mono: s.mono === CUSTOM_FONT || MONO_FONTS.some((p) => p.id === s.mono) ? s.mono : "default",
    monoCustom: typeof s.monoCustom === "string" ? s.monoCustom : "",
    size,
  };
}

let current = read();

/** 用户填的字体名转成 font-family：逗号分开的每一项，没加引号的加上引号（CSS 通用族名除外），最后接上兜底的通用族 */
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-monospace", "ui-sans-serif", "ui-serif", "ui-rounded"]);
export function customFamily(text: string, fallback: string): string {
  const names = text
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => (/^["']/.test(n) || GENERIC.has(n.toLowerCase()) ? n : `"${n.replace(/"/g, "")}"`));
  return names.length ? `${names.join(", ")}, ${fallback}` : "";
}

function family(id: string, custom: string, presets: FontPreset[], fallback: string): string {
  if (id === CUSTOM_FONT) return customFamily(custom, fallback);
  return presets.find((p) => p.id === id)?.family ?? "";
}

function apply() {
  const style = document.documentElement.style;
  const set = (name: string, value: string) => (value ? style.setProperty(name, value) : style.removeProperty(name));
  set("--font-ui", family(current.ui, current.uiCustom, UI_FONTS, "sans-serif"));
  set("--font-mono", family(current.mono, current.monoCustom, MONO_FONTS, "monospace"));
  set("--chat-font-size", current.size === CHAT_SIZE.default ? "" : `${current.size}px`);
}
apply();

export function updateFont(patch: Partial<FontSettings>) {
  current = normalize({ ...current, ...patch });
  try {
    const changed = (Object.keys(DEFAULTS) as (keyof FontSettings)[]).some((k) => current[k] !== DEFAULTS[k]);
    if (changed) localStorage.setItem(KEY, JSON.stringify(current));
    else localStorage.removeItem(KEY);
  } catch {
    // 存不了时只在本次打开期间生效
  }
  apply();
  listeners.forEach((l) => l());
}

/** 字体设置变化时回调；返回取消订阅的函数 */
export function subscribeFont(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFont(): FontSettings {
  return useSyncExternalStore(subscribeFont, () => current);
}

/** 当前实际生效的代码字体（给 xterm、CodeMirror 这类要直接传字体名的地方） */
export function monoFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
}

/**
 * 本机装的字体（族名，去重排序）。用浏览器的 Local Font Access（queryLocalFonts），要在用户操作里调用；
 * 不支持或没给权限时返回空数组
 */
export async function localFontFamilies(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!query) return [];
  try {
    const fonts = await query();
    return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
