import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WidgetReport, WidgetReportError } from "@gateway/shared/types";

/**
 * 部件和会话之间的事，Chat 提供，不在会话里时没有：
 * - prompt：部件里 sendPrompt(text)，以用户的身份发一条消息
 * - report：部件显示后把结果（大小、加载期间的错误）报给网关，交给正在等它的 show_widget 调用
 */
export const WidgetHostContext = createContext<{ prompt: (text: string) => void; report: (toolUseId: string, report: WidgetReport) => void } | null>(null);

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
  // 加载期间的问题，报告时一起交出去：脚本错误（srcdoc 里的带行号，外面换算成 widget_code 的行号）、Promise 拒绝、资源加载失败、CSP 拦截、console.error
  var errors = [];
  var push = function (kind, message, lineno, file) {
    if (errors.length >= 20) return;
    var e = { kind: kind, message: String(message).slice(0, 500) };
    if (lineno && file === "about:srcdoc") e.lineno = lineno;
    errors.push(e);
  };
  var text = function (a) {
    if (a && a.message) return a.message;
    if (typeof a === "object") { try { return JSON.stringify(a); } catch (x) { return String(a); } }
    return String(a);
  };
  addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) { push("resource", t.tagName.toLowerCase() + " " + (t.src || t.href || "")); return; }
    push("error", e.message || "未知错误", e.lineno, e.filename);
  }, true);
  addEventListener("unhandledrejection", function (e) { push("rejection", text(e.reason)); });
  document.addEventListener("securitypolicyviolation", function (e) { push("csp", e.blockedURI + "（" + e.effectiveDirective + "）"); });
  var consoleError = console.error;
  console.error = function () {
    try { push("console", Array.prototype.map.call(arguments, text).join(" ")); } catch (x) {}
    return consoleError.apply(console, arguments);
  };
  // 报告一次：load 后约 1 秒，load 一直没触发时开始加载后约 6 秒；还没拿到宽度时等拿到再报。被 CSP 拦下的地址不再另算一次加载失败
  var loaded = false, reported = false, due = false;
  var report = function () {
    if (reported) return;
    if (!innerWidth || !document.body) { due = true; return; }
    reported = true;
    var blocked = errors.filter(function (e) { return e.kind === "csp"; }).map(function (e) { return e.message; }).join(" ");
    post({
      type: "report",
      width: innerWidth,
      height: last >= 0 ? last : contentHeight(),
      loaded: loaded,
      errors: errors.filter(function (e) { return e.kind !== "resource" || blocked.indexOf(e.message.slice(e.message.indexOf(" ") + 1)) < 0; }),
    });
  };
  setTimeout(report, 6000);
  addEventListener("load", function () { loaded = true; setTimeout(report, 1000); });
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
  // 内容高：body 的高度，加上超出 body 的部分（height: 100vh 的容器里内容更高时）；position: fixed 的不算
  var contentHeight = function () {
    var b = document.body;
    return Math.ceil(Math.max(b.getBoundingClientRect().height, b.scrollHeight));
  };
  // last：上次报的内容高；lastVh：那之后内容没变时页面的高（innerHeight），iframe 按报的高度变高后、内容没跟着变，就记下新的页面高。
  // 内容高跟着页面高走（min-height: 100vh 再加内边距之类）时，报了 iframe 就变高、内容又变高，会一直长下去：
  // 页面比 lastVh 高了多少、内容就跟着变高多少（差 1 像素以内），或者 3 秒内连着 8 次都是页面变高后内容也变高，就不再报更高的
  var last = -1, lastVh = 0, chain = 0, chainStart = 0;
  // 还没拿到宽度（iframe 刚插进页面、尺寸还没传过来）时量出来是 0，不报：报了 iframe 变成 0 高，就一直拿不到尺寸了
  var measure = function () {
    if (!document.body || !innerWidth) return;
    var h = contentHeight(), vh = innerHeight;
    if (h === last) lastVh = vh;
    else {
      var dv = vh - lastVh, db = h - last;
      var follows = last >= 0 && dv > 0 && db > 0;
      if (follows) {
        var now = Date.now();
        if (!chain || now - chainStart > 3000) { chain = 0; chainStart = now; }
        chain++;
      } else chain = 0;
      if (!(follows && (Math.abs(db - dv) <= 1 || chain > 8))) { last = h; lastVh = vh; post({ type: "height", height: h }); }
    }
    if (due) report();
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

/** srcdoc 里 <body> 所在的行（从 1 开始）：部件代码从这一行开始，脚本错误的行号减掉它就是 widget_code 里的行号 */
function bodyLine(doc: string): number {
  return doc.slice(0, doc.indexOf("<body>")).split("\n").length;
}

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
export function Widget({ code, title, loadingMessages, reportId }: { code: string; title?: string; loadingMessages?: string[]; reportId?: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const host = useContext(WidgetHostContext);
  const hostRef = useRef(host);
  hostRef.current = host;
  // 要报告的 tool_use id 按第一次渲染时的为准：报告前工具结果可能已经到了（超时），之后不再报
  const [toReport] = useState(reportId);
  const reportedRef = useRef(false);
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
      const data = e.data as { type: string; height?: number; text?: string; url?: string; width?: number; loaded?: boolean; errors?: unknown };
      if (data.type === "height" && typeof data.height === "number") setHeight(Math.max(0, data.height));
      else if (data.type === "prompt" && typeof data.text === "string" && data.text.trim()) hostRef.current?.prompt(data.text);
      else if (data.type === "report" && toReport && !reportedRef.current && hostRef.current) {
        reportedRef.current = true;
        const offset = bodyLine(doc);
        const errors: WidgetReportError[] = (Array.isArray(data.errors) ? data.errors : []).map((raw: { kind: WidgetReportError["kind"]; message: string; lineno?: number }) => {
          const line = typeof raw.lineno === "number" ? raw.lineno - offset + 1 : 0;
          return { kind: raw.kind, message: String(raw.message), ...(line > 0 ? { line } : {}) };
        });
        hostRef.current.report(toReport, { width: data.width ?? 0, height: data.height ?? 0, loaded: data.loaded === true, errors });
      }
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
