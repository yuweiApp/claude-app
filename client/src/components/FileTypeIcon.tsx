import type { ReactNode } from "react";

/** 文件类型图标（@ 引用文件的候选列表用）：按文件名、扩展名挑，认不出的是普通文件 */

type Icon =
  /** 带字的色块，编程语言用 */
  | { type: "badge"; text: string; bg: string; fg?: string }
  /** 有颜色的文件，文档类 */
  | { type: "doc"; color: string }
  | { type: "git" | "claude" | "image" | "json" | "code" | "markup" | "style" | "terminal" | "archive" | "plain" };

const BADGES: Record<string, [text: string, bg: string, fg?: string]> = {
  ts: ["TS", "#3178c6"],
  tsx: ["TS", "#3178c6"],
  mts: ["TS", "#3178c6"],
  cts: ["TS", "#3178c6"],
  js: ["JS", "#f0db4f", "#323330"],
  jsx: ["JS", "#f0db4f", "#323330"],
  mjs: ["JS", "#f0db4f", "#323330"],
  cjs: ["JS", "#f0db4f", "#323330"],
  py: ["PY", "#3776ab", "#ffd43b"],
  pyi: ["PY", "#3776ab", "#ffd43b"],
  ipynb: ["PY", "#f37626"],
  go: ["GO", "#00add8"],
  rs: ["RS", "#ce422b"],
  java: ["J", "#e76f00"],
  kt: ["K", "#7f52ff"],
  swift: ["S", "#f05138"],
  c: ["C", "#5c6bc0"],
  h: ["H", "#5c6bc0"],
  cpp: ["C+", "#00599c"],
  cc: ["C+", "#00599c"],
  hpp: ["H+", "#00599c"],
  cs: ["C#", "#68217a"],
  rb: ["RB", "#cc342d"],
  php: ["P", "#777bb4"],
  lua: ["L", "#000080"],
  dart: ["D", "#0175c2"],
  vue: ["V", "#41b883"],
  svelte: ["S", "#ff3e00"],
  sql: ["SQ", "#e38c00"],
  yml: ["Y", "#cb171e"],
  yaml: ["Y", "#cb171e"],
};

const DOCS: Record<string, string> = {
  md: "#3fb950",
  mdx: "#3fb950",
  txt: "#8b949e",
  log: "#8b949e",
  pdf: "#e5534b",
  doc: "#2b579a",
  docx: "#2b579a",
  xls: "#217346",
  xlsx: "#217346",
  csv: "#217346",
  ppt: "#d24726",
  pptx: "#d24726",
};

const OTHERS: Record<string, Exclude<Icon["type"], "badge" | "doc">> = {
  json: "json",
  jsonc: "json",
  json5: "json",
  toml: "code",
  ini: "code",
  cfg: "code",
  conf: "code",
  env: "code",
  xml: "markup",
  html: "markup",
  htm: "markup",
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  sh: "terminal",
  bash: "terminal",
  zsh: "terminal",
  fish: "terminal",
  ps1: "terminal",
  bat: "terminal",
  cmd: "terminal",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  ico: "image",
  bmp: "image",
  zip: "archive",
  gz: "archive",
  tgz: "archive",
  tar: "archive",
  "7z": "archive",
  rar: "archive",
};

function pick(name: string): Icon {
  const lower = name.toLowerCase();
  if (lower === "claude.md" || lower === "claude.local.md") return { type: "claude" };
  if (lower.startsWith(".git") || lower === ".mailmap") return { type: "git" };
  if (lower === "dockerfile" || lower.startsWith("dockerfile.") || lower === ".dockerignore") return { type: "badge", text: "D", bg: "#1d63ed" };
  if (lower === "makefile") return { type: "terminal" };
  if (lower.startsWith(".env") || lower === ".editorconfig" || lower === ".npmrc" || lower === ".python-version" || lower === ".nvmrc") {
    return { type: "code" };
  }
  if (lower === "license" || lower.startsWith("license.")) return { type: "doc", color: "#d4a72c" };
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  const badge = BADGES[ext];
  if (badge) return { type: "badge", text: badge[0], bg: badge[1], fg: badge[2] };
  const doc = DOCS[ext];
  if (doc) return { type: "doc", color: doc };
  return { type: OTHERS[ext] ?? "plain" };
}

const OUTLINE = "M4 1.5h5l3.5 3.5v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z";

/** 16×16 的文件图标，name 是文件名（不含路径） */
export function FileTypeIcon({ name }: { name: string }) {
  const icon = pick(name);
  const svg = (children: ReactNode) => (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {children}
    </svg>
  );
  switch (icon.type) {
    case "badge":
      return svg(
        <>
          <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill={icon.bg} />
          <text
            x="8"
            y="11"
            textAnchor="middle"
            fontSize={icon.text.length > 1 ? 6.5 : 8}
            fontWeight="700"
            fontFamily="system-ui, sans-serif"
            fill={icon.fg ?? "#fff"}
          >
            {icon.text}
          </text>
        </>,
      );
    case "doc":
      return svg(
        <>
          <path d={OUTLINE} fill={icon.color} />
          <path d="M9 1.5V5h3.5" fill="none" stroke="#fff" strokeOpacity="0.6" strokeWidth="1" strokeLinejoin="round" />
          <path d="M5.5 8.5h5M5.5 11h5" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
        </>,
      );
    case "claude":
      // 橙色放射星（CLAUDE.md）
      return svg(
        <g stroke="#d97757" strokeWidth="1.7" strokeLinecap="round">
          {[0, 30, 60, 90, 120, 150].map((deg) => (
            <line key={deg} x1="8" y1="2" x2="8" y2="14" transform={`rotate(${deg} 8 8)`} />
          ))}
        </g>,
      );
    case "git":
      return svg(
        <>
          <rect x="3" y="3" width="10" height="10" rx="2" transform="rotate(45 8 8)" fill="#f05032" />
          <g stroke="#fff" strokeWidth="1.1" strokeLinecap="round" fill="#fff">
            <path d="M6.2 5.6v4.8M6.2 7.4l3.4 1.4" />
            <circle cx="6.2" cy="10.6" r="0.9" stroke="none" />
            <circle cx="9.8" cy="8.9" r="0.9" stroke="none" />
          </g>
        </>,
      );
    case "image":
      return svg(
        <>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="#a371f7" strokeWidth="1.3" />
          <circle cx="5.5" cy="6" r="1.3" fill="#a371f7" />
          <path d="M2.5 12.5 6.5 8.5l2.5 2.5 2-2 3 3" fill="none" stroke="#a371f7" strokeWidth="1.3" strokeLinejoin="round" />
        </>,
      );
    case "json":
      return svg(
        <text x="8" y="11.5" textAnchor="middle" fontSize="10" fontWeight="700" fontFamily="ui-monospace, monospace" fill="#cb9a1b">
          {"{}"}
        </text>,
      );
    case "code":
      return svg(
        <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
      );
    case "markup":
      return svg(
        <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3.5l-2 9" fill="none" stroke="#e34c26" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
      );
    case "style":
      return svg(
        <path d="M6.5 2.5 5 13.5M11 2.5 9.5 13.5M3 6h10.5M2.5 10h10.5" fill="none" stroke="#663399" strokeWidth="1.3" strokeLinecap="round" />,
      );
    case "terminal":
      return svg(
        <>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#3a3f47" />
          <path d="M4.5 6 6.5 8l-2 2M8 10.5h3.5" fill="none" stroke="#7ee787" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </>,
      );
    case "archive":
      return svg(
        <>
          <path d={OUTLINE} fill="none" stroke="#b08800" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M7 3v1.5M8 4.5V6M7 6v1.5M8 7.5V9" stroke="#b08800" strokeWidth="1.2" />
          <rect x="6.5" y="9.5" width="2" height="2.2" rx="0.5" fill="#b08800" />
        </>,
      );
    case "plain":
      return svg(<path d={OUTLINE} fill="currentColor" fillOpacity="0.35" />);
  }
}
