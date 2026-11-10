import { useSyncExternalStore } from "react";

/**
 * 皮肤（同 codex-app-server 的 skin.ts，取了暖白画布、极光两款，加自定义背景图）：只改外观，不动功能。
 * 选了皮肤时在 <html> 上设 data-skin 和几个颜色变量，skins.css 据此换配色、铺背景；透出背景的皮肤（光晕或图片）另有 data-skin-bg。
 * 深浅色仍由颜色模式（theme.ts）决定，皮肤在两种下都能用。
 * 设置存在 localStorage：skin 是选的皮肤 id，skin-adjust 是每款皮肤各自调过的强调色和遮罩（换去别的皮肤再换回来时沿用），
 * skin-image 是自定义背景图（压缩后的 data URL）。index.html 的内联脚本按同样的逻辑在样式生效前套上。
 */
export interface SkinPreset {
  id: string;
  name: string;
  desc: string;
  /** 浅色下的强调色（按钮、选中、链接） */
  accent: string;
  /** 深色下的强调色；用户调过强调色后两种模式共用调过的颜色 */
  darkAccent: string;
  /** 背景里三团光晕的颜色；没有的是实色皮肤，不能调遮罩 */
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

/** 自定义背景图的皮肤 id */
export const CUSTOM_SKIN = "custom";

/** 遮罩：盖在背景上的内容区底色浓度（百分比）。背景图默认盖得浓一些，字才看得清 */
export const veilRange = (image: boolean) => ({ min: image ? 30 : 0, max: 95 });
const defaultVeil = (image: boolean) => (image ? 70 : 40);

interface Adjust {
  accent?: string;
  veil?: number;
}

const KEY = "skin";
const ADJUST_KEY = "skin-adjust";
const IMAGE_KEY = "skin-image";
const listeners = new Set<() => void>();

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let image = readString(IMAGE_KEY);
const adjusts = readJson<Record<string, Adjust>>(ADJUST_KEY, {});
let currentId = validId(readString(KEY));

function validId(id: string | null): string | null {
  if (id === CUSTOM_SKIN) return image ? id : null;
  return SKIN_PRESETS.some((p) => p.id === id) ? id : null;
}

export interface SkinView {
  /** 当前皮肤 id（null 是原来的外观） */
  id: string | null;
  preset: SkinPreset | null;
  /** 浅色下实际用的强调色 */
  accent: string;
  /** 强调色调过（预设皮肤可以恢复） */
  accentChanged: boolean;
  /** 遮罩浓度；实色皮肤是 null，不能调 */
  veil: number | null;
  /** 当前皮肤是不是背景图 */
  hasImage: boolean;
  /** 已上传的自定义背景图 */
  image: string | null;
}

function view(): SkinView {
  const preset = SKIN_PRESETS.find((p) => p.id === currentId) ?? null;
  const adj = (currentId && adjusts[currentId]) || {};
  const hasImage = currentId === CUSTOM_SKIN;
  const translucent = hasImage || !!preset?.colors;
  return {
    id: currentId,
    preset,
    accent: adj.accent ?? preset?.accent ?? "#2563eb",
    accentChanged: !!preset && adj.accent !== undefined,
    veil: translucent ? (adj.veil ?? defaultVeil(hasImage)) : null,
    hasImage,
    image,
  };
}

/** 预设皮肤的变量（预览卡片写在卡片上）：调过的强调色两种模式共用 */
export function skinVars(p: SkinPreset): Record<string, string> {
  const accent = adjusts[p.id]?.accent;
  const vars: Record<string, string> = { "--skin-accent": accent ?? p.accent, "--skin-accent-dark": accent ?? p.darkAccent };
  p.colors?.forEach((c, i) => (vars[`--skin-c${i + 1}`] = c));
  return vars;
}

const VARS = ["--skin-accent", "--skin-accent-dark", "--skin-c1", "--skin-c2", "--skin-c3", "--skin-veil", "--skin-image"];

/** 与 index.html 里的内联脚本一致 */
function apply() {
  const root = document.documentElement;
  for (const v of VARS) root.style.removeProperty(v);
  delete root.dataset.skin;
  delete root.dataset.skinBg;
  if (!currentId) return;
  const adj = adjusts[currentId] ?? {};
  root.dataset.skin = currentId;
  if (currentId === CUSTOM_SKIN) {
    const accent = adj.accent ?? "#2563eb";
    root.dataset.skinBg = "image";
    root.style.setProperty("--skin-accent", accent);
    root.style.setProperty("--skin-accent-dark", accent);
    root.style.setProperty("--skin-image", `url("${image}")`);
  } else {
    const preset = SKIN_PRESETS.find((p) => p.id === currentId)!;
    for (const [k, v] of Object.entries(skinVars(preset))) root.style.setProperty(k, v);
    if (preset.colors) root.dataset.skinBg = "glow";
  }
  if (adj.veil !== undefined) root.style.setProperty("--skin-veil", `${adj.veil}%`);
}

let snapshot = view();
apply();

function save() {
  try {
    if (currentId) localStorage.setItem(KEY, currentId);
    else localStorage.removeItem(KEY);
    localStorage.setItem(ADJUST_KEY, JSON.stringify(adjusts));
  } catch {
    // 存不了时只在本次打开期间生效
  }
  apply();
  snapshot = view();
  listeners.forEach((l) => l());
}

/** 换皮肤：预设的 id、CUSTOM_SKIN（要先有背景图），null 是原来的外观 */
export function setSkin(id: string | null) {
  currentId = validId(id);
  save();
}

/** 改当前皮肤的强调色或遮罩浓度；accent 传 null 恢复预设的强调色 */
export function updateSkin(patch: { accent?: string | null; veil?: number }) {
  if (!currentId) return;
  const adj = { ...adjusts[currentId] };
  if (patch.accent === null) delete adj.accent;
  else if (patch.accent !== undefined) adj.accent = patch.accent;
  if (patch.veil !== undefined) adj.veil = patch.veil;
  adjusts[currentId] = adj;
  save();
}

/** 换成自定义背景图（已压缩的 data URL），accent 是从图里取的强调色。图片太大存不进 localStorage 时抛错，皮肤不变 */
export function setSkinImage(dataUrl: string, accent: string) {
  try {
    localStorage.setItem(IMAGE_KEY, dataUrl);
  } catch {
    throw new Error("图片太大，浏览器存不下，请换一张小一点的图片");
  }
  image = dataUrl;
  adjusts[CUSTOM_SKIN] = { ...adjusts[CUSTOM_SKIN], accent };
  currentId = CUSTOM_SKIN;
  save();
}

/** 删掉自定义背景图；正在用它时回到原来的外观 */
export function removeSkinImage() {
  try {
    localStorage.removeItem(IMAGE_KEY);
  } catch {
    // 忽略
  }
  image = null;
  delete adjusts[CUSTOM_SKIN];
  if (currentId === CUSTOM_SKIN) currentId = null;
  save();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSkin(): SkinView {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** 读入图片：长边缩到 1920 像素以内、转成 JPEG，并取一个适合做强调色的颜色 */
export async function loadSkinImage(file: File): Promise<{ dataUrl: string; accent: string }> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      throw new Error("读不出这张图片，请换一张");
    });
    const scale = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);

    const small = document.createElement("canvas");
    small.width = small.height = 48;
    const sctx = small.getContext("2d", { willReadFrequently: true })!;
    sctx.drawImage(img, 0, 0, 48, 48);
    return { dataUrl, accent: accentOf(sctx.getImageData(0, 0, 48, 48).data) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 图里最鲜艳的一类颜色（按色相分桶、以饱和度加权），亮度压到能衬白字的范围；整张图都是灰的时用默认蓝 */
function accentOf(px: Uint8ClampedArray): string {
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0 }));
  for (let i = 0; i < px.length; i += 4) {
    const [h, s, l] = rgbToHsl(px[i]!, px[i + 1]!, px[i + 2]!);
    if (s < 0.25 || l < 0.15 || l > 0.9) continue;
    const b = buckets[Math.floor(h * 12) % 12]!;
    const w = s * s;
    b.w += w;
    b.h += h * w;
    b.s += s * w;
  }
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  if (best.w === 0) return "#2563eb";
  return hslToHex(best.h / best.w, Math.min(0.75, Math.max(0.45, best.s / best.w)), 0.48);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
