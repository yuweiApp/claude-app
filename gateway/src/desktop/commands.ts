/**
 * agent-desktop 的命令分类（1.2.0），见 docs/agent-desktop.md 第 4 节。
 * 升级 agent-desktop 时对一遍 `agent-desktop --help`：新命令默认按「有副作用」处理（走权限卡片）
 */

/**
 * agent-desktop 1.2.0 的全部命令（`agent-desktop --help` 的 Commands），run 的 command 参数只接受这些。
 * 拒绝的（DENIED_COMMANDS）也列着：模型照 skill 用到时拿到的是原因，不是「不在枚举里」
 */
export const AGENT_DESKTOP_COMMANDS = [
  "snapshot",
  "find",
  "screenshot",
  "get",
  "is",
  "click",
  "double-click",
  "triple-click",
  "right-click",
  "type",
  "set-value",
  "clear",
  "focus",
  "select",
  "toggle",
  "check",
  "uncheck",
  "expand",
  "collapse",
  "scroll",
  "scroll-to",
  "press",
  "key-down",
  "key-up",
  "hover",
  "drag",
  "mouse-move",
  "mouse-click",
  "mouse-down",
  "mouse-up",
  "mouse-wheel",
  "launch",
  "close-app",
  "list-windows",
  "list-displays",
  "list-apps",
  "focus-window",
  "resize-window",
  "move-window",
  "minimize",
  "maximize",
  "restore",
  "list-surfaces",
  "open-system-surface",
  "list-notifications",
  "dismiss-notification",
  "dismiss-all-notifications",
  "notification-action",
  "clipboard-get",
  "clipboard-set",
  "clipboard-clear",
  "wait",
  "status",
  "permissions",
  "version",
  "batch",
  "skills",
  "session",
  "cursor-overlay",
  "trace",
  "mcp",
  "help",
] as const;

/** 只读、没有副作用的命令：run 调用它们不弹权限卡片（Session.canUseTool），也不算「桌面写操作」（6.2） */
const READ_ONLY = new Set([
  "snapshot",
  "screenshot",
  "find",
  "get",
  "is",
  "list-apps",
  "list-windows",
  "list-displays",
  "list-surfaces",
  "list-notifications",
  "wait",
  "status",
  "version",
  "skills",
  "help",
]);

/** run 不执行的命令和原因（原因原样告诉模型，只说模型看得到的：run、工具名，不提网关） */
const DENIED_COMMANDS: Record<string, string> = {
  mcp: "run 不执行 mcp 命令",
  session: "快照命名空间是固定的（每个会话一个），run 不执行 session 命令",
  trace: "run 不执行 trace 命令",
  batch: "run 不执行 batch 命令",
};

/** run 不接受的参数：网关代管的全局参数、会写文件的、放行危险快捷键的（原因原样告诉模型，同上） */
const DENIED_FLAGS: Record<string, string> = {
  "--session": "--session 是固定设好的（每个会话一个快照命名空间），run 不接受",
  "--agent-id": "run 不接受 --agent-id",
  "--trace": "run 不接受 --trace",
  "--trace-strict": "run 不接受 --trace-strict",
  "--screenshot": "run 不接受 --screenshot（会写出含屏幕内容的文件）",
  "--debug": "run 不接受 --debug",
  "--force": "run 不接受 --force（它放行 alt+f4、win+l、cmd+q 这类快捷键和强制结束进程）",
  "--headed": "--headed 由 run 的 headed 参数设置",
  "--cdp": "run 不接受 --cdp",
  "--stdin": "run 不接受 --stdin（没有标准输入）",
};

/**
 * 不指定目标时作用于前台窗口的命令，和它们各自接受的目标参数（1.2.0 的 --help）：网关要求指定目标（前台窗口可能就是本应用）。
 * snapshot 读系统的界面（SYSTEM_SURFACES）时不属于哪个应用，不要求。
 * 拒绝时按命令列出能用的参数：以前一律写「--app、--window-id 或 ref」，模型给只认 --app 的 list-surfaces 加 --window-id，给 click 也加 --app
 */
const WINDOW_TARGETS = ["--app", "--window-id"];
export const NEEDS_TARGET: Record<string, string[]> = {
  snapshot: [...WINDOW_TARGETS, "--root"],
  screenshot: [...WINDOW_TARGETS, "--screen"],
  find: [...WINDOW_TARGETS, "--root"],
  press: WINDOW_TARGETS,
  "list-surfaces": ["--app"],
  "focus-window": WINDOW_TARGETS,
  "resize-window": WINDOW_TARGETS,
  "move-window": WINDOW_TARGETS,
  minimize: WINDOW_TARGETS,
  maximize: WINDOW_TARGETS,
  restore: WINDOW_TARGETS,
};

/** snapshot --surface 里系统的界面（Dock、通知中心等），不属于哪个应用；其余（window、focused、menu…）属于应用 */
export const SYSTEM_SURFACES = new Set([
  "desktop",
  "taskbar",
  "system-tray",
  "quick-settings",
  "notification-center",
  "dock",
  "spotlight",
  "menu-bar-extras",
  "system-tray-overflow",
  "start-menu",
  "action-center",
]);

/** 第一个位置参数是应用名的命令 */
export const APP_ARGUMENT = new Set(["launch", "close-app"]);

/**
 * 这次 run 只是看参数说明（--help / -h / help）：不碰任何窗口，跳过目标检查、不弹权限卡片。
 * 只认 -- 之前的：-- 之后的 --help 是普通参数值，命令照样执行
 */
export function isHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  return options.includes("--help") || options.includes("-h") || args[0] === "help";
}

/** 参数名（--foo=bar 取 --foo） */
const flagName = (arg: string) => (arg.startsWith("--") ? (arg.split("=")[0] ?? arg) : arg);

/** 这次 run 是不是只读的（不弹权限卡片、不算桌面写操作）：只读命令，或任何命令的 --help */
export function isReadOnly(args: string[]): boolean {
  if (args.length === 0) return false;
  if (isHelp(args)) return true;
  const command = args[0] ?? "";
  // permissions 不带 --request / --guide 只是读状态；带了会弹系统提示或打开系统设置
  if (command === "permissions") return !args.some((a) => ["--request", "--guide"].includes(flagName(a)));
  // skills 只是打印内置的说明
  return READ_ONLY.has(command);
}

/** 网关拒绝的原因，没问题返回 null */
export function deniedReason(args: string[]): string | null {
  const command = args[0] ?? "";
  if (!command || command.startsWith("-")) return "command 是命令名";
  if (DENIED_COMMANDS[command]) return DENIED_COMMANDS[command];
  for (const arg of args.slice(1)) {
    const reason = DENIED_FLAGS[flagName(arg)];
    if (reason) return reason;
  }
  return null;
}

/** 取参数的值：--name value 或 --name=value，可能出现多次 */
export function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const next = args[i + 1];
    if (arg === name && next !== undefined) {
      values.push(next);
      i++;
    } else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  }
  return values;
}

/** 参数里的 ref（@快照编号:eN），包括 --from=@… 这样写在参数值里的 */
export function refsIn(args: string[]): string[] {
  return args.flatMap((arg) => [...arg.matchAll(/@([A-Za-z0-9]+):e\d+/g)].map((m) => m[0]));
}

/** ref 里的快照编号 */
export const snapshotIdOf = (ref: string) => ref.slice(1, ref.indexOf(":"));

/** agent-desktop 等待类参数的默认时限（1.2.0 的 --help：wait 的 --timeout、--wait-for 的 --wait-timeout、launch 的 --timeout 都是 30000，snapshot 的 --timeout-ms 是 3000） */
const UPSTREAM_WAIT_DEFAULT_MS = 30_000;
const SNAPSHOT_TIMEOUT_DEFAULT_MS = 3_000;
/** 不带值的参数：它后面的数字是位置参数（wait 的 [MS]），不是它的值 */
const BOOLEAN_FLAGS = new Set(["--menu", "--menu-closed", "--notification", "-v", "--verbose", "--debug", "--trace-strict", "--headed"]);

const toMs = (v: string | undefined) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * 这条命令在 agent-desktop 里自己最多会等多久（毫秒），没有等待返回 0：
 * wait 的 [MS]（停多久）和 --timeout（等元素、窗口、文字的时限），launch 的 --timeout，snapshot 的 --timeout-ms（读取期限），
 * 任何命令带 --wait-for / --wait-for-gone 时的 --wait-timeout。
 * run 的进程期限至少比它长一点，agent-desktop 等满时限后自己的结果（TIMEOUT 等）才能返回，不被提前杀掉
 */
export function upstreamWaitMs(args: string[]): number {
  let ms = 0;
  const command = args[0];
  if (command === "wait") {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i] ?? "";
      const prev = args[i - 1] ?? "";
      const positional = i === 1 || !prev.startsWith("-") || prev.includes("=") || BOOLEAN_FLAGS.has(prev);
      if (/^\d+$/.test(arg) && positional) ms = Math.max(ms, Number(arg));
    }
  }
  if (command === "wait" || command === "launch") {
    ms = Math.max(ms, toMs(flagValues(args, "--timeout").at(-1)) ?? UPSTREAM_WAIT_DEFAULT_MS);
  }
  if (command === "snapshot") ms = Math.max(ms, toMs(flagValues(args, "--timeout-ms").at(-1)) ?? SNAPSHOT_TIMEOUT_DEFAULT_MS);
  if (args.some((a) => ["--wait-for", "-w", "--wait-for-gone"].includes(flagName(a)))) {
    ms = Math.max(ms, toMs(flagValues(args, "--wait-timeout").at(-1)) ?? UPSTREAM_WAIT_DEFAULT_MS);
  }
  return ms;
}

/** screenshot 带值的参数（1.2.0 的 --help），用来分出位置参数 [PATH] */
const SCREENSHOT_VALUE_FLAGS = new Set(["--app", "--window-id", "--screen", "--wait-for", "-w", "--wait-for-gone", "--wait-timeout", "--session", "--agent-id", "--trace", "--screenshot"]);

/** screenshot 的位置参数（[PATH]）；-- 之后的都算 */
export function screenshotPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      paths.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && SCREENSHOT_VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    paths.push(arg);
  }
  return paths;
}
