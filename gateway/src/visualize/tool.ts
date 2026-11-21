import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ALWAYS_LOAD_META, isAlwaysLoad } from "../config-file.js";

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

const DESCRIPTION = [
  "在对话里显示一段 HTML 或 SVG（部件），位置就是这次调用在对话里的位置，用户直接看到、可以操作。",
  "widget_code：HTML 片段（不含 <!DOCTYPE>、<html>、<head>、<body>），或以 <svg 开头的 SVG。部件在这次调用的参数完整生成后才显示。",
  "运行环境：",
  "- 沙箱 iframe，源是不透明的（opaque origin）：脚本可以执行；访问不到用户界面的页面；localStorage、sessionStorage、cookie 不可用（访问会抛错）；表单提交、alert/confirm/prompt、window.open 不可用。",
  `- 外部的脚本、样式、字体、图片和 fetch 只能连 ${ORIGINS.join("、")}（https），其余地址被内容安全策略拦截；图片还可以是 data:、blob:。`,
  "- 宽度等于对话区的宽度（最宽约 880 像素，随窗口变窄）；高度随内容自动变化，position: fixed 的元素不算在内容高度里。",
  "- 部件背景透明，底下是对话区的底色。用户界面有浅色、深色两种主题，还可以开背景皮肤；切换时下面这些 CSS 变量的值跟着变，部件不重新加载：",
  "  --bg 对话区底色，--panel 面板、卡片底色，--text 正文，--muted 次要文字，--border 边框，--accent 强调色，--accent-text 强调色底上的文字，--ok 成功，--warn 警告，--err 错误，--code-bg 代码块底色，--font-ui 界面字体，--font-mono 等宽字体。",
  "  另有一组同义变量，值取自上面那些，同样跟着主题变：--surface-0、--surface-2、--surface-3 = --bg，--surface-1 = --panel；--text-primary = --text，--text-secondary、--text-muted = --muted；" +
    "--border-strong、--border-stronger 是比 --border 深的两级边框；--text-accent / --bg-accent / --border-accent 是强调色的文字 / 淡底 / 边框，" +
    "--text-success / --bg-success、--text-warning / --bg-warning、--text-danger / --bg-danger 同理（取自 --ok、--warn、--err）；--font-sans = --font-ui；--radius 是 8px。",
  "  <html> 的 data-theme 属性是 light 或 dark。body 默认：外边距 0，字体 var(--font-ui)，颜色 var(--text)，字号 15px。",
  "- 全局函数 sendPrompt(text)：以用户的身份把 text 作为一条新消息发出（一轮进行中时排队）。除此之外，用户在部件里的操作不会传给你。",
  "- 全局函数 openLink(url)：在用户的浏览器里打开 http(s) 地址；点击 http(s) 链接也一样。",
  "loading_messages：部件显示出来之前，它的位置上轮流显示这几句（每句约 2.5 秒）；不传时那里是空白。",
  "工具结果只表示部件已交给界面显示，不包含显示出来的样子，也不包含脚本错误。",
  "部件的代码留在会话记录里：重新打开会话时部件重新显示，脚本重新执行，之前在部件里的操作状态不保留。",
].join("\n");

/** 在对话里显示 HTML / SVG 部件：工具本身什么都不做，网页按这次调用的参数渲染（client/src/components/Widget.tsx） */
export function visualizeServer(): McpSdkServerConfigWithInstance {
  const show = tool(
    "show_widget",
    DESCRIPTION,
    {
      title: z.string().optional().describe("部件的简短名称，给读屏软件和 iframe 的 title 用"),
      loading_messages: z.array(z.string()).max(4).optional().describe("部件显示出来之前轮流显示的提示，1–4 句"),
      widget_code: z.string().describe("HTML 片段或 SVG"),
    },
    async ({ widget_code }) => {
      if (!widget_code.trim()) return { content: [{ type: "text" as const, text: "widget_code 是空的，没有显示。" }], isError: true };
      return { content: [{ type: "text" as const, text: "已显示在对话里。" }] };
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
