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
import type { DesktopTarget } from "../shared/types.js";
import { beginWrite, checkTarget, describeRefs, listDisplays, listWindows, noteTarget, othersSince, recordOperation, registerRefsIn, registerSnapshot, stripOwn } from "./guard.js";
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
/**
 * snapshot 的读取期限默认值。agent-desktop 自己的默认是 3000：Windows 上紫鸟（Chromium）在 3 秒内没读到窗口的根就报 TIMEOUT
 * （walk_root_unread）；它的 Windows 说明里写 Chromium、Electron 应用第一次读要 10–25 秒才完整。期限是上限，读完就返回
 */
const SNAPSHOT_TIMEOUT_MS = 15_000;
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

/**
 * 给模型的说明。例外于 CLAUDE.md 的「只写事实」：让模型先读 agent-desktop 自带的 skill（编进二进制、和版本对应，里面是做法和步骤）并照着做，
 * 和上游 README 给 agent 的那句一样；其余只写事实
 */
const INSTRUCTIONS = [
  `桌面：运行网关的这台电脑（${PLATFORM}）上、当前登录用户的桌面（原生应用的窗口、菜单、对话框），经系统的无障碍接口（${ACCESSIBILITY_API}）读取和操作，工具是 agent-desktop ${version}。用户可能同时在用这台电脑。`,
  '- 第一次使用前，先用 run 执行 ["skills", "get", "desktop"] 和 ["skills", "get", "platform"]，读 agent-desktop 自带的使用说明（和这个版本对应），按里面的做法操作；说明里提到的参考文档用 ["skills", "get", "desktop", "<文件名>"] 读。',
  "- 使用说明里的命令行写法 `agent-desktop <命令> <参数…>` 在这里对应：snapshot、screenshot 用同名工具（参数见工具定义），其余命令用 run，args 是数组、直接交给程序，不经过 shell（说明里 PowerShell、POSIX shell 的引号转义用不上）。这里没有 agent-desktop 命令行，Bash 里也没有。",
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
    `run 不执行 snapshot、screenshot（用对应的工具）、mcp、session、trace、batch，不接受参数 --session、--agent-id、--trace、--trace-strict、--screenshot、--debug、--force、--stdin、--headed（用 headed 参数）、--cdp。`,
  `- 调用超过约 ${BACKGROUND_SECONDS} 秒会转为后台任务：先返回一条「在后台运行」的结果，结束后结果作为通知送达。屏幕上的变化不会通知你。`,
  "- 别的会话也可能在操作这个桌面：自你上次调用以来它们执行过的操作，列在下一次结果的开头。",
  `- 截图原始大小超过 ${(MAX_IMAGE_BYTES / 1e6).toFixed(2)}MB 时不返回图片。`,
  "- 用户消息里的 @桌面 指这个桌面，@desktop[标题](window:<id>) 指这里的一个窗口，<id> 是用户引用时 list-windows 里它的窗口 id。",
].join("\n");

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const error = (t: string) => ({ ...text(t), isError: true });
const prefixed = (notice: string | null, body: string) => (notice ? `${notice}\n\n${body}` : body);

/** agent-desktop 的错误：留下事实（code、message、details、disposition），去掉它建议的做法（suggestion、recovery） */
function formatError(err: NonNullable<Envelope["error"]>): string {
  const { code, message, details, disposition } = err;
  return JSON.stringify({ code, message, ...(details !== undefined ? { details: stripOwn(details) } : {}), ...(disposition ? { disposition } : {}) });
}

/**
 * 成功结果里也可能带它建议的做法（如 launch 的 suggestion），同错误一样去掉，事实留着
 */
function withoutAdvice(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const { suggestion: _s, recovery: _r, ...rest } = data as Record<string, unknown>;
  return rest;
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

/**
 * snapshot、screenshot 给了 window_id 时不传 --app：窗口 id 已经唯一。agent-desktop 两个都给时先按 --app 找应用，
 * 实测 Windows 上模型把 @desktop 引用里的窗口标题填进 app，返回 APP_NOT_FOUND；填进程名（electron.exe）时又和本应用同名，被网关拦下
 */
const appUnlessWindow = (input: { app?: string; window_id?: string }) => (input.window_id ? undefined : input.app || undefined);

/** PNG 的宽高（IHDR） */
const pngSize = (png: Buffer) => (png.length >= 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null);

/**
 * 截图对应桌面上的哪一块：屏幕或窗口在桌面坐标里的范围、屏幕的缩放，和图片的像素大小。
 * 坐标命令（mouse-click --xy 等）用的是桌面坐标；实测 Windows 两块屏（125%、150%）都是按像素算，副屏从 x=1920 开始，
 * 模型拿到的截图还可能被 Claude Code 缩小过（它会另外说明缩放比例）
 */
async function screenshotGeometry(png: Buffer, target: { app?: string; windowId?: string; screen?: number }): Promise<string | null> {
  const size = pngSize(png);
  const pixels = size ? `；图片 ${size.width}×${size.height} 像素` : "";
  const range = (b: { x: number; y: number; width: number; height: number }) => `x ${b.x}–${b.x + b.width}、y ${b.y}–${b.y + b.height}`;
  if (target.screen !== undefined) {
    const display = (await listDisplays())[target.screen];
    if (!display?.bounds) return null;
    return `截的是屏幕 ${target.screen}${display.is_primary ? "（主屏幕）" : ""}：桌面坐标 ${range(display.bounds)}${display.scale ? `，缩放 ${Math.round(display.scale * 100)}%` : ""}${pixels}`;
  }
  const windows = await listWindows();
  const matches = target.windowId ? windows.filter((w) => w.id === target.windowId) : windows.filter((w) => w.app_name?.toLowerCase() === target.app?.toLowerCase());
  const win = matches.length === 1 ? matches[0] : undefined;
  if (!win?.bounds) return null;
  return `截的是窗口 ${win.id}${win.title ? `「${win.title}」` : ""}：桌面坐标 ${range(win.bounds)}${pixels}`;
}

/**
 * onTarget：调用作用的窗口变了（网页右上角的浮窗显示它）。调用一开始就报（snapshot 读得慢时浮窗不用等），launch 等结束了再报（之前还没有窗口）。
 * 报的过程（list-windows）不耽误工具返回
 */
export function desktopServer(sessionId: string, onTarget?: (target: DesktopTarget | null) => void): McpSdkServerConfigWithInstance {
  const note = (args: string[]) => {
    if (onTarget) void noteTarget(sessionId, args, onTarget).catch(() => {});
  };
  const tools = [
    tool(
      "snapshot",
      "一个窗口的无障碍树（默认只列可交互的元素），元素带 [ref=@快照编号:eN]，run 的命令用这个 ref 指定元素。给了 window_id 时按窗口读，app 不起作用。不改动界面。",
      {
        app: z.string().optional().describe("应用名（list-apps 里的 name，不是窗口标题）"),
        window_id: z.string().optional().describe("窗口 id（list-windows 里的 id）"),
        root: z.string().optional().describe("从这个 ref 往下读，不读整个窗口"),
        interactive_only: z.boolean().optional().describe("只列可交互的元素，默认 true"),
        skeleton: z.boolean().optional().describe("只读浅层结构，截断的容器带子元素数"),
        max_depth: z.number().int().min(1).max(50).optional().describe("最大深度，默认 10"),
        include_bounds: z.boolean().optional().describe("带上元素的位置和大小"),
        timeout_ms: z
          .number()
          .int()
          .min(500)
          .max(120_000)
          .optional()
          .describe(`读取期限（毫秒），默认 ${SNAPSHOT_TIMEOUT_MS}，读完就返回。Windows 上 Chromium、Electron 应用第一次读要 10–25 秒才完整`),
      },
      async (input, extra) => {
        const notice = othersSince(sessionId);
        if (!input.app && !input.window_id && !input.root) return error(prefixed(notice, needOne(["app", "window_id", "root"])));
        const args = [
          "snapshot",
          "--compact",
          ...(input.interactive_only !== false ? ["-i"] : []),
          ...(appUnlessWindow(input) ? ["--app", input.app!] : []),
          ...(input.window_id ? ["--window-id", input.window_id] : []),
          ...(input.root ? ["--root", input.root] : []),
          ...(input.skeleton ? ["--skeleton"] : []),
          ...(input.max_depth ? ["--max-depth", String(input.max_depth)] : []),
          ...(input.include_bounds ? ["--include-bounds"] : []),
          "--timeout-ms",
          String(input.timeout_ms ?? SNAPSHOT_TIMEOUT_MS),
        ];
        const denied = await checkTarget(sessionId, args);
        if (denied) return error(prefixed(notice, denied));
        note(args);
        const timeoutMs = (input.timeout_ms ?? SNAPSHOT_TIMEOUT_MS) + 30_000;
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
      "一个窗口（app 或 window_id）或一块屏幕（screen）的 PNG 图片。给了 app 或 window_id 时截窗口，screen 不起作用；给了 window_id 时 app 也不起作用。窗口被别的窗口挡住时不截。",
      {
        app: z.string().optional().describe("应用名（list-apps 里的 name，不是窗口标题）"),
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
          const app = appUnlessWindow(input);
          const args = [
            "screenshot",
            ...(app ? ["--app", app] : []),
            ...(input.window_id ? ["--window-id", input.window_id] : []),
            ...(screen !== undefined ? ["--screen", String(screen)] : []),
            file,
          ];
          const denied = await checkTarget(sessionId, args);
          if (denied) return error(prefixed(notice, denied));
          note(args);
          const result = await runCli(args, { session: sessionId, timeoutMs: 60_000, signal: signalOf(extra) });
          const failed = failure(result, 60_000);
          if (failed) return error(prefixed(notice, failed));
          if (!result.envelope!.ok) return error(prefixed(notice, formatError(result.envelope!.error!)));
          const png = await readFile(file);
          const geometry = await screenshotGeometry(png, { app, windowId: input.window_id, screen }).catch(() => null);
          if (png.length > MAX_IMAGE_BYTES) {
            return error(prefixed(notice, `截图有 ${(png.length / 1e6).toFixed(1)}MB，超过 ${(MAX_IMAGE_BYTES / 1e6).toFixed(2)}MB 的上限，没有返回图片`));
          }
          return {
            content: [
              ...(notice || geometry ? [{ type: "text" as const, text: [notice, geometry].filter(Boolean).join("\n\n") }] : []),
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
        if (args[0] !== "launch") note(args);
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
        if (args[0] === "launch" && delivered) note(args);
        const failed = failure(result, timeoutMs);
        if (failed) return done(failed, Boolean(result.killed) || !result.stdout.trim());
        const envelope = result.envelope!;
        if (!envelope.ok) return done(formatError(envelope.error!), true);
        registerRefsIn(sessionId, result.stdout, flagValues(args, "--app")[0]);
        return done(JSON.stringify(withoutAdvice(stripOwn(envelope.data)) ?? null), false);
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
