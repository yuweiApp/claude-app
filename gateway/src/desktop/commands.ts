/**
 * agent-desktop 的命令分类（1.2.0），见 docs/agent-desktop.md 第 4 节。
 * 升级 agent-desktop 时对一遍 `agent-desktop --help`：新命令默认按「有副作用」处理（走权限卡片）
 */

/** 只读、没有副作用的命令：run 调用它们不弹权限卡片（Session.canUseTool），也不算「桌面写操作」（6.2） */
const READ_ONLY = new Set([
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
]);

/** run 不执行的命令和原因（原因原样告诉模型，只说模型看得到的：run、工具名，不提网关） */
const DENIED_COMMANDS: Record<string, string> = {
  snapshot: "snapshot 由 mcp__desktop__snapshot 工具执行，run 不执行它",
  screenshot: "screenshot 由 mcp__desktop__screenshot 工具执行，run 不执行它",
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
 * 拒绝时按命令列出能用的参数：以前一律写「--app、--window-id 或 ref」，模型给只认 --app 的 list-surfaces 加 --window-id，给 click 也加 --app
 */
const WINDOW_TARGETS = ["--app", "--window-id"];
export const NEEDS_TARGET: Record<string, string[]> = {
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
  if (!command || command.startsWith("-")) return "args 的第一项是命令名";
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

/** 参数里的坐标：--xy / --from-xy / --to-xy 是 "x,y"，mouse-wheel 是 --x、--y */
export function pointsIn(args: string[]): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (const name of ["--xy", "--from-xy", "--to-xy"]) {
    for (const value of flagValues(args, name)) {
      const [x = NaN, y = NaN] = value.split(",").map(Number);
      points.push({ x, y });
    }
  }
  const xs = flagValues(args, "--x");
  const ys = flagValues(args, "--y");
  if (xs.length || ys.length) points.push({ x: Number(xs[0]), y: Number(ys[0]) });
  return points;
}

/** agent-desktop 等待类参数的默认时限（1.2.0 的 --help：wait 的 --timeout、--wait-for 的 --wait-timeout 都是 30000） */
const UPSTREAM_WAIT_DEFAULT_MS = 30_000;
/** 不带值的参数：它后面的数字是位置参数（wait 的 [MS]），不是它的值 */
const BOOLEAN_FLAGS = new Set(["--menu", "--menu-closed", "--notification", "-v", "--verbose", "--debug", "--trace-strict", "--headed"]);

const toMs = (v: string | undefined) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * 这条命令在 agent-desktop 里自己最多会等多久（毫秒），没有等待返回 0：
 * wait 的 [MS]（停多久）和 --timeout（等元素、窗口、文字的时限，默认 30000），任何命令带 --wait-for / --wait-for-gone 时的 --wait-timeout（默认 30000）。
 * run 的进程期限至少比它长一点，agent-desktop 等满时限后自己的结果（TIMEOUT 等）才能返回，不被提前杀掉
 */
export function upstreamWaitMs(args: string[]): number {
  let ms = 0;
  if (args[0] === "wait") {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i] ?? "";
      const prev = args[i - 1] ?? "";
      const positional = i === 1 || !prev.startsWith("-") || prev.includes("=") || BOOLEAN_FLAGS.has(prev);
      if (/^\d+$/.test(arg) && positional) ms = Math.max(ms, Number(arg));
    }
    ms = Math.max(ms, toMs(flagValues(args, "--timeout").at(-1)) ?? UPSTREAM_WAIT_DEFAULT_MS);
  }
  if (args.some((a) => ["--wait-for", "-w", "--wait-for-gone"].includes(flagName(a)))) {
    ms = Math.max(ms, toMs(flagValues(args, "--wait-timeout").at(-1)) ?? UPSTREAM_WAIT_DEFAULT_MS);
  }
  return ms;
}

/**
 * agent-desktop 的参数解析错误（参数名不认识、缺值、缺必填参数）：INVALID_ARGS，message 是命令行解析器的原话，以 "error: " 开头。
 * 命令名本身不认识时 command 是 unknown，没有这条命令的 --help 可附
 */
export function isParseError(err: { code: string; message: string }, command: string): boolean {
  return err.code === "INVALID_ARGS" && err.message.startsWith("error: ") && command !== "unknown";
}

/**
 * 附在参数错误后面的 --help：去掉 run 不接受的参数那几行（DENIED_FLAGS），Usage 里的可执行文件名（按平台不同）统一写成 agent-desktop
 */
export function helpForRun(help: string): string {
  return help
    .split(/\r?\n/)
    .filter((line) => {
      const m = /^\s+(?:-\w, )?(--[\w-]+)/.exec(line);
      return !(m && m[1] && DENIED_FLAGS[m[1]]);
    })
    .map((line) => line.replace(/^Usage: \S+/, "Usage: agent-desktop"))
    .join("\n")
    .trim();
}
