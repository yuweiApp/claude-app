import { useEffect, useState } from "react";
import { useIsDark } from "../theme";
import { ImageViewer } from "./ImageThumb";
import { CopyAction } from "./MessageActions";

type Mermaid = typeof import("mermaid").default;

/** mermaid 体积大，第一次遇到 mermaid 代码块时才加载 */
let loading: Promise<Mermaid> | null = null;
function loadMermaid() {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}


/** 图的配色：跟页面一样的暖灰（styles.css 的 --bg / --panel / --border / --text / --muted） */
const PALETTE = {
  light: { bg: "#fbfaf8", node: "#f1efea", border: "#dedad2", text: "#1f1e1c", line: "#9a968d", label: "#efece6" },
  dark: { bg: "#232220", node: "#2b2a27", border: "#4a4843", text: "#ecebe7", line: "#77736b", label: "#2c2b28" },
};

function config(dark: boolean) {
  const c = dark ? PALETTE.dark : PALETTE.light;
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    suppressErrorRendering: true,
    theme: "base" as const,
    darkMode: dark,
    // 和页面用同一种字体（导出图片时也写在 SVG 里）
    fontFamily: getComputedStyle(document.body).fontFamily,
    themeVariables: {
      background: c.bg,
      primaryColor: c.node,
      primaryTextColor: c.text,
      primaryBorderColor: c.border,
      secondaryColor: c.node,
      tertiaryColor: c.bg,
      lineColor: c.line,
      textColor: c.text,
      clusterBkg: c.bg,
      clusterBorder: c.border,
      edgeLabelBackground: c.label,
      titleColor: c.text,
      fontSize: "14px",
    },
    // 圆角节点、胶囊形连线标签；写在 SVG 自带的样式里，展开和下载的图片也是这样
    themeCSS: `
      .node rect { rx: 8px; ry: 8px; }
      .edgeLabel, .edgeLabel p, .edgeLabel rect { background-color: ${c.label}; fill: ${c.label}; }
      .edgeLabel .label { padding: 1px 8px; border-radius: 999px; font-size: 12px; }
      .cluster rect { rx: 6px; ry: 6px; }
    `,
  };
}

/** mermaid.render 共用全局配置（主题），一次只渲染一张，排队进行 */
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

/** 渲染结果按（深浅色、源码）缓存：代码块重新挂上（消息重新渲染）时不用再渲染、不闪 */
const rendered = new Map<string, Promise<string>>();
const cacheKey = (code: string, dark: boolean) => `${dark ? "d" : "l"}\n${code}`;

/** 已经渲染好的图：代码块重新挂上时第一帧就显示图，不先显示源码（高度一变，滚动位置会跳） */
const done = new Map<string, string>();

function renderSvg(code: string, dark: boolean): Promise<string> {
  const key = cacheKey(code, dark);
  let p = rendered.get(key);
  if (!p) {
    p = queue.then(async () => {
      const mermaid = await loadMermaid();
      mermaid.initialize(config(dark));
      const { svg } = await mermaid.render(`mermaid-${++seq}`, code);
      done.set(key, svg);
      return svg;
    });
    queue = p.catch(() => {});
    // 语法错误（多半是流式输出还没写完）不缓存，免得 Map 里堆满半截的源码
    p.catch(() => rendered.delete(key));
    rendered.set(key, p);
  }
  return p;
}

/**
 * 单独成图的 SVG（展开、下载用）：页面里的 SVG 宽度是 100%、靠 max-width 限宽，单独打开时尺寸不定，
 * 改成 viewBox 的实际大小；底色透明，加上背景色，周围留白。单独打开的 SVG 按 XML 解析
 */
function standaloneSvg(svg: string, dark: boolean): { text: string; width: number; height: number } {
  // 节点文字里的换行是 <br>，不是合法的 XML：用 HTML 解析器读，再序列化成 XML
  const root = new DOMParser().parseFromString(svg, "text/html").body.firstElementChild!;
  const [x = 0, y = 0, w = 300, h = 150] = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const pad = 16;
  const width = Math.ceil(w + pad * 2);
  const height = Math.ceil(h + pad * 2);
  root.setAttribute("viewBox", `${x - pad} ${y - pad} ${width} ${height}`);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.setAttribute("style", `background-color: ${dark ? PALETTE.dark.bg : PALETTE.light.bg}`);
  return { text: new XMLSerializer().serializeToString(root), width, height };
}

/** 下载成 PNG（2 倍大小，放大看也清楚） */
async function downloadPng(svg: string, dark: boolean) {
  const { text, width, height } = standaloneSvg(svg, dark);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  await img.decode();
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片生成失败"))), "image/png"));
  const url = URL.createObjectURL(png);
  const a = document.createElement("a");
  a.href = url;
  a.download = "diagram.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 流式输出时源码一直在变，停一会儿再渲染 */
const RENDER_DELAY_MS = 300;

/**
 * ```mermaid 代码块：渲染成图（同 codex-app-server 的 MermaidBlock）。鼠标移上去右上角出现复制源码、下载图片、
 * 展开；点图也能展开看大图。源码有错（包括流式输出还没写完）时显示源码和错误原因
 */
export function MermaidBlock({ code }: { code: string }) {
  const dark = useIsDark();
  const [result, setResult] = useState<{ code: string; dark: boolean; svg?: string; error?: string } | null>(() => {
    const svg = done.get(cacheKey(code, dark));
    return svg ? { code, dark, svg } : null;
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const run = () =>
      renderSvg(code, dark).then(
        (svg) => live && setResult({ code, dark, svg }),
        // 解析错误后面几行是源码片段和插入符，只留第一行（Parse error on line 4:）
        (err: unknown) => live && setResult({ code, dark, error: (err instanceof Error ? err.message : String(err)).split("\n")[0] }),
      );
    const svg = done.get(cacheKey(code, dark));
    if (svg) {
      setResult((r) => (r?.svg === svg && r.dark === dark && r.code === code ? r : { code, dark, svg }));
      return;
    }
    // 正在渲染的接着等，新的源码等一会儿
    if (rendered.has(cacheKey(code, dark))) {
      void run();
      return () => {
        live = false;
      };
    }
    const timer = setTimeout(run, RENDER_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, dark]);

  useEffect(() => () => {
    if (expanded) URL.revokeObjectURL(expanded);
  }, [expanded]);

  const source = code.replace(/\n$/, "");
  // 源码变了但新图还没出来时，先留着上一张图（流式输出时不来回闪）；第一次渲染前显示源码
  const svg = result?.svg;
  const error = result && result.code === code && result.dark === dark ? result.error : undefined;
  if (!svg || error) {
    return (
      <div className="md-code md-mermaid">
        <pre>
          <code className="language-mermaid">{code}</code>
        </pre>
        <CopyAction className="md-code-copy" title="复制代码" text={source} />
        {error && <div className="md-mermaid-error">图表无法显示：{error}</div>}
      </div>
    );
  }

  const shownDark = result!.dark;
  const expand = () => setExpanded(URL.createObjectURL(new Blob([standaloneSvg(svg, shownDark).text], { type: "image/svg+xml" })));
  return (
    <div className="md-mermaid">
      <div
        className="md-mermaid-svg"
        role="button"
        tabIndex={0}
        aria-label="展开图表"
        title="点击展开图表"
        onClick={expand}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            expand();
          }
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="md-mermaid-tools">
        <CopyAction title="复制源码" text={source} />
        <button className="msg-action" title="下载图片" aria-label="下载图片" onClick={() => void downloadPng(svg, shownDark).catch(() => {})}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
          </svg>
        </button>
        <button className="msg-action" title="展开图表" aria-label="展开图表" onClick={expand}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
          </svg>
        </button>
      </div>
      {expanded && <ImageViewer src={expanded} alt="图表" onClose={() => setExpanded(null)} />}
    </div>
  );
}
