import { rmSync } from "node:fs";
import type { DesktopTarget } from "../shared/types.js";
import { APP_ARGUMENT, flagValues, isHelp, NEEDS_TARGET, pointsIn, refsIn, snapshotIdOf } from "./commands.js";
import { runCli, sessionStateDir } from "./cli.js";
import { desktopLog } from "./log.js";
import type { SnapshotData } from "./render.js";

/**
 * 桌面操作的拦截和记录，见 docs/agent-desktop.md 第 6、7 节：
 * - 本应用（桌面版）的窗口不能读、不能操作（6.1）：桌面版连上 /browser/host 时报自己的进程号（BrowserHost 调 setOwnPids）
 * - 桌面写操作进行中收到的权限回复不算数（6.2）：desktopWriteActive()
 * - 别的会话做过的桌面操作，下一次调用时告诉模型（7.2）：othersSince()
 * 另外记着每个会话正在操作的窗口，给网页右上角的浮窗：noteTarget()
 * 都在网关里，不经过权限系统，「完全访问权限」下照样生效
 */

// ---------- 本应用的进程 ----------

let ownPids = new Set<number>();

/** 桌面版的进程号（主进程和它的子进程）；桌面版断开时传空数组 */
export function setOwnPids(pids: number[]): void {
  ownPids = new Set(pids);
  desktopLog({ kind: "own-pids", pids });
}

const OWN_APP = "这是本应用（claude-app）的窗口，桌面工具不能读取或操作它";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowInfo {
  id: string;
  app_name?: string;
  pid?: number;
  title?: string;
  is_focused?: boolean;
  minimized?: boolean;
  visible?: boolean;
  bounds?: Bounds;
}

/**
 * 网关自己查的 list-windows 结果留 1 秒：一次截图要查三遍（guard、右上角浮窗、截图的坐标说明），Windows 上一遍 0.4 秒。
 * 桌面写操作（restore、close-app 等）开始和结束时清掉，免得拿着操作前的窗口状态
 */
const WINDOWS_TTL_MS = 1000;
let windowsCache: { at: number; promise: Promise<WindowInfo[]> } | null = null;

/** 所有窗口（含本应用的，给 guard、截图前的检查和截图的坐标说明用，不交给模型） */
export function listWindows(): Promise<WindowInfo[]> {
  if (windowsCache && Date.now() - windowsCache.at < WINDOWS_TTL_MS) return windowsCache.promise;
  const entry = {
    at: Date.now(),
    promise: runCli(["list-windows"], { timeoutMs: 10_000 }).then(({ envelope }) => {
      if (envelope?.ok && Array.isArray(envelope.data)) return envelope.data as WindowInfo[];
      if (windowsCache === entry) windowsCache = null;
      return [];
    }),
  };
  windowsCache = entry;
  return entry.promise;
}

/** 屏幕，顺序同 --screen 的序号 */
export async function listDisplays(): Promise<{ bounds?: Bounds; is_primary?: boolean; scale?: number }[]> {
  const { envelope } = await runCli(["list-displays"], { timeoutMs: 10_000 });
  return envelope?.ok && Array.isArray(envelope.data) ? (envelope.data as { bounds?: Bounds }[]) : [];
}

const contains = (b: Bounds, p: { x: number; y: number }) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;

async function listApps(): Promise<{ name: string; pid: number }[]> {
  const { envelope } = await runCli(["list-apps"], { timeoutMs: 10_000 });
  const apps = (envelope?.data as { apps?: { name: string; pid: number }[] } | undefined)?.apps;
  return envelope?.ok && Array.isArray(apps) ? apps : [];
}

/** list-apps、list-windows 等结果里去掉本应用的条目（带 pid 字段的对象） */
export function stripOwn(value: unknown, depth = 0): unknown {
  if (ownPids.size === 0 || depth > 4) return value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(item && typeof item === "object" && ownPids.has((item as { pid?: number }).pid ?? -1)))
      .map((item) => stripOwn(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripOwn(v, depth + 1)]));
  }
  return value;
}

// ---------- 快照登记（ref 从哪来、指向什么） ----------

interface SnapshotEntry {
  session: string;
  app?: string;
  windowId?: string;
  /** ref → 角色和名字（权限卡片上显示目标） */
  refs: Map<string, { role?: string; name?: string }>;
}

const snapshots = new Map<string, SnapshotEntry>();
const MAX_SNAPSHOTS = 500;

function remember(id: string, entry: SnapshotEntry): void {
  const old = snapshots.get(id);
  if (old) {
    for (const [ref, info] of entry.refs) old.refs.set(ref, info);
    old.app ??= entry.app;
    old.windowId ??= entry.windowId;
    return;
  }
  snapshots.set(id, entry);
  if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value as string);
}

/** snapshot 工具的结果：记下快照编号和里面每个 ref 的角色、名字 */
export function registerSnapshot(session: string, data: SnapshotData): void {
  if (!data.snapshot_id) return;
  const refs = new Map<string, { role?: string; name?: string }>();
  const walk = (node: NonNullable<SnapshotData["tree"]>) => {
    if (node.ref_id) refs.set(node.ref_id, { role: node.role, name: node.name?.trim() || undefined });
    node.children?.forEach(walk);
  };
  if (data.tree) walk(data.tree);
  remember(data.snapshot_id, { session, app: data.app, windowId: data.window?.id, refs });
}

/** run 的结果里出现的 ref（find 等）：记下它们的快照编号属于这个会话 */
export function registerRefsIn(session: string, output: string, app?: string): void {
  for (const m of output.matchAll(/@[A-Za-z0-9]+:e\d+/g)) remember(snapshotIdOf(m[0]), { session, app, refs: new Map() });
}

/** 权限卡片上的目标描述：「mousepad 里的 menuitem「Save」」 */
export function describeRefs(args: string[]): string[] {
  return refsIn(args).map((ref) => {
    const entry = snapshots.get(snapshotIdOf(ref));
    const info = entry?.refs.get(ref);
    const what = info ? `${info.role ?? "元素"}${info.name ? `「${info.name}」` : ""}` : "元素";
    return `${ref}：${entry?.app ?? "未知应用"} 里的 ${what}`;
  });
}

// ---------- 检查 ----------

/**
 * 执行前检查参数指向的目标，不行返回原因。args 是 agent-desktop 的参数（命令在第一个）。
 * - ref 必须是这个会话经 snapshot / find 拿到的（本应用的窗口拍不了快照，所以也拿不到它的 ref）
 * - --window-id、--app、launch / close-app 的应用名不能是本应用
 * - 坐标不能落在本应用的任何一个窗口里（不看叠放次序）
 * - 不带目标时作用于前台窗口的命令，要求带 --app / --window-id / ref
 */
export async function checkTarget(session: string, args: string[]): Promise<string | null> {
  // 日志里记下判断用到的东西：本应用的进程号、--window-id 在 list-windows 里对应的窗口、--app 在 list-apps 里同名的进程
  const context: Record<string, unknown> = {};
  const denied = await decide(session, args, context);
  desktopLog({ kind: "guard", session, args, ownPids: [...ownPids], ...context, ...(denied ? { denied } : { allowed: true }) });
  return denied;
}

async function decide(session: string, args: string[], context: Record<string, unknown>): Promise<string | null> {
  const command = args[0] ?? "";
  // 只是看参数说明，不作用于任何窗口
  if (isHelp(args)) return null;
  const refs = refsIn(args);
  for (const ref of refs) {
    const entry = snapshots.get(snapshotIdOf(ref));
    if (!entry || entry.session !== session) return `${ref} 不是这个会话经 snapshot 或 find 拿到的 ref（网关重启后，之前的 ref 也不再认）`;
  }
  const windowIds = flagValues(args, "--window-id");
  const appArg = APP_ARGUMENT.has(command) && args[1] && !args[1].startsWith("-") ? [args[1]] : [];
  const apps = [...flagValues(args, "--app"), ...appArg];
  const targets = NEEDS_TARGET[command];
  if (targets && refs.length === 0 && windowIds.length === 0 && apps.length === 0) {
    return `${command} 不指定目标时作用于前台窗口，网关要求指定目标；${command} 接受的目标参数：${targets.join("、")}`;
  }
  if (ownPids.size === 0) return null;

  const points = pointsIn(args);
  if (windowIds.length || points.length) {
    const windows = await listWindows();
    context.windows = windowIds.map((id) => windows.find((w) => w.id === id) ?? { id, found: false });
    for (const id of windowIds) {
      if (ownPids.has(windows.find((w) => w.id === id)?.pid ?? -1)) return OWN_APP;
    }
    const own = windows.filter((w) => ownPids.has(w.pid ?? -1) && w.bounds);
    // 前台窗口在最上面：它不是本应用、又盖住了这个坐标时，点击落在它上面（实测紫鸟挪到主屏后盖住了 Claude App，
    // 以前不看叠放次序，点紫鸟也被拦）。前台是本应用、或前台窗口没盖住这个坐标时，下面可能是本应用，照样拦
    const front = windows.find((w) => w.is_focused && w.bounds && !ownPids.has(w.pid ?? -1));
    for (const p of points) {
      if (own.some((w) => contains(w.bounds!, p)) && !(front && contains(front.bounds!, p))) {
        return `坐标 ${p.x},${p.y} 落在本应用（claude-app）的窗口范围里，而前台窗口不是盖住这个坐标的其他窗口，桌面工具不能点这里`;
      }
    }
  }
  if (apps.length) {
    const running = await listApps();
    context.apps = running.filter((a) => apps.some((name) => name.toLowerCase() === a.name.toLowerCase()));
    const ownNames = new Set(running.filter((a) => ownPids.has(a.pid)).map((a) => a.name.toLowerCase()));
    const app = apps.find((a) => ownNames.has(a.toLowerCase()));
    if (app) {
      // 应用名和本应用相同的其他进程（实测 Windows 上开发模式的 Electron 应用都叫 electron.exe）：拦下的不一定是本应用的窗口，照实说
      const others = running.filter((a) => !ownPids.has(a.pid) && a.name.toLowerCase() === app.toLowerCase()).map((a) => a.pid);
      if (others.length === 0) return OWN_APP;
      return `网关不接受 ${app} 这个应用名：本应用（claude-app）的进程也叫 ${app}，按应用名分不出是不是本应用（同名的其他进程：pid ${others.join("、")}）。只按窗口 id 指定（run 的 --window-id、snapshot / screenshot 的 window_id）、不给应用名时，按窗口所属的进程判断`;
    }
  }
  return null;
}

// ---------- 桌面写操作进行中（6.2） ----------

let writesInFlight = 0;
let lastWriteEnd = 0;
/** 写操作结束后多久内收到的权限回复也不算数：无障碍点击到网页发出请求有延迟 */
const WRITE_GRACE_MS = 1000;

/** 开始一次桌面写操作，返回结束时调用的函数 */
export function beginWrite(): () => void {
  writesInFlight++;
  windowsCache = null;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    writesInFlight--;
    lastWriteEnd = Date.now();
    windowsCache = null;
  };
}

/** 现在收到的权限回复是不是可能来自桌面操作（有写操作在执行，或刚结束不到 1 秒） */
export function desktopWriteActive(): boolean {
  return writesInFlight > 0 || Date.now() - lastWriteEnd < WRITE_GRACE_MS;
}

// ---------- 别的会话的操作（7.2） ----------

interface Operation {
  seq: number;
  session: string;
  label: string;
}

const operations: Operation[] = [];
const MAX_OPERATIONS = 100;
let lastSeq = 0;
const seen = new Map<string, number>();

/** 记下一次桌面写操作：「click（mousepad）」 */
export function recordOperation(session: string, args: string[]): void {
  const command = args[0] ?? "";
  const apps = new Set([
    ...flagValues(args, "--app"),
    ...(APP_ARGUMENT.has(command) && args[1] ? [args[1]] : []),
    ...refsIn(args).map((ref) => snapshots.get(snapshotIdOf(ref))?.app ?? ""),
  ]);
  apps.delete("");
  operations.push({ seq: ++lastSeq, session, label: apps.size ? `${command}（${[...apps].join("、")}）` : command });
  if (operations.length > MAX_OPERATIONS) operations.shift();
}

/** 这个会话上次调用桌面工具以来，别的会话做过的写操作；第一次调用不说以前的 */
export function othersSince(session: string): string | null {
  const since = seen.get(session);
  seen.set(session, lastSeq);
  if (since === undefined) return null;
  const others = operations.filter((op) => op.seq > since && op.session !== session).map((op) => op.label);
  return others.length ? `（自你上次调用桌面工具以来，别的会话执行过：${others.join("、")}）` : null;
}

// ---------- 正在操作的窗口（网页右上角的浮窗） ----------

/** 每个会话上次报出去的目标（JSON），没变不再报 */
const reported = new Map<string, string>();

/**
 * 这次调用作用于哪个窗口，变了就调 report：目标来自 --window-id、--app、launch / close-app 的应用名、
 * ref 所属快照的应用和窗口。只给应用名时在 list-windows 里按应用名找，前台的优先，其次没最小化的。
 * 找不到窗口（应用还没开出窗口）时只报应用名；close-app 报 null。没有目标的命令（list-apps 等）不报
 */
export async function noteTarget(session: string, args: string[], report: (target: DesktopTarget | null) => void): Promise<void> {
  const command = args[0] ?? "";
  if (isHelp(args)) return;
  const send = (target: DesktopTarget | null) => {
    const key = JSON.stringify(target);
    if (reported.get(session) === key) return;
    reported.set(session, key);
    report(target);
  };
  if (command === "close-app") return send(null);
  let windowId = flagValues(args, "--window-id")[0];
  let app = flagValues(args, "--app")[0] ?? (APP_ARGUMENT.has(command) && args[1] && !args[1].startsWith("-") ? args[1] : undefined);
  for (const ref of refsIn(args)) {
    const entry = snapshots.get(snapshotIdOf(ref));
    windowId ??= entry?.windowId;
    app ??= entry?.app;
  }
  if (!windowId && !app) return;
  const windows = (await listWindows()).filter((w) => !ownPids.has(w.pid ?? -1));
  let win: WindowInfo | undefined;
  if (windowId) win = windows.find((w) => w.id === windowId);
  if (!win && app) {
    const same = windows.filter((w) => w.app_name?.toLowerCase() === app!.toLowerCase());
    win = same.find((w) => w.is_focused) ?? same.find((w) => !w.minimized && w.visible !== false) ?? same[0];
  }
  const name = win?.app_name ?? app;
  if (!name) return;
  send({
    app: name,
    ...(win ? { windowId: win.id, title: win.title || undefined, pid: win.pid, ...(win.minimized ? { minimized: true } : {}) } : {}),
  });
}

// ---------- 删会话 ----------

export function disposeDesktopSession(session: string): void {
  for (const [id, entry] of snapshots) if (entry.session === session) snapshots.delete(id);
  seen.delete(session);
  reported.delete(session);
  try {
    rmSync(sessionStateDir(session), { recursive: true, force: true });
  } catch {
    // 目录不在（没用过桌面工具）
  }
}
