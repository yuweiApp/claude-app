import { rmSync } from "node:fs";
import { APP_ARGUMENT, flagValues, isHelp, NEEDS_TARGET, pointsIn, refsIn, snapshotIdOf } from "./commands.js";
import { runCli, sessionStateDir } from "./cli.js";
import type { SnapshotData } from "./render.js";

/**
 * 桌面操作的拦截和记录，见 docs/agent-desktop.md 第 6、7 节：
 * - 本应用（桌面版）的窗口不能读、不能操作（6.1）：桌面版连上 /browser/host 时报自己的进程号（BrowserHost 调 setOwnPids）
 * - 桌面写操作进行中收到的权限回复不算数（6.2）：desktopWriteActive()
 * - 别的会话做过的桌面操作，下一次调用时告诉模型（7.2）：othersSince()
 * 都在网关里，不经过权限系统，「完全访问权限」下照样生效
 */

// ---------- 本应用的进程 ----------

let ownPids = new Set<number>();

/** 桌面版的进程号（主进程和它的子进程）；桌面版断开时传空数组 */
export function setOwnPids(pids: number[]): void {
  ownPids = new Set(pids);
}

const OWN_APP = "这是本应用（claude-app）的窗口，桌面工具不能读取或操作它";

interface WindowInfo {
  id: string;
  app_name?: string;
  pid?: number;
  title?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

async function listWindows(): Promise<WindowInfo[]> {
  const { envelope } = await runCli(["list-windows"], { timeoutMs: 10_000 });
  return envelope?.ok && Array.isArray(envelope.data) ? (envelope.data as WindowInfo[]) : [];
}

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
  if (NEEDS_TARGET.has(command) && refs.length === 0 && windowIds.length === 0 && apps.length === 0) {
    return `${command} 不带 --app、--window-id 或 ref 时作用于前台窗口；网关要求指定目标`;
  }
  if (ownPids.size === 0) return null;

  const points = pointsIn(args);
  if (windowIds.length || points.length) {
    const windows = await listWindows();
    for (const id of windowIds) {
      if (ownPids.has(windows.find((w) => w.id === id)?.pid ?? -1)) return OWN_APP;
    }
    const own = windows.filter((w) => ownPids.has(w.pid ?? -1) && w.bounds);
    for (const p of points) {
      if (own.some(({ bounds: b }) => p.x >= b!.x && p.x < b!.x + b!.width && p.y >= b!.y && p.y < b!.y + b!.height)) {
        return `坐标 ${p.x},${p.y} 落在本应用（claude-app）的窗口里，桌面工具不能操作它`;
      }
    }
  }
  if (apps.length) {
    const ownNames = new Set((await listApps()).filter((a) => ownPids.has(a.pid)).map((a) => a.name.toLowerCase()));
    if (apps.some((a) => ownNames.has(a.toLowerCase()))) return `${OWN_APP}（同名的其他应用请用 --window-id 指定）`;
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
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    writesInFlight--;
    lastWriteEnd = Date.now();
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

// ---------- 删会话 ----------

export function disposeDesktopSession(session: string): void {
  for (const [id, entry] of snapshots) if (entry.session === session) snapshots.delete(id);
  seen.delete(session);
  try {
    rmSync(sessionStateDir(session), { recursive: true, force: true });
  } catch {
    // 目录不在（没用过桌面工具）
  }
}
