import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MCP_AUTO_BACKGROUND_MS } from "../config.js";
import { ALWAYS_LOAD_META, isAlwaysLoad } from "../config-file.js";
import { rememberResult } from "../browser/tool.js";
import { runCli, type CliResult, type Envelope } from "./cli.js";
import { deniedReason, flagValues, isReadOnly } from "./commands.js";
import { beginWrite, checkTarget, describeRefs, othersSince, recordOperation, registerRefsIn, registerSnapshot, stripOwn } from "./guard.js";
import { renderSnapshot, type SnapshotData } from "./render.js";

/**
 * 桌面操作：经 agent-desktop（https://github.com/vercel-labs/agent-desktop）读系统的无障碍树、操作网关所在电脑上的原生应用。
 * 每次调用起一个 agent-desktop 进程，见 docs/agent-desktop.md。
 * MCP 服务器名 desktop，工具全名 mcp__desktop__snapshot 这样（工具名不再加 desktop_ 前缀）
 */
export const DESKTOP_SERVER = "desktop";
const full = (name: string) => `mcp__${DESKTOP_SERVER}__${name}`;
/** 只读的工具不用确认（options.allowedTools）；run 在 Session.canUseTool 里按命令判断 */
export const DESKTOP_READ_TOOLS = [full("snapshot"), full("screenshot")];
export const DESKTOP_RUN_TOOL = full("run");

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** 截图原始大小上限：模型接口的单张图片上限是 base64 后 5MB */
const MAX_IMAGE_BYTES = 3_750_000;
const BACKGROUND_SECONDS = (Number(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS) || MCP_AUTO_BACKGROUND_MS) / 1000;

const version = (() => {
  try {
    return (createRequire(import.meta.url)("agent-desktop/package.json") as { version: string }).version;
  } catch {
    return "?";
  }
})();

const PLATFORM = { win32: "Windows", darwin: "macOS", linux: "Linux" }[process.platform as string] ?? process.platform;
const ACCESSIBILITY_API = { win32: "UI Automation", darwin: "AX API", linux: "AT-SPI" }[process.platform as string] ?? "无障碍接口";

/**
 * ref 能不能用的规则（agent-desktop 内置的平台说明）：Windows、Linux 按角色、名字、描述重新认元素，不唯一的 ref 用不了；
 * macOS 的 ref 带着元素自己的地址，没有这条限制。实测 Windows 上紫鸟浏览器（Chromium）里没名字的 group 都是这样
 */
const REF_RULE =
  process.platform === "darwin"
    ? "ref 指向快照时的那个元素本身，几个一模一样的元素各有各的 ref。"
    : "执行命令时按快照里记下的角色、原生 id、名字、描述重新找这个元素：拍快照时它在整个窗口里不唯一（比如几个没有名字的 group），这个 ref 用来操作时返回 AMBIGUOUS_TARGET（details.kind: identity_not_unique），重拍快照也一样。";

/** 给模型的说明：只写事实（环境、接口、规则、机制），不写做法，见 CLAUDE.md */
const INSTRUCTIONS = [
  `桌面：运行网关的这台电脑（${PLATFORM}）上、当前登录用户的桌面（原生应用的窗口、菜单、对话框），经系统的无障碍接口（${ACCESSIBILITY_API}）读取和操作，工具是 agent-desktop ${version}。用户可能同时在用这台电脑。`,
  "- snapshot 返回一个窗口的无障碍树，元素带 [ref=@快照编号:eN]。ref 只在产生它的快照里有效；界面变了，用旧 ref 的命令返回 STALE_REF 或 AMBIGUOUS_TARGET。",
  `- ${REF_RULE}`,
  "- screenshot 返回一个窗口或一块屏幕的图片。",
  '- run 执行一条 agent-desktop 命令，args[0] 是命令名，返回它的 JSON 结果：成功时是 data；失败时是 error，其中 disposition.delivery 表示动作送到没有，disposition.retry 为 safe 表示重复执行不会重复生效。["<命令>", "--help"] 返回这条命令的参数说明。',
  "- run 的命令：",
  "  读取：find（按角色、名字、值、文字找元素）、get（读元素属性）、is（查元素状态）、list-apps、list-windows、list-displays、list-surfaces、list-notifications、wait（等时间、元素、窗口、文字、菜单、通知）、status、permissions、version、skills",
  "  按 ref 操作：click、double-click、triple-click、right-click、type、set-value、clear、focus、select、toggle、check、uncheck、expand、collapse、scroll、scroll-to",
  "  键盘鼠标：press、hover、drag、mouse-move、mouse-click、mouse-wheel",
  "  应用和窗口：launch、close-app、focus-window、resize-window、move-window、minimize、maximize、restore、open-system-surface",
  "  通知：dismiss-notification、dismiss-all-notifications、notification-action；剪贴板：clipboard-get、clipboard-set、clipboard-clear；其他：cursor-overlay",
  "- 默认经无障碍接口操作，不移动鼠标、不切换前台窗口。run 的 headed 为 true 时用真实的鼠标键盘，会移动鼠标、切换前台窗口；一部分命令只在 headed 下可用（它们的 --help 里写着 requires --headed）。",
  "- 网关的规则：本应用（claude-app）自己的窗口不在结果里，也不能读取或操作；ref 只认这个会话经 snapshot 或 find 拿到的；find、press、list-surfaces 和窗口命令（focus-window、restore 等）不指定目标时作用于前台窗口，网关要求指定目标（每条命令接受哪些目标参数见它的 --help）；" +
    "run 不执行 snapshot、screenshot（用对应的工具）、mcp、session、trace、batch，不接受参数 --session、--agent-id、--trace、--trace-strict、--screenshot、--debug、--force、--cdp、--stdin、--headed（用 headed 参数）。",
  `- 调用超过约 ${BACKGROUND_SECONDS} 秒会转为后台任务：先返回一条「在后台运行」的结果，结束后结果作为通知送达。屏幕上的变化不会通知你。`,
  "- 别的会话也可能在操作这个桌面：自你上次调用以来它们执行过的操作，列在下一次结果的开头。",
  `- 截图原始大小超过 ${(MAX_IMAGE_BYTES / 1e6).toFixed(2)}MB 时不返回图片。`,
].join("\n");

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const error = (t: string) => ({ ...text(t), isError: true });
const prefixed = (notice: string | null, body: string) => (notice ? `${notice}\n\n${body}` : body);

/** agent-desktop 的错误：留下事实（code、message、details、disposition），去掉它建议的做法（suggestion、recovery） */
function formatError(err: NonNullable<Envelope["error"]>): string {
  const { code, message, details, disposition } = err;
  return JSON.stringify({ code, message, ...(details !== undefined ? { details: stripOwn(details) } : {}), ...(disposition ? { disposition } : {}) });
}

/** 没有拿到 agent-desktop 的 JSON 结果时的说明（被终止、输出不是 JSON），有 JSON 结果返回 null */
function failure(result: CliResult, timeoutMs: number): string | null {
  if (result.killed === "timeout") return `命令超过 timeout_ms（${timeoutMs} 毫秒）被网关终止，动作可能已经生效`;
  if (result.killed === "abort") return "调用被中断，网关终止了命令，动作可能已经生效";
  if (result.envelope) return null;
  return result.stdout.trim() || `agent-desktop 没有输出结果${result.stderr.trim() ? `：${result.stderr.trim().slice(0, 2000)}` : ""}`;
}

const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal;

/** 只有在 app、window_id 等目标参数都没给时报错 */
const needOne = (names: string[]) => `${names.join("、")} 至少给一个`;

export function desktopServer(sessionId: string): McpSdkServerConfigWithInstance {
  const tools = [
    tool(
      "snapshot",
      "一个窗口的无障碍树（默认只列可交互的元素），元素带 [ref=@快照编号:eN]，run 的命令用这个 ref 指定元素。不改动界面。",
      {
        app: z.string().optional().describe("应用名（list-apps 里的 name）"),
        window_id: z.string().optional().describe("窗口 id（list-windows 里的 id）"),
        root: z.string().optional().describe("从这个 ref 往下读，不读整个窗口"),
        interactive_only: z.boolean().optional().describe("只列可交互的元素，默认 true"),
        skeleton: z.boolean().optional().describe("只读浅层结构，截断的容器带子元素数"),
        max_depth: z.number().int().min(1).max(50).optional().describe("最大深度，默认 10"),
        include_bounds: z.boolean().optional().describe("带上元素的位置和大小"),
        timeout_ms: z.number().int().min(500).max(120_000).optional().describe("读取期限（毫秒），默认 3000"),
      },
      async (input, extra) => {
        const notice = othersSince(sessionId);
        if (!input.app && !input.window_id && !input.root) return error(prefixed(notice, needOne(["app", "window_id", "root"])));
        const args = [
          "snapshot",
          "--compact",
          ...(input.interactive_only !== false ? ["-i"] : []),
          ...(input.app ? ["--app", input.app] : []),
          ...(input.window_id ? ["--window-id", input.window_id] : []),
          ...(input.root ? ["--root", input.root] : []),
          ...(input.skeleton ? ["--skeleton"] : []),
          ...(input.max_depth ? ["--max-depth", String(input.max_depth)] : []),
          ...(input.include_bounds ? ["--include-bounds"] : []),
          ...(input.timeout_ms ? ["--timeout-ms", String(input.timeout_ms)] : []),
        ];
        const denied = await checkTarget(sessionId, args);
        if (denied) return error(prefixed(notice, denied));
        const timeoutMs = (input.timeout_ms ?? 3000) + 30_000;
        const result = await runCli(args, { session: sessionId, timeoutMs, signal: signalOf(extra) });
        const failed = failure(result, timeoutMs);
        if (failed) return error(prefixed(notice, failed));
        const envelope = result.envelope!;
        if (!envelope.ok) return error(prefixed(notice, formatError(envelope.error!)));
        const data = envelope.data as SnapshotData;
        registerSnapshot(sessionId, data);
        return text(prefixed(notice, renderSnapshot(data)));
      },
      { annotations: { title: "Desktop snapshot", readOnlyHint: true, openWorldHint: false } },
    ),
    tool(
      "screenshot",
      "一个窗口（app 或 window_id）或一块屏幕（screen）的 PNG 图片。给了 app 或 window_id 时截窗口，screen 不起作用。窗口被别的窗口挡住时不截。",
      {
        app: z.string().optional().describe("应用名（list-apps 里的 name）"),
        window_id: z.string().optional().describe("窗口 id（list-windows 里的 id）"),
        screen: z.number().int().min(0).optional().describe("屏幕序号（list-displays；0 是主屏幕），截整块屏幕"),
      },
      async (input, extra) => {
        const notice = othersSince(sessionId);
        // 模型常把可选参数都填上（app: ""、screen: 0），agent-desktop 不接受 --screen 和 --app / --window-id 一起给：给了窗口就截窗口
        const screen = input.app || input.window_id ? undefined : input.screen;
        if (!input.app && !input.window_id && screen === undefined) return error(prefixed(notice, needOne(["app", "window_id", "screen"])));
        const dir = await mkdtemp(path.join(os.tmpdir(), "claude-app-desktop-"));
        const file = path.join(dir, "screenshot.png");
        try {
          const args = [
            "screenshot",
            ...(input.app ? ["--app", input.app] : []),
            ...(input.window_id ? ["--window-id", input.window_id] : []),
            ...(screen !== undefined ? ["--screen", String(screen)] : []),
            file,
          ];
          const denied = await checkTarget(sessionId, args);
          if (denied) return error(prefixed(notice, denied));
          const result = await runCli(args, { session: sessionId, timeoutMs: 60_000, signal: signalOf(extra) });
          const failed = failure(result, 60_000);
          if (failed) return error(prefixed(notice, failed));
          if (!result.envelope!.ok) return error(prefixed(notice, formatError(result.envelope!.error!)));
          const png = await readFile(file);
          if (png.length > MAX_IMAGE_BYTES) {
            return error(prefixed(notice, `截图有 ${(png.length / 1e6).toFixed(1)}MB，超过 ${(MAX_IMAGE_BYTES / 1e6).toFixed(2)}MB 的上限，没有返回图片`));
          }
          return {
            content: [
              ...(notice ? [{ type: "text" as const, text: notice }] : []),
              { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
            ],
          };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      { annotations: { title: "Desktop screenshot", readOnlyHint: true, openWorldHint: false } },
    ),
    tool(
      "run",
      `执行一条 agent-desktop 命令（args[0] 是命令名），返回它的 JSON 结果；["<命令>", "--help"] 返回参数说明。timeout_ms 默认 ${DEFAULT_TIMEOUT_MS}、最大 ${MAX_TIMEOUT_MS}。`,
      {
        args: z.array(z.string()).min(1).describe('命令和参数，如 ["click", "@s8f3k2p9:e3"]'),
        headed: z.boolean().optional().describe("用真实的鼠标键盘（会移动鼠标、切换前台窗口），默认 false"),
        timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe(`最多跑多久（毫秒），默认 ${DEFAULT_TIMEOUT_MS}`),
      },
      async ({ args, headed, timeout_ms }, extra) => {
        const notice = othersSince(sessionId);
        const done = (body: string, isError: boolean) => {
          const out = prefixed(notice, body);
          rememberResult(extra, out, isError);
          return isError ? error(out) : text(out);
        };
        const denied = deniedReason(args) ?? (await checkTarget(sessionId, args));
        if (denied) return done(denied, true);
        const readOnly = isReadOnly(args);
        const endWrite = readOnly ? null : beginWrite();
        const timeoutMs = timeout_ms ?? DEFAULT_TIMEOUT_MS;
        let result: CliResult;
        try {
          result = await runCli(args, { session: sessionId, headed, timeoutMs, signal: signalOf(extra) });
        } finally {
          endWrite?.();
        }
        const delivered = result.envelope?.ok || (result.envelope?.error?.disposition?.delivery ?? "unknown") !== "not_delivered";
        if (!readOnly && delivered) recordOperation(sessionId, args);
        const failed = failure(result, timeoutMs);
        if (failed) return done(failed, Boolean(result.killed) || !result.stdout.trim());
        const envelope = result.envelope!;
        if (!envelope.ok) return done(formatError(envelope.error!), true);
        registerRefsIn(sessionId, result.stdout, flagValues(args, "--app")[0]);
        return done(JSON.stringify(stripOwn(envelope.data) ?? null), false);
      },
      { annotations: { title: "Desktop command", readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    ),
  ];

  return createSdkMcpServer({
    name: DESKTOP_SERVER,
    version: "1.0.0",
    instructions: INSTRUCTIONS,
    tools: tools.map((t) => (isAlwaysLoad(full(t.name)) ? { ...t, _meta: { ...t._meta, [ALWAYS_LOAD_META]: true } } : t)),
  });
}

/** 权限卡片上的说明：命令行、ref 指向的目标、headed 时会动鼠标 */
export function describeRun(input: Record<string, unknown>): string {
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  return [
    args.map((a) => (/^[\w@:.,=/+-]+$/.test(a) ? a : JSON.stringify(a))).join(" "),
    ...describeRefs(args),
    ...(input.headed ? ["使用真实的鼠标键盘：会移动鼠标、切换前台窗口"] : []),
  ].join("\n");
}

export { isReadOnly as isReadOnlyRun };
