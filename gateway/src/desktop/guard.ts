import { rmSync } from "node:fs";
import type { DesktopTarget } from "../shared/types.js";
import { APP_ARGUMENT, flagValues, isHelp, refsIn, snapshotIdOf } from "./commands.js";
import { runCli, sessionStateDir } from "./cli.js";
import { desktopLog } from "./log.js";

/**
 * 桌面操作的拦截和记录，见 docs/agent-desktop.md 第 6、7 节：
 * - 本应用（桌面版）的窗口不能读、不能操作（6.1）：桌面版连上 /browser/host 时报自己的进程号（BrowserHost 调 setOwnPids）。
 *   只做不用另外读窗口列表的检查：按应用名、按窗口 id（在见过的 list-windows 结果里属于本应用的）、ref 的归属；不查坐标
 * - 桌面写操作进行中收到的权限回复不算数（6.2）：desktopWriteActive()
 * - 别的会话做过的桌面操作，下一次调用时告诉模型（7.2）：othersSince()
 * 另外记着每个会话正在操作的窗口，给网页右上角的浮窗：noteTarget()
 * 都在网关里，不经过权限系统，「完全访问权限」下照样生效
 */

// ---------- 本应用的进程 ----------

let ownPids = new Set<number>();

/** 桌面版的进程号（主进程和它的子进程）；桌面版断开时传空数组。连上时读一次 list-apps，记下本应用的应用名 */
export function setOwnPids(pids: number[]): void {
  ownPids = new Set(pids);
  desktopLog({ kind: "own-pids", pids });
  if (pids.length) void learnApps().catch(() => {});
}

const OWN_APP = "这是本应用（claude-app）的窗口，桌面工具不能读取或操作它";

interface WindowInfo {
  id: string;
  app_name?: string;
  pid?: number;
  title?: string;
  minimized?: boolean;
}

/**
 * 见过的窗口（来自 list-windows 的结果：模型自己调用的，和输入框「Computer Use」查的）：窗口 id 属于哪个进程、标题。
 * 拦本应用的窗口 id、浮窗显示标题都查它，不为此另外读窗口列表
 */
const knownWindows = new Map<string, WindowInfo>();
const MAX_KNOWN_WINDOWS = 1000;

function rememberWindows(windows: unknown): void {
  if (!Array.isArray(windows)) return;
  for (const w of windows as WindowInfo[]) {
    if (!w || typeof w.id !== "string") continue;
    knownWindows.delete(w.id);
    knownWindows.set(w.id, { id: w.id, app_name: w.app_name, pid: w.pid, title: w.title, minimized: w.minimized });
  }
  while (knownWindows.size > MAX_KNOWN_WINDOWS) knownWindows.delete(knownWindows.keys().next().value as string);
}

/** 最近一次见到的 list-apps（全部，含本应用的）：按应用名拦本应用时用 */
let runningApps: { name: string; pid: number }[] | null = null;

function rememberApps(data: unknown): void {
  const apps = (data as { apps?: unknown } | undefined)?.apps;
  if (Array.isArray(apps)) runningApps = (apps as { name?: unknown; pid?: unknown }[]).filter((a) => typeof a.name === "string" && typeof a.pid === "number") as { name: string; pid: number }[];
}

async function learnApps(): Promise<void> {
  const { envelope } = await runCli(["list-apps"], { timeoutMs: 10_000 });
  if (envelope?.ok) rememberApps(envelope.data);
}

/** 所有窗口（含本应用的，不交给模型），给输入框「Computer Use」的窗口列表用；顺便记进 knownWindows */
export async function listWindows(): Promise<WindowInfo[]> {
  const { envelope } = await runCli(["list-windows"], { timeoutMs: 10_000 });
  if (!envelope?.ok || !Array.isArray(envelope.data)) return [];
  rememberWindows(envelope.data);
  return envelope.data as WindowInfo[];
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

// ---------- 快照登记（ref 从哪来、属于哪个应用和窗口） ----------

interface SnapshotData {
  app?: string;
  snapshot_id?: string;
  tree?: unknown;
  window?: { id?: string; title?: string };
}

interface SnapshotEntry {
  session: string;
  app?: string;
  windowId?: string;
}

const snapshots = new Map<string, SnapshotEntry>();
const MAX_SNAPSHOTS = 500;

function remember(id: string, entry: SnapshotEntry): void {
  const old = snapshots.get(id);
  if (old) {
    old.app ??= entry.app;
    old.windowId ??= entry.windowId;
    return;
  }
  snapshots.set(id, entry);
  if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value as string);
}

/** 结果里带 snapshot_id 和 tree 的对象（snapshot 的 data 本身，或 ref 动作带 --wait-for 时嵌在里面的快照） */
function findSnapshots(value: unknown, depth = 0, out: SnapshotData[] = []): SnapshotData[] {
  if (!value || typeof value !== "object" || depth > 3) return out;
  if (Array.isArray(value)) {
    for (const item of value) findSnapshots(item, depth + 1, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.snapshot_id === "string" && obj.tree && typeof obj.tree === "object") out.push(obj as SnapshotData);
  else for (const v of Object.values(obj)) findSnapshots(v, depth + 1, out);
  return out;
}

/**
 * 一次成功调用的结果：记下快照编号属于这个会话（ref 只认这个会话经网关拿到的）和它的应用、窗口，
 * list-windows / list-apps 的窗口和应用。stdout 是原始输出，find 等结果里出现的 ref 也记上
 */
export function observeResult(session: string, args: string[], data: unknown, stdout: string): void {
  const command = args[0];
  if (command === "list-windows") rememberWindows(data);
  if (command === "list-apps") rememberApps(data);
  for (const snap of findSnapshots(data)) remember(snap.snapshot_id!, { session, app: snap.app, windowId: snap.window?.id });
  const app = flagValues(args, "--app")[0];
  for (const m of stdout.matchAll(/@[A-Za-z0-9]+:e\d+/g)) remember(snapshotIdOf(m[0]), { session, app });
}

// ---------- 检查 ----------

/**
 * 执行前检查参数指向的目标，不行返回原因。args 是 agent-desktop 的参数（命令在第一个）。
 * - ref 必须是这个会话经网关拿到的
 * - --window-id 在见过的 list-windows 结果里属于本应用的，拒绝
 * - --app、launch / close-app 的应用名是本应用的，拒绝
 * 不查坐标，也不要求指定目标：坐标点击（要 headed）、不带目标的命令（作用于前台窗口，前台可能是本应用）能读到、点到本应用的窗口，权限卡片靠 6.2
 */
export async function checkTarget(session: string, args: string[]): Promise<string | null> {
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
    if (!entry || entry.session !== session) return `${ref} 不是这个会话经 desktop() 拿到的 ref（本应用重启后，之前拿到的 ref 也不再认）`;
  }
  const windowIds = flagValues(args, "--window-id");
  const appArg = APP_ARGUMENT.has(command) && args[1] && !args[1].startsWith("-") ? [args[1]] : [];
  const apps = [...flagValues(args, "--app"), ...appArg];
  if (ownPids.size === 0) return null;

  context.windows = windowIds.map((id) => knownWindows.get(id) ?? { id, known: false });
  for (const id of windowIds) {
    if (ownPids.has(knownWindows.get(id)?.pid ?? -1)) return OWN_APP;
  }
  if (apps.length) {
    if (!runningApps) await learnApps().catch(() => {});
    const running = runningApps ?? [];
    context.apps = running.filter((a) => apps.some((name) => name.toLowerCase() === a.name.toLowerCase()));
    const ownNames = new Set(running.filter((a) => ownPids.has(a.pid)).map((a) => a.name.toLowerCase()));
    const app = apps.find((a) => ownNames.has(a.toLowerCase()));
    if (app) {
      // 应用名和本应用相同的其他进程（实测 Windows 上开发模式的 Electron 应用都叫 electron.exe）：拦下的不一定是本应用的窗口，照实说
      const others = running.filter((a) => !ownPids.has(a.pid) && a.name.toLowerCase() === app.toLowerCase()).map((a) => a.pid);
      if (others.length === 0) return OWN_APP;
      return `不接受 ${app} 这个应用名：本应用（claude-app）的进程也叫 ${app}，按应用名分不出是不是本应用（同名的其他进程：pid ${others.join("、")}）。按窗口 id（--window-id）指定、不给应用名时，按窗口所属的进程判断`;
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

// ---------- 正在操作的窗口（网页右上角的浮窗） ----------

/** 每个会话上次报出去的目标，没变不再报 */
const reported = new Map<string, DesktopTarget | null>();

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * 这次调用作用于哪个窗口，变了就调 report。不另外读窗口列表，只用手上有的：
 * 参数（--window-id、--app、launch / close-app 的应用名、ref 所属快照的应用和窗口）、调用结果（data 里的 app、window）、
 * 见过的 list-windows 结果（按窗口 id 查标题）。只知道应用名时，应用和上次报的相同就沿用上次的窗口，否则只报应用名。
 * close-app 报 null；没有目标的命令（list-apps 等）不报
 */
export function noteTarget(session: string, args: string[], data: unknown, report: (target: DesktopTarget | null) => void): void {
  const command = args[0] ?? "";
  if (isHelp(args)) return;
  const send = (target: DesktopTarget | null) => {
    if (JSON.stringify(reported.get(session) ?? null) === JSON.stringify(target) && reported.has(session)) return;
    reported.set(session, target);
    report(target);
  };
  if (command === "close-app") return send(null);
  const result = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const resultWindow = result.window && typeof result.window === "object" ? (result.window as Record<string, unknown>) : {};
  let windowId = flagValues(args, "--window-id")[0] ?? str(resultWindow.id);
  let app = flagValues(args, "--app")[0] ?? (APP_ARGUMENT.has(command) && args[1] && !args[1].startsWith("-") ? args[1] : undefined) ?? str(result.app) ?? str(result.app_name);
  for (const ref of refsIn(args)) {
    const entry = snapshots.get(snapshotIdOf(ref));
    windowId ??= entry?.windowId;
    app ??= entry?.app;
  }
  const known = windowId ? knownWindows.get(windowId) : undefined;
  if (known && ownPids.has(known.pid ?? -1)) return;
  const name = known?.app_name ?? app;
  if (!name) return;
  if (!windowId) {
    const last = reported.get(session);
    if (last?.windowId && last.app.toLowerCase() === name.toLowerCase()) return;
    return send({ app: name });
  }
  const pid = known?.pid ?? (typeof result.pid === "number" ? result.pid : undefined);
  send({
    app: name,
    windowId,
    ...((str(resultWindow.title) ?? known?.title) ? { title: str(resultWindow.title) ?? known?.title } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(known?.minimized ? { minimized: true } : {}),
  });
}

// ---------- 删会话 ----------

export function disposeDesktopState(session: string): void {
  for (const [id, entry] of snapshots) if (entry.session === session) snapshots.delete(id);
  seen.delete(session);
  reported.delete(session);
  try {
    rmSync(sessionStateDir(session), { recursive: true, force: true });
  } catch {
    // 目录不在（没用过桌面工具）
  }
}
