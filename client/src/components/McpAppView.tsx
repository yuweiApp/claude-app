import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppBridge, buildAllowAttribute, PostMessageTransport, type McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { Allow, parse } from "partial-json";
import type { McpAppResource, McpAppTool } from "@gateway/shared/types";
import { api } from "../api";
import type { ToolResult } from "../state/session";
import { FileLinkContext } from "./ReplyMarkdown";
import { WidgetHostContext } from "./Widget";

/**
 * MCP Apps（SEP-1865）的界面：MCP 服务器给工具配的 ui:// 资源，渲染在这次工具调用的位置，见 docs/mcp-apps.md。
 * 和界面之间的协议用官方 SDK 的宿主实现（@modelcontextprotocol/ext-apps 的 AppBridge + PostMessageTransport），
 * 这里只接上本项目的东西：调工具、发消息、开链接、给模型的内容、主题、高度。
 * 沙箱：有沙箱代理（网关的另一个端口，和网页不同源）时两层——外层是代理页，代理页再建内层装界面（规范的 Sandbox proxy）；
 * 没有时（公网分享的访客、代理没监听上）退回单层 srcdoc iframe（不给 allow-same-origin，源是 null）
 */

/** 会话 id 和沙箱代理的端口（网关 /config 的 mcpAppsSandboxPort） */
export const McpAppSessionContext = createContext<{ sessionId: string; sandboxPort: number | null } | null>(null);

const HOST_INFO = { name: "claude-app", version: "0.1.0" };

/** 界面多久没完成初始化就提示 */
const INIT_TIMEOUT_MS = 20_000;

/** 模型还没写完的参数（不完整的 JSON）：能解析出来的部分；还解析不了时是空对象 */
export function parsePartialInput(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const value: unknown = parse(json, Allow.ALL);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 单层显示：CSP（网关按资源声明生成的，同代理页的 HTTP 头）以 <meta> 插在 <head> 最前面（在界面自己的脚本之前生效） */
function srcDoc(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${meta}</head>` + html.slice(htmlTag.index + htmlTag[0].length);
  return `<!DOCTYPE html><html><head>${meta}</head><body>${html}</body></html>`;
}

/** 沙箱代理页的地址：网页自己的主机名、代理的端口（网页是 https 时 http 的代理会被当成混合内容拦下，不用） */
function sandboxUrl(port: number | null, resource: McpAppResource): string | null {
  if (!port || location.protocol !== "http:") return null;
  return `http://${location.hostname}:${port}/sandbox.html?csp=${encodeURIComponent(JSON.stringify(resource.csp ?? {}))}`;
}

/** 规范里的样式变量 ← 本项目的主题变量（跨源 iframe 继承不到变量，取算好的值发过去） */
const STYLE_VARS: Record<string, string> = {
  "--color-background-primary": "--bg",
  "--color-background-secondary": "--panel",
  "--color-background-tertiary": "--code-bg",
  "--color-text-primary": "--text",
  "--color-text-secondary": "--muted",
  "--color-text-tertiary": "--muted",
  "--color-text-info": "--accent",
  "--color-text-success": "--ok",
  "--color-text-warning": "--warn",
  "--color-text-danger": "--err",
  "--color-border-primary": "--border",
  "--color-border-secondary": "--border",
  "--color-ring-primary": "--accent",
  "--font-sans": "--font-ui",
  "--font-mono": "--font-mono",
};

/**
 * 宿主上下文（ui/initialize 时给，主题、宽度变了用 setHostContext 更新）。
 * 不给 toolInfo：它的 tool 是完整的 MCP Tool（必须有 inputSchema），网关的工具表里没有，只给 name 时 SDK 校验不通过
 */
function hostContext(frame: HTMLElement): McpUiHostContext {
  const style = getComputedStyle(frame);
  const variables: Record<string, string> = { "--border-radius-sm": "6px", "--border-radius-md": "8px", "--border-radius-lg": "12px" };
  for (const [name, ours] of Object.entries(STYLE_VARS)) {
    const value = style.getPropertyValue(ours).trim();
    if (value) variables[name] = value;
  }
  return {
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    styles: { variables: variables as NonNullable<McpUiHostContext["styles"]>["variables"] },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    ...(frame.clientWidth ? { containerDimensions: { maxWidth: frame.clientWidth } } : {}),
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: "web",
  };
}

export function McpAppView({
  toolUseId,
  partial,
  toolName,
  tool,
  input,
  result,
  raw,
}: {
  /** 界面所在的工具调用 */
  toolUseId: string;
  /** 模型还在写参数：input 是解析出来的部分参数 */
  partial: boolean;
  /** 工具全名（mcp__服务器__工具） */
  toolName: string;
  tool: McpAppTool;
  input: Record<string, unknown>;
  result?: ToolResult;
  raw?: { structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> };
}) {
  const session = useContext(McpAppSessionContext);
  const sessionId = session?.sessionId ?? null;
  const host = useContext(WidgetHostContext);
  const files = useContext(FileLinkContext);
  const hostRef = useRef({ host, files, sessionId });
  hostRef.current = { host, files, sessionId };
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [resource, setResource] = useState<McpAppResource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api.mcpAppResource(sessionId, toolName).then(
      (r) => !cancelled && setResource(r),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, toolName]);

  // 两层还是单层在拿到资源时定下来，之后不变（换了要重新加载界面）
  const [frameSrc, setFrameSrc] = useState<{ proxy: string } | { doc: string } | null>(null);
  useEffect(() => {
    if (!resource) return;
    const proxy = sandboxUrl(session?.sandboxPort ?? null, resource);
    setFrameSrc(proxy ? { proxy } : { doc: srcDoc(resource.html, resource.cspPolicy) });
  }, [resource]);

  // 工具结果交给界面：MCP 的 CallToolResult，文字取 tool_result，structuredContent、_meta 取 tool_use_result / 会话文件的 mcpMeta
  const callResult: CallToolResult | null =
    result && !result.isError
      ? {
          content: [{ type: "text", text: result.text }],
          ...(raw?.structuredContent ? { structuredContent: raw.structuredContent } : {}),
          ...(raw?._meta ? { _meta: raw._meta } : {}),
        }
      : null;
  const latest = useRef({ input, partial, callResult, error: result?.isError ? result.text : null });
  latest.current = { input, partial, callResult, error: result?.isError ? result.text : null };

  /**
   * 界面初始化完了没有、完整参数发了没有、结果（或取消）发了没有。
   * 顺序按规范：初始化之后先发参数（模型还在写时发部分参数，写完发一次完整的），再发结果；调用出错、被中断发 tool-cancelled
   */
  const bridgeRef = useRef<{ bridge: AppBridge; initialized: boolean; inputSent: boolean; resultSent: boolean } | null>(null);
  const flush = () => {
    const b = bridgeRef.current;
    if (!b?.initialized) return;
    const now = latest.current;
    if (!b.inputSent) {
      if (now.partial) {
        void b.bridge.sendToolInputPartial({ arguments: now.input });
        return;
      }
      b.inputSent = true;
      void b.bridge.sendToolInput({ arguments: now.input });
    }
    if (b.resultSent) return;
    if (now.callResult) {
      b.resultSent = true;
      void b.bridge.sendToolResult(now.callResult);
    } else if (now.error !== null) {
      b.resultSent = true;
      void b.bridge.sendToolCancelled({ reason: now.error });
    }
  };
  const inputKey = partial ? JSON.stringify(input) : "";
  useEffect(flush, [partial, inputKey, callResult !== null, result?.isError === true]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow || !frameSrc || !resource) return;
    const bridge = new AppBridge(
      null,
      HOST_INFO,
      {
        openLinks: {},
        serverTools: {},
        logging: {},
        message: { text: {} },
        updateModelContext: { text: {}, structuredContent: {} },
        sandbox: { csp: resource.csp ?? {}, ...(resource.permissions ? { permissions: resource.permissions } : {}) },
      },
      { hostContext: hostContext(frame) },
    );
    const state = { bridge, initialized: false, inputSent: false, resultSent: false };
    bridgeRef.current = state;

    // 两层：代理页加载好了，把界面的 HTML 和声明交给它
    if ("proxy" in frameSrc)
      bridge.addEventListener("sandboxready", () => {
        void bridge.sendSandboxResourceReady({ html: resource.html, csp: resource.csp, permissions: resource.permissions });
      });
    bridge.addEventListener("initialized", () => {
      state.initialized = true;
      setInitialized(true);
      flush();
    });
    bridge.addEventListener("sizechange", ({ height }) => {
      if (typeof height === "number") setHeight(Math.max(0, Math.ceil(height)));
    });
    bridge.addEventListener("loggingmessage", () => {});
    // 界面调用工具：经网关交给 Claude Code（只能调同一个服务器上 visibility 含 app 的，网关检查）
    bridge.oncalltool = async (params) => {
      const id = hostRef.current.sessionId;
      if (!id) throw new Error("不在会话里");
      return (await api.mcpAppCall(id, toolName, params.name, params.arguments ?? {})) as CallToolResult;
    };
    // 以用户的身份发一条消息（同部件的 sendPrompt）
    bridge.onmessage = async (params) => {
      const text = params.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
      if (!text) throw new Error("消息是空的");
      if (!hostRef.current.host) throw new Error("不在会话里");
      hostRef.current.host.prompt(text);
      return {};
    };
    // 给模型的内容：网关按这次工具调用记最后一份，附在下一条用户消息前面
    bridge.onupdatemodelcontext = async (params) => {
      const id = hostRef.current.sessionId;
      if (!id) throw new Error("不在会话里");
      await api.mcpAppContext(id, {
        toolUseId,
        from: toolName,
        ...(params.content ? { content: params.content } : {}),
        ...(params.structuredContent ? { structuredContent: params.structuredContent } : {}),
      });
      return {};
    };
    bridge.onopenlink = async ({ url }) => {
      if (!/^https?:/i.test(url)) throw new Error("Invalid URL");
      const open = hostRef.current.files?.openUrl;
      if (open) open(url);
      else window.open(url, "_blank", "noopener,noreferrer");
      return {};
    };
    bridge.onrequestdisplaymode = async () => ({ mode: "inline" });

    void bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));

    // 主题、皮肤、外观设置、宽度变了：更新宿主上下文，SDK 只把变了的字段发给界面
    const update = () => bridge.setHostContext(hostContext(frame));
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin", "style", "class"] });
    const sized = new ResizeObserver(update);
    sized.observe(frame);
    const timer = setTimeout(() => !state.initialized && setSlow(true), INIT_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      sized.disconnect();
      if (bridgeRef.current === state) bridgeRef.current = null;
      // 卸载前告诉界面（规范的 ui/resource-teardown）；iframe 马上就没了，不等它回复
      if (state.initialized) void bridge.teardownResource({}).catch(() => {});
      void bridge.close();
    };
  }, [frameSrc]);

  if (error) return <div className="mcp-app mcp-app-error">界面显示不了：{error}</div>;
  const loading = !frameSrc || height === null;
  return (
    <div className={`mcp-app widget${loading ? " loading" : ""}${resource?.prefersBorder ? " bordered" : ""}`}>
      {loading && (
        <div className="widget-loading" role="status">
          <span className="widget-loading-dot" />
          {slow && !initialized ? `${tool.server} 的界面 ${INIT_TIMEOUT_MS / 1000} 秒内没有完成初始化` : `正在加载 ${tool.server} 的界面…`}
        </div>
      )}
      {frameSrc && (
        <iframe
          ref={frameRef}
          className="widget-frame"
          title={`${tool.server} / ${tool.tool}`}
          // 两层：外层代理页和网页不同源，给 allow-same-origin 它才有自己的源（内层界面跟着它）；单层不给，源是 null
          sandbox={"proxy" in frameSrc ? "allow-scripts allow-same-origin" : "allow-scripts"}
          allow={buildAllowAttribute(resource?.permissions)}
          {...("proxy" in frameSrc ? { src: frameSrc.proxy } : { srcDoc: frameSrc.doc })}
          style={{ height: height ?? 28 }}
        />
      )}
      {result?.isError && <div className="mcp-app-note">调用出错：{result.text}</div>}
    </div>
  );
}
