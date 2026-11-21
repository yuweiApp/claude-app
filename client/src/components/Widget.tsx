import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/** 部件里 sendPrompt(text) 发消息：Chat 提供（以用户的身份发一条消息），没提供时（不在会话里）忽略 */
export const WidgetPromptContext = createContext<((text: string) => void) | null>(null);

/** 部件能连的外部地址，和网关说明里列的一致（gateway/src/visualize/tool.ts 的 ORIGINS） */
const WIDGET_ORIGINS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "esm.sh", "fonts.googleapis.com", "fonts.gstatic.com"].map((h) => `https://${h}`).join(" ");

const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${WIDGET_ORIGINS}`,
  `style-src 'unsafe-inline' ${WIDGET_ORIGINS}`,
  `font-src data: ${WIDGET_ORIGINS}`,
  `img-src data: blob: ${WIDGET_ORIGINS}`,
  `media-src data: blob:`,
  `connect-src ${WIDGET_ORIGINS}`,
  "worker-src blob:",
].join("; ");

/** 传给部件的主题变量（说明里列的那些），切换主题、皮肤时重新取值发过去 */
const THEME_VARS = ["--bg", "--panel", "--text", "--muted", "--border", "--accent", "--accent-text", "--ok", "--warn", "--err", "--code-bg", "--font-ui", "--font-mono"];

interface Theme {
  theme: "light" | "dark";
  vars: Record<string, string>;
}

/** 按 iframe 所在位置取变量的值（皮肤、外观设置覆盖过的也算上） */
function readTheme(el: Element): Theme {
  const style = getComputedStyle(el);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARS) vars[name] = style.getPropertyValue(name).trim();
  return { theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", vars };
}

/** 部件页面里的桥：高度、sendPrompt、链接经 postMessage 交给外面；外面发来主题时更新变量 */
const BRIDGE = `(function () {
  var post = function (m) { m.__widget = 1; parent.postMessage(m, "*"); };
  window.sendPrompt = function (text) { post({ type: "prompt", text: String(text) }); };
  window.openLink = function (url) { post({ type: "link", url: String(url) }); };
  var root = document.documentElement;
  var apply = function (t) {
    for (var k in t.vars) root.style.setProperty(k, t.vars[k]);
    root.setAttribute("data-theme", t.theme);
    root.style.colorScheme = t.theme;
  };
  addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || e.data.__widget !== 1) return;
    if (e.data.type === "theme") apply(e.data);
    if (e.data.type === "measure") measure();
  });
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var url = a.href;
    if (/^https?:/i.test(url)) { e.preventDefault(); post({ type: "link", url: url }); }
    else if (a.getAttribute("href").charAt(0) !== "#") e.preventDefault();
  }, true);
  var last = -1;
  // 还没拿到宽度（iframe 刚插进页面、尺寸还没传过来）时量出来是 0，不报：报了 iframe 变成 0 高，就一直拿不到尺寸了
  var measure = function () {
    if (!document.body || !innerWidth) return;
    var h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h !== last) { last = h; post({ type: "height", height: h }); }
  };
  document.addEventListener("DOMContentLoaded", function () {
    measure();
    if (window.ResizeObserver) new ResizeObserver(measure).observe(document.body);
  });
  addEventListener("load", measure);
  addEventListener("resize", measure);
})();`;

/**
 * 和 Claude 桌面版部件同名的变量（--surface-1、--text-primary……），值取自上面那组，跟着主题变；
 * 照桌面版习惯写的部件也能显示正常。说明里列的对应关系和这里一致（gateway/src/visualize/tool.ts）
 */
const ALIASES = `:root {
  --surface-0: var(--bg); --surface-1: var(--panel); --surface-2: var(--bg); --surface-3: var(--bg);
  --text-primary: var(--text); --text-secondary: var(--muted); --text-muted: var(--muted);
  --border-strong: color-mix(in srgb, var(--text) 22%, transparent); --border-stronger: color-mix(in srgb, var(--text) 40%, transparent);
  --text-accent: var(--accent); --bg-accent: color-mix(in srgb, var(--accent) 14%, transparent); --border-accent: color-mix(in srgb, var(--accent) 50%, transparent);
  --text-success: var(--ok); --bg-success: color-mix(in srgb, var(--ok) 14%, transparent); --border-success: color-mix(in srgb, var(--ok) 50%, transparent);
  --text-warning: var(--warn); --bg-warning: color-mix(in srgb, var(--warn) 14%, transparent); --border-warning: color-mix(in srgb, var(--warn) 50%, transparent);
  --text-danger: var(--err); --bg-danger: color-mix(in srgb, var(--err) 14%, transparent); --border-danger: color-mix(in srgb, var(--err) 50%, transparent);
  --font-sans: var(--font-ui); --radius: 8px;
}`;

function srcDoc(code: string, theme: Theme): string {
  const vars = Object.entries(theme.vars)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  // body 是 flow-root：子元素的外边距算在 body 的高度里，量出来的高度不会少
  return `<!DOCTYPE html><html data-theme="${theme.theme}" style="color-scheme: ${theme.theme}; ${vars.replace(/"/g, "&quot;")}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${ALIASES}
html { background: transparent; overflow: hidden; } body { display: flow-root; margin: 0; font-family: var(--font-ui); color: var(--text); font-size: 15px; line-height: 1.6; } svg { max-width: 100%; }</style>
<script>${BRIDGE}</script>
</head><body>${code}</body></html>`;
}

/** 对话里的一个部件：沙箱 iframe（不给 allow-same-origin，碰不到网关的令牌和页面），高度跟着内容变 */
export function Widget({ code, title, loadingMessages }: { code: string; title?: string; loadingMessages?: string[] }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const onPrompt = useContext(WidgetPromptContext);
  const promptRef = useRef(onPrompt);
  promptRef.current = onPrompt;
  // 主题只在第一次渲染时写进页面；之后切换主题经 postMessage 更新变量，部件不重新加载（重新加载会丢掉用户在部件里的操作）
  const initialTheme = useRef<Theme | null>(null);
  if (!initialTheme.current) initialTheme.current = readTheme(document.documentElement);
  const doc = useMemo(() => srcDoc(code, initialTheme.current!), [code]);

  // 用 layout effect：在 iframe 开始加载前挂好监听，第一次报的高度不会漏掉
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const postTheme = () => frame.contentWindow?.postMessage({ __widget: 1, type: "theme", ...readTheme(frame) }, "*");
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || !e.data || e.data.__widget !== 1) return;
      const data = e.data as { type: string; height?: number; text?: string; url?: string };
      if (data.type === "height" && typeof data.height === "number") setHeight(Math.max(0, data.height));
      else if (data.type === "prompt" && typeof data.text === "string" && data.text.trim()) promptRef.current?.(data.text);
      else if (data.type === "link" && typeof data.url === "string" && /^https?:/i.test(data.url)) window.open(data.url, "_blank", "noopener,noreferrer");
    };
    window.addEventListener("message", onMessage);
    // 加载完先按 iframe 所在位置的变量同步一次（皮肤可能覆盖了根上的值），之后主题、皮肤、外观设置变了再发
    frame.addEventListener("load", postTheme);
    const observer = new MutationObserver(postTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin", "style", "class"] });
    // iframe 的尺寸变了（窗口变宽变窄）就让部件重新量一次：不在屏幕上的跨源 iframe 不跑渲染，它自己的 ResizeObserver 不一定报
    const sized = new ResizeObserver(() => frame.contentWindow?.postMessage({ __widget: 1, type: "measure" }, "*"));
    sized.observe(frame);
    return () => {
      window.removeEventListener("message", onMessage);
      frame.removeEventListener("load", postTheme);
      observer.disconnect();
      sized.disconnect();
    };
  }, [doc]);

  // 部件报上第一次高度之前：iframe 先透明（不隐藏，隐藏的跨源 iframe 不跑渲染、量不出高度），上面轮流显示 loading_messages
  const loading = height === null;
  return (
    <div className={`widget${loading ? " loading" : ""}`}>
      {loading && <LoadingLine messages={loadingMessages} />}
      <iframe
        ref={frameRef}
        className="widget-frame"
        title={title || "部件"}
        sandbox="allow-scripts"
        srcDoc={doc}
        style={{ height: height ?? LOADING_HEIGHT }}
      />
    </div>
  );
}

/** 部件报上高度之前 iframe 的高度，和生成中的占位一样高（只有一行提示），换过去时不跳 */
const LOADING_HEIGHT = 28;

/** 部件调用的参数还在生成：在部件的位置轮流显示 loading_messages（已经完整收到的那几句），还没有时显示「正在生成部件…」 */
export function WidgetPending({ json }: { json: string }) {
  const messages = partialLoadingMessages(json);
  return (
    <div className="widget loading widget-pending">
      <LoadingLine messages={messages.length ? messages : ["正在生成部件…"]} />
    </div>
  );
}

/**
 * 从还没生成完的参数（不完整的 JSON）里取 loading_messages：只取已经完整的字符串，半截的不显示。
 * 参数按工具定义的顺序生成，loading_messages 在 widget_code 前面；只在 "widget_code" 之前找，免得找到部件代码里的同名文字
 */
export function partialLoadingMessages(json: string): string[] {
  const code = json.indexOf('"widget_code"');
  const head = code < 0 ? json : json.slice(0, code);
  const key = head.indexOf('"loading_messages"');
  if (key < 0) return [];
  let i = head.indexOf("[", key);
  if (i < 0) return [];
  const out: string[] = [];
  for (i++; i < head.length && head[i] !== "]"; i++) {
    if (head[i] !== '"') continue;
    let j = i + 1;
    while (j < head.length && head[j] !== '"') j += head[j] === "\\" ? 2 : 1;
    if (j >= head.length) break;
    try {
      out.push(JSON.parse(head.slice(i, j + 1)) as string);
    } catch {
      break;
    }
    i = j;
  }
  return out.filter((m) => m.trim());
}

/** 部件显示出来之前的提示：模型给的 loading_messages 每 2.5 秒换一句，没给时不显示 */
function LoadingLine({ messages }: { messages?: string[] }) {
  const list = (messages ?? []).filter((m) => m.trim());
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (list.length < 2) return;
    const timer = window.setInterval(() => setIndex((i) => i + 1), 2500);
    return () => window.clearInterval(timer);
  }, [list.length]);
  if (!list.length) return null;
  return (
    <div className="widget-loading" role="status">
      <span className="widget-loading-dot" />
      {list[index % list.length]}
    </div>
  );
}
