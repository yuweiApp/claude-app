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

/** 网关不执行的命令和原因（原因原样告诉模型） */
const DENIED_COMMANDS: Record<string, string> = {
  snapshot: "snapshot 由 mcp__desktop__snapshot 工具执行，run 不执行它",
  screenshot: "screenshot 由 mcp__desktop__screenshot 工具执行，run 不执行它",
  mcp: "网关不执行 mcp 命令",
  session: "快照命名空间由网关管理（每个会话一个），run 不执行 session 命令",
  trace: "网关不执行 trace 命令",
  batch: "网关不执行 batch 命令",
};

/** 网关不接受的参数：受管的全局参数、会写文件的、放行危险快捷键的 */
const DENIED_FLAGS: Record<string, string> = {
  "--session": "--session 由网关设置（每个会话一个快照命名空间）",
  "--agent-id": "--agent-id 由网关管理",
  "--trace": "网关不接受 --trace",
  "--trace-strict": "网关不接受 --trace-strict",
  "--screenshot": "网关不接受 --screenshot（会写出含屏幕内容的文件）",
  "--debug": "网关不接受 --debug",
  "--force": "网关不接受 --force（它放行 alt+f4、win+l、cmd+q 这类快捷键和强制结束进程）",
  "--headed": "--headed 由 run 的 headed 参数设置",
  "--cdp": "网关不接受 --cdp",
  "--stdin": "网关不接受 --stdin（没有标准输入）",
};

/** 不带 --app / --window-id / ref 时作用于前台窗口的命令：网关要求指定目标（前台窗口可能就是本应用） */
export const NEEDS_TARGET = new Set(["find", "press", "list-surfaces", "focus-window", "resize-window", "move-window", "minimize", "maximize", "restore"]);

/** 第一个位置参数是应用名的命令 */
export const APP_ARGUMENT = new Set(["launch", "close-app"]);

const isHelp = (args: string[]) => args.includes("--help") || args.includes("-h") || args[0] === "help";

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
