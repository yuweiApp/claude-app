import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import sharp from "sharp";
import { z } from "zod";
import { MCP_AUTO_BACKGROUND_MS } from "../config.js";
import { ALWAYS_LOAD_META, isAlwaysLoad } from "../config-file.js";
import { rememberResult } from "../browser/tool.js";
import { runCli, type CliResult, type Envelope } from "./cli.js";
import { AGENT_DESKTOP_COMMANDS, deniedReason, isHelp, isReadOnly, screenshotPaths, upstreamWaitMs } from "./commands.js";
import type { DesktopTarget } from "../shared/types.js";
import { beginWrite, checkTarget, disposeDesktopState, noteTarget, observeResult, othersSince, recordOperation, stripOwn } from "./guard.js";
import { DesktopRepl } from "./repl.js";

/**
 * 桌面操作：经 agent-desktop（https://github.com/vercel-labs/agent-desktop）读系统的无障碍树、操作网关所在电脑上的原生应用。
 * 只有一个工具 run_code：一段 JavaScript，里面用 desktop(command, args) 执行命令，命令和参数原样交给 agent-desktop 的命令行
 * （每条一个进程），返回它的 JSON（同 browser_run_code）。网关只管快照命名空间、截图、超时和本应用窗口的拦截，见 docs/agent-desktop.md。
 * 不弹权限卡片。MCP 服务器名 desktop，工具全名 mcp__desktop__run_code
 */
export const DESKTOP_SERVER = "desktop";
const full = (name: string) => `mcp__${DESKTOP_SERVER}__${name}`;
/** 桌面工具不用确认（options.allowedTools） */
export const DESKTOP_TOOLS = [full("run_code")];

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** 命令自己要等（wait 的 --timeout、snapshot 的 --timeout-ms 等，见 upstreamWaitMs）时，进程期限至少比它多这么久 */
const WAIT_MARGIN_MS = 5_000;
/** 返回给模型的图片大小上限：模型接口的单张图片上限是 base64 后 5MB */
const MAX_IMAGE_BYTES = 3_750_000;
/** 缩小后仍超过上限时改成 JPEG 的质量 */
const JPEG_QUALITY = 80;
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
 * 给模型的说明。例外于 CLAUDE.md 的「只写事实」：让模型先读 agent-desktop 自带的 skill（编进二进制、和版本对应，里面是做法和步骤）并照着做，
 * 和上游 README 给 agent 的那句一样；其余只写事实
 */
const INSTRUCTIONS = [
  `桌面：运行你（Claude Code）的这台电脑（${PLATFORM}）上、当前登录用户的桌面（原生应用的窗口、菜单、对话框），经系统的无障碍接口（${ACCESSIBILITY_API}）读取和操作，工具是 agent-desktop ${version}。用户可能同时在用这台电脑。`,
  '- 桌面工具只有 run_code：在这个会话常驻的 JavaScript 环境（Node 的 vm）里执行代码，代码里用 `await desktop(command, args?, { headed?, timeout_ms? })` 执行 agent-desktop 命令，一次调用里可以执行多条。',
  '- 第一次使用前，先执行 skills get desktop 和 skills get platform（desktop("skills", ["get", "desktop"])、desktop("skills", ["get", "platform"])），读 agent-desktop 自带的使用说明（和这个版本对应），按里面的做法操作；说明里提到的参考文档用 desktop("skills", ["get", "desktop", "<文件名>"]) 读。',
  "- 使用说明里的命令行 `agent-desktop <命令> <参数…>` 在这里是 desktop() 的 command 和 args：args 是字符串数组，直接交给程序，不经过 shell（说明里 PowerShell、POSIX shell 的引号转义用不上）；全局参数 --headed 用第三个参数的 headed 给。这里没有 agent-desktop 命令行，Bash 里也没有。",
  "- desktop() 返回 agent-desktop 输出的 JSON 解析成的对象（ok、data 或 error；ok 为 false 时也是返回，不抛错）；args 为 [\"--help\"] 时返回这条命令的参数说明（文字）；被拒绝、超时被终止、调用被中断时抛错。",
  "- screenshot 返回的 data 里多一个 image（图片的 Buffer），图片不会自动给你，`emitImage(buffer, \"image/png\" 或 \"image/jpeg\")` 把它加进这次调用的结果。",
  "- run_code 支持顶层 await；顶层的 const、let、function 在之后的调用里还在。最后一个表达式的值作为结果（字符串原样，其他按 util.inspect 显示，嵌套超过 3 层的显示成 [Object]），console.log 的输出也在结果里，超过 40000 字符只留开头。有 setTimeout、fetch、Buffer、URL 等，没有 require、import、process。代码连续同步执行超过 2 秒（中间没有 await）会被中止。到 run_code 的 timeout_ms 先返回，代码可能还在跑；调用被中断时正在执行的命令被终止，之后的 desktop() 抛错。",
  "- 这台电脑的用户已允许桌面工具使用 headed（真实的鼠标键盘输入），headed 的调用不需要另外确认。",
  "- 元素的 bounds（find 的结果、snapshot 的 --include-bounds）和坐标命令（mouse-click --xy 等）用的是同一套桌面坐标。",
  "- 每个会话有一个固定的快照命名空间（--session 已经设好）。desktop() 不执行 mcp、session、trace、batch，不接受参数 --session、--agent-id、--trace、--trace-strict、--screenshot、--debug、--force、--stdin、--cdp、--headed（用 headed 给）。",
  `- screenshot 不接受 [PATH]，图片随结果返回。图片缩小到桌面坐标的尺寸（屏幕缩放大于 100%、桌面坐标按点算时按缩放缩小），图片的 1 个像素对应 1 个桌面坐标单位；仍超过 ${(MAX_IMAGE_BYTES / 1e6).toFixed(2)}MB 时改成 JPEG，再超过就继续缩小。data 里的 width、height 是返回的图片的尺寸，original_width、original_height 是原图的，format 是 png 或 jpeg。`,
  // agent-desktop 1.2.0 的已知问题（上游 issue #548，修复 PR #394、#594 未合并，macOS 上实测）：窗口列表只收 layer 0 的窗口，
  // 无障碍接口报的前台窗口是 layer 不为 0 的模态对话框时对不上，一直重试到超时。实测 Fotor（Qt）的介绍页，见 docs/agent-desktop.md 第 13 节
  "- agent-desktop 这个版本的已知问题：应用弹出窗口层级不是 0 的模态对话框时，对话框不在窗口列表里，和系统报的前台窗口对不上。这期间读全局窗口列表的命令（不带 --app 的 list-windows、按 --window-id 的 snapshot 等、screenshot）一直重试到超时，返回 TIMEOUT，details.kind 为 global_window_inventory_unstable、last_kind 为 frontmost_window_join（结果里的 suggestion 说应用可能忙或没有响应，这个错误出现时应用不一定没有响应）；对话框关掉后恢复。list-windows --app <应用名> 和 snapshot --app <应用名> --surface focused 不受影响，后者读到的就是这个对话框，里面的 ref 可以操作。",
  "- 本应用（claude-app）自己的窗口：list-apps、list-windows 的结果里没有它；--app 是本应用、--window-id 是本应用的窗口时不执行。ref 只认这个会话经 desktop() 拿到的。",
  `- desktop() 一条命令的进程期限 timeout_ms 默认 ${DEFAULT_TIMEOUT_MS}、最大 ${MAX_TIMEOUT_MS}；命令自己的等待时限（wait 的 [MS] 和 --timeout，launch 的 --timeout，snapshot 的 --timeout-ms，--wait-for 的 --wait-timeout）加 ${WAIT_MARGIN_MS / 1000} 秒超过 timeout_ms 时，按前者计（同样不超过 ${MAX_TIMEOUT_MS}）。`,
  `- 调用超过约 ${BACKGROUND_SECONDS} 秒会转为后台任务：先返回一条「在后台运行」的结果，结束后结果作为通知送达。屏幕上的变化不会通知你。`,
  "- 别的会话也可能在操作这个桌面：自你上次调用以来它们执行过的操作，列在下一次结果的开头。",
  '- 用户消息里的 @桌面 指这个桌面，@desktop[标题](window:<id> "应用名") 指这里的一个窗口：<id> 是用户引用时 list-windows 里它的窗口 id，引号里是它的 app_name（没有应用名时不带引号这部分）。',
].join("\n");

const prefixed = (notice: string | null, body: string) => (notice ? `${notice}\n\n${body}` : body);

/** 没有拿到 agent-desktop 的 JSON 结果时的说明（被终止、输出不是 JSON），有 JSON 结果返回 null */
function failure(result: CliResult, timeoutMs: number): string | null {
  if (result.killed === "timeout") return `命令运行超过 ${timeoutMs} 毫秒被终止，动作可能已经生效`;
  if (result.killed === "abort") return "调用被中断，命令被终止，动作可能已经生效";
  if (result.envelope) return null;
  return result.stdout.trim() || `agent-desktop 没有输出结果${result.stderr.trim() ? `：${result.stderr.trim().slice(0, 2000)}` : ""}`;
}

/** 原样的 envelope，去掉本应用的条目（list-apps、list-windows 里的、错误 details 里的） */
function cleanEnvelope(envelope: Envelope): Envelope {
  const { data, error } = envelope;
  return {
    ...envelope,
    ...(data !== undefined ? { data: stripOwn(data) } : {}),
    ...(error ? { error: { ...error, ...(error.details !== undefined ? { details: stripOwn(error.details) } : {}) } } : {}),
  };
}

const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal;

type Size = { width: number; height: number };
type ScreenshotImage = { data: Buffer; mimeType: "image/png" | "image/jpeg"; size: Size; original: Size };

/**
 * 截图转成返回给模型的图片。macOS 的桌面坐标是点，Retina 屏截出来是 2 倍像素（实测 iMac 上全屏窗口 4616×2398、6.5MB，超过上限），
 * 按 agent-desktop 报的 scale_factor 缩回点的尺寸，图片像素和桌面坐标一一对应；Windows 的桌面坐标本来就是像素（第 13 节实测），不按缩放缩小。
 * 之后还超过上限就改成 JPEG，再超过就每次缩到 3/4
 */
async function screenshotImage(png: Buffer, scaleFactor: number | undefined): Promise<ScreenshotImage> {
  const meta = await sharp(png).metadata();
  const original = { width: meta.width, height: meta.height };
  const scale = process.platform === "darwin" && scaleFactor && scaleFactor > 1 ? scaleFactor : 1;
  let size = scale > 1 ? { width: Math.round(original.width / scale), height: Math.round(original.height / scale) } : original;
  const resized = (s: Size) => (s.width === original.width ? sharp(png) : sharp(png).resize(s.width, s.height, { fit: "fill" }));
  let data = scale > 1 ? await resized(size).png().toBuffer() : png;
  if (data.length <= MAX_IMAGE_BYTES) return { data, mimeType: "image/png", size, original };
  for (;;) {
    data = await resized(size).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    if (data.length <= MAX_IMAGE_BYTES || size.width < 200) return { data, mimeType: "image/jpeg", size, original };
    size = { width: Math.round(size.width * 0.75), height: Math.round(size.height * 0.75) };
  }
}

/** 一条命令的结果：envelope 是去掉本应用条目后的 agent-desktop 结果；没有 envelope 时 text 是被拦下、超时等的说明或 --help 的文字 */
interface Exec {
  envelope?: Envelope;
  text: string;
  isError: boolean;
  image?: ScreenshotImage;
}

/**
 * 执行一条命令（run_code 里的 desktop()）：拦截检查、桌面写操作的记录（6.2、7.2）、浮窗、超时，
 * screenshot 由网关给临时路径、读出图片缩小
 */
async function execute(
  sessionId: string,
  argv: string[],
  opts: { headed?: boolean; timeoutMs?: number; signal?: AbortSignal },
  note: (argv: string[], data?: unknown) => void,
): Promise<Exec> {
  const command = argv[0] ?? "";
  const screenshot = command === "screenshot" && !isHelp(argv);
  const denied =
    deniedReason(argv) ??
    (command && !(AGENT_DESKTOP_COMMANDS as readonly string[]).includes(command) ? `agent-desktop 没有 ${command} 这条命令` : null) ??
    (screenshot && screenshotPaths(argv).length ? "screenshot 不接受 [PATH]：图片随结果返回，参数里不要给路径" : null) ??
    (await checkTarget(sessionId, argv));
  if (denied) return { text: denied, isError: true };
  const readOnly = isReadOnly(argv);
  if (command !== "launch") note(argv);
  const dir = screenshot ? await mkdtemp(path.join(os.tmpdir(), "claude-app-desktop-")) : null;
  const file = dir ? path.join(dir, "screenshot.png") : null;
  try {
    const endWrite = readOnly ? null : beginWrite();
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, upstreamWaitMs(argv) + WAIT_MARGIN_MS));
    let result: CliResult;
    try {
      result = await runCli(file ? [...argv, file] : argv, { session: sessionId, headed: opts.headed, timeoutMs, signal: opts.signal });
    } finally {
      endWrite?.();
    }
    const delivered = result.envelope?.ok || (result.envelope?.error?.disposition?.delivery ?? "unknown") !== "not_delivered";
    if (!readOnly && delivered) recordOperation(sessionId, argv);
    const failed = failure(result, timeoutMs);
    if (failed) {
      if (command === "launch" && delivered) note(argv);
      return { text: failed, isError: Boolean(result.killed) || !result.stdout.trim() };
    }
    const raw = result.envelope!;
    if (!raw.ok) {
      const envelope = cleanEnvelope(raw);
      return { envelope, text: JSON.stringify(envelope), isError: true };
    }
    observeResult(sessionId, argv, raw.data, result.stdout);
    note(argv, raw.data);
    if (!file) {
      const envelope = cleanEnvelope(raw);
      return { envelope, text: JSON.stringify(envelope), isError: false };
    }
    // 截图：data 里的路径是临时文件（马上删掉）不给，尺寸换成返回的图片的
    const { path: _path, ...rest } = (raw.data && typeof raw.data === "object" ? raw.data : {}) as Record<string, unknown>;
    const scaleFactor = typeof rest.scale_factor === "number" ? rest.scale_factor : undefined;
    const image = await screenshotImage(await readFile(file), scaleFactor);
    const envelope = cleanEnvelope({
      ...raw,
      data: {
        ...rest,
        width: image.size.width,
        height: image.size.height,
        original_width: image.original.width,
        original_height: image.original.height,
        format: image.mimeType === "image/jpeg" ? "jpeg" : "png",
      },
    });
    return { envelope, text: JSON.stringify(envelope), isError: false, image };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** 每个会话一个 run_code 的 REPL，删会话时删掉 */
const repls = new Map<string, DesktopRepl>();

/**
 * onTarget：调用作用的窗口变了（网页右上角的浮窗显示它）。调用一开始按参数报一次，结束后按结果再报一次（launch 只在结束后报，之前还没有窗口）
 */
export function desktopServer(sessionId: string, onTarget?: (target: DesktopTarget | null) => void): McpSdkServerConfigWithInstance {
  const note = (argv: string[], data?: unknown) => {
    if (onTarget) noteTarget(sessionId, argv, data, onTarget);
  };
  const replFor = () => {
    let repl = repls.get(sessionId);
    if (!repl) {
      repl = new DesktopRepl(async (command, args, opts) => {
        const result = await execute(sessionId, [command, ...args], opts, note);
        if (!result.envelope) {
          if (result.isError) throw new Error(result.text);
          return result.text;
        }
        if (!result.image) return result.envelope;
        // 截图：图片放进 data.image（Buffer），emitImage 交给模型
        return { ...result.envelope, data: { ...(result.envelope.data as object), image: result.image.data } };
      });
      repls.set(sessionId, repl);
    }
    return repl;
  };

  const runCode = tool(
    "run_code",
    `在一个常驻的 JavaScript 环境里执行代码（顶层 await；顶层的变量、函数在之后的调用里还在），代码里用 desktop() 执行 agent-desktop 命令。最后一个表达式的值、console 的输出作为结果。timeout_ms 默认 ${DEFAULT_TIMEOUT_MS}、最大 ${MAX_TIMEOUT_MS}。`,
    {
      code: z.string().describe("JavaScript 代码"),
      timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe(`最多等多久（毫秒），默认 ${DEFAULT_TIMEOUT_MS}；到了先返回，代码可能还在跑`),
    },
    async ({ code, timeout_ms }, extra) => {
      const notice = othersSince(sessionId);
      const result = await replFor().run(code, timeout_ms ?? DEFAULT_TIMEOUT_MS, signalOf(extra));
      const out = prefixed(notice, result.text);
      rememberResult(extra, out, result.isError);
      return {
        content: [{ type: "text" as const, text: out }, ...result.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))],
        ...(result.isError ? { isError: true } : {}),
      };
    },
    { annotations: { title: "Desktop script", readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  );

  return createSdkMcpServer({
    name: DESKTOP_SERVER,
    version: "1.0.0",
    instructions: INSTRUCTIONS,
    tools: [runCode].map((t) => (isAlwaysLoad(full(t.name)) ? { ...t, _meta: { ...t._meta, [ALWAYS_LOAD_META]: true } } : t)),
  });
}

/** 删会话：run_code 的 REPL、快照命名空间和网关记下的 ref */
export function disposeDesktopSession(sessionId: string): void {
  repls.get(sessionId)?.dispose();
  repls.delete(sessionId);
  disposeDesktopState(sessionId);
}
