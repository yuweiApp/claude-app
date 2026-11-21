import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ALWAYS_LOAD_META, isAlwaysLoad } from "../config-file.js";
import type { WidgetReport, WidgetReportError } from "../shared/types.js";

/** MCP 服务器名：工具全名是 mcp__visualize__show_widget */
export const VISUALIZE_SERVER = "visualize";
export const SHOW_WIDGET_TOOL = `mcp__${VISUALIZE_SERVER}__show_widget`;
/** 只是在对话里显示，没有副作用，不弹权限卡片（options.allowedTools） */
export const VISUALIZE_TOOLS = [SHOW_WIDGET_TOOL];

/**
 * 部件里能连的外部地址：网页的 Widget 组件按这个写内容安全策略（CSP），说明里也照这个列。
 * 和 client/src/components/Widget.tsx 的 WIDGET_ORIGINS 保持一致
 */
const ORIGINS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "esm.sh", "fonts.googleapis.com", "fonts.gstatic.com"];

/**
 * 等网页报告显示结果的时间：要比 MCP 调用自动转后台的时间（config.ts 的 MCP_AUTO_BACKGROUND_MS，20 秒）短，
 * 不然调用会被转到后台、这一轮先接着走
 */
const REPORT_TIMEOUT_MS = 10_000;

const DESCRIPTION = [
  "在对话里显示一段 HTML 或 SVG（部件），位置就是这次调用在对话里的位置，用户直接看到、可以操作。",
  "widget_code：HTML 片段（不含 <!DOCTYPE>、<html>、<head>、<body>），或以 <svg 开头的 SVG。部件在这次调用的参数完整生成后才显示。",
  "运行环境：",
  "- 沙箱 iframe，源是不透明的（opaque origin）：脚本可以执行；访问不到用户界面的页面；localStorage、sessionStorage、cookie 不可用（访问会抛错）；表单提交、alert/confirm/prompt、window.open 不可用。",
  `- 外部的脚本、样式、字体、图片和 fetch 只能连 ${ORIGINS.join("、")}（https），其余地址被内容安全策略拦截；图片还可以是 data:、blob:。`,
  "- 宽度等于对话区的宽度（最宽约 880 像素，随窗口变窄）；高度随内容自动变化，position: fixed 的元素不算在内容高度里。" +
    "vh 等视口单位按部件当前的高度算；内容高度随部件高度一起增加时（比如 min-height: 100vh 再加内边距），部件不再跟着变高，超出的部分被裁掉。",
  "- 部件背景透明，底下是对话区的底色。用户界面有浅色、深色两种主题，还可以开背景皮肤；切换时下面这些 CSS 变量的值跟着变，部件不重新加载：",
  "  --bg 对话区底色，--panel 面板、卡片底色，--text 正文，--muted 次要文字，--border 边框，--accent 强调色，--accent-text 强调色底上的文字，--ok 成功，--warn 警告，--err 错误，--code-bg 代码块底色，--font-ui 界面字体，--font-mono 等宽字体。",
  "  另有一组同义变量，值取自上面那些，同样跟着主题变：--surface-0、--surface-2、--surface-3 = --bg，--surface-1 = --panel；--text-primary = --text，--text-secondary、--text-muted = --muted；" +
    "--border-strong、--border-stronger 是比 --border 深的两级边框；--text-accent / --bg-accent / --border-accent 是强调色的文字 / 淡底 / 边框，" +
    "--text-success / --bg-success、--text-warning / --bg-warning、--text-danger / --bg-danger 同理（取自 --ok、--warn、--err）；--font-sans = --font-ui；--radius 是 8px。",
  "  <html> 的 data-theme 属性是 light 或 dark。body 默认：外边距 0，字体 var(--font-ui)，颜色 var(--text)，字号 15px。",
  "- 全局函数 sendPrompt(text)：以用户的身份把 text 作为一条新消息发出（一轮进行中时排队）。除此之外，用户在部件里的操作不会传给你。",
  "- 全局函数 openLink(url)：打开 http(s) 地址，点击 http(s) 链接也一样：用户在桌面版或分享页里时，在用户界面右侧面板的内置浏览器里开一个新标签页（同回复里的链接），否则在浏览器的新窗口打开。",
  "loading_messages：生成这次调用的参数期间，部件的位置上轮流显示这几句（每句约 2.5 秒），部件显示出来后消失；" +
    "参数是按顺序生成的，loading_messages 写在 widget_code 前面时，生成 widget_code 期间就能显示，写在后面时那时还没有；没有可显示的句子时显示「正在生成部件…」。",
  `工具结果在网页显示出部件之后返回：部件页面的 load 事件触发后约 1 秒（load 一直没触发时是开始加载后约 6 秒），网页报告部件的宽和内容高（像素）、load 触发了没有，` +
    "以及到那时为止的脚本错误、未处理的 Promise 拒绝、资源加载失败、被内容安全策略拦下的地址和 console.error（脚本错误带 widget_code 里的行号）；之后发生的不报告。" +
    `${REPORT_TIMEOUT_MS / 1000} 秒内没有网页报告时（没有打开这个会话的网页，或网页没在渲染），结果里只说已交给界面、没有收到显示结果。同一个会话开着几个网页时用最先报告的那个。`,
  "部件的代码留在会话记录里：重新打开会话时部件重新显示，脚本重新执行，之前在部件里的操作状态不保留。",
].join("\n");

/** 正在等网页报告的调用（按 tool_use id），和比调用先到的报告（网页渲染得快、工具还没开始等），先到的留一会儿 */
const waiting = new Map<string, { sessionId: string; resolve: (report: WidgetReport) => void }>();
const early = new Map<string, { sessionId: string; report: WidgetReport; at: number }>();
const EARLY_TTL_MS = 60_000;

/** 网页报告一个部件的显示结果：有调用在等就交给它，没有就先留着；同一次调用只收第一份。返回收下了没有 */
export function reportWidget(sessionId: string, toolUseId: string, report: WidgetReport): boolean {
  const wait = waiting.get(toolUseId);
  if (wait) {
    if (wait.sessionId !== sessionId) return false;
    waiting.delete(toolUseId);
    wait.resolve(report);
    return true;
  }
  const now = Date.now();
  for (const [id, e] of early) if (now - e.at > EARLY_TTL_MS) early.delete(id);
  if (early.has(toolUseId)) return false;
  early.set(toolUseId, { sessionId, report, at: now });
  return true;
}

/** 等这次调用的显示结果：先看有没有先到的，没有就等，超时或调用被中止时是 null */
function waitReport(sessionId: string, toolUseId: string, signal?: AbortSignal): Promise<WidgetReport | null> {
  const got = early.get(toolUseId);
  if (got && got.sessionId === sessionId) {
    early.delete(toolUseId);
    return Promise.resolve(got.report);
  }
  return new Promise((resolve) => {
    const done = (report: WidgetReport | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (waiting.get(toolUseId)?.resolve === finish) waiting.delete(toolUseId);
      resolve(report);
    };
    const finish = (report: WidgetReport) => done(report);
    const aborted = () => done(null);
    const timer = setTimeout(() => done(null), REPORT_TIMEOUT_MS);
    signal?.addEventListener("abort", aborted, { once: true });
    waiting.set(toolUseId, { sessionId, resolve: finish });
  });
}

const KIND_LABEL: Record<WidgetReportError["kind"], string> = {
  error: "脚本错误",
  rejection: "未处理的 Promise 拒绝",
  resource: "资源加载失败",
  csp: "被内容安全策略拦下",
  console: "console.error",
};

/** 网页的报告写成给模型看的文字：只说实际发生了什么 */
function describeReport(report: WidgetReport): string {
  const lines = [`已显示在对话里。网页报告：宽 ${report.width} 像素，内容高 ${report.height} 像素；load 事件${report.loaded ? "已触发" : "还没触发（有资源还在加载）"}。`];
  if (!report.errors.length) lines.push("报告时没有脚本错误、资源加载失败和 console.error。");
  else {
    lines.push(`报告时有 ${report.errors.length} 个问题：`);
    for (const e of report.errors) lines.push(`- ${KIND_LABEL[e.kind]}${e.line ? `（widget_code 第 ${e.line} 行）` : ""}：${e.message}`);
  }
  return lines.join("\n");
}

/** 在对话里显示 HTML / SVG 部件：网页按这次调用的参数渲染（client/src/components/Widget.tsx），显示后报告结果，工具等到报告再返回 */
export function visualizeServer(sessionId: string): McpSdkServerConfigWithInstance {
  const show = tool(
    "show_widget",
    DESCRIPTION,
    {
      title: z.string().optional().describe("部件的简短名称，给读屏软件和 iframe 的 title 用"),
      loading_messages: z.array(z.string()).max(4).optional().describe("生成参数期间在部件位置轮流显示的提示，1–4 句"),
      widget_code: z.string().describe("HTML 片段或 SVG"),
    },
    async ({ widget_code }, extra) => {
      if (!widget_code.trim()) return { content: [{ type: "text" as const, text: "widget_code 是空的，没有显示。" }], isError: true };
      // tool_use_id 是 Claude Code 调 MCP 工具时放在 _meta 里的（同 browser/tool.ts 的 rememberResult）；拿不到就没法对上网页的报告
      const toolUseId = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["claudecode/toolUseId"];
      if (typeof toolUseId !== "string") return { content: [{ type: "text" as const, text: "已交给界面显示，没有显示结果。" }] };
      const report = await waitReport(sessionId, toolUseId, (extra as { signal?: AbortSignal } | undefined)?.signal);
      const text = report ? describeReport(report) : `已交给界面显示；${REPORT_TIMEOUT_MS / 1000} 秒内没有网页报告显示结果。`;
      return { content: [{ type: "text" as const, text }] };
    },
  );
  return createSdkMcpServer({
    name: VISUALIZE_SERVER,
    version: "1.0.0",
    instructions: "show_widget 在对话里显示 HTML 或 SVG 部件（沙箱 iframe），用户可以直接看到和操作。",
    // config.yml 里配了常驻的：第一轮就给完整定义（默认不常驻，用到时 ToolSearch）
    tools: [isAlwaysLoad(SHOW_WIDGET_TOOL) ? { ...show, _meta: { ...show._meta, [ALWAYS_LOAD_META]: true } } : show],
  });
}
