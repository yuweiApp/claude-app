import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { desktopCapturer, screen, systemPreferences, type BrowserWindow } from "electron";

/** 屏幕坐标（DIP）里的矩形 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一段横线（DIP）：y 处从 x1 到 x2 */
export interface Segment {
  y: number;
  x1: number;
  x2: number;
}

/**
 * 屏幕画面里的横线：上下相邻两行像素亮度差到这么多（0–255）的地方连成一长条就算一条线。
 * VS Code 深色主题里编辑区和面板之间的分隔线和背景只差 10 左右
 */
const EDGE_CONTRAST = 9;
/** 连着的一条里允许断开几个像素（抗锯齿、虚线） */
const EDGE_GAP = 2;
/** 画面里的线至少这么长（DIP）才算，短的多半是文字的笔画 */
const MIN_SCREEN_LINE = 60;

/** 太窄、太矮的窗口不算（多半是看不见的辅助窗口），露出来太短的线段也不算 */
const MIN_WIDTH = 50;
const MIN_HEIGHT = 30;
const MIN_SEGMENT = 40;
/** 取一次窗口列表最多等多久，过了就当没有 */
const LIST_TIMEOUT_MS = 5000;

/**
 * 别的窗口露出来的上沿：rects 按前后层次排，最前面的在第一个。每个窗口的上沿减掉被它前面的窗口挡住的部分（前面的窗口上下跨过这条线），
 * 剩下的每一截都是一段线，灵宠可以站在上面
 */
export function topEdges(rects: Rect[]): Segment[] {
  const out: Segment[] = [];
  rects.forEach((r, i) => {
    const y = r.y;
    let parts: [number, number][] = [[r.x, r.x + r.width]];
    for (const above of rects.slice(0, i)) {
      if (!(above.y < y && above.y + above.height > y)) continue;
      const a1 = above.x;
      const a2 = above.x + above.width;
      parts = parts.flatMap(([p1, p2]): [number, number][] => {
        if (a2 <= p1 || a1 >= p2) return [[p1, p2]];
        const left: [number, number][] = a1 > p1 ? [[p1, a1]] : [];
        const right: [number, number][] = a2 < p2 ? [[a2, p2]] : [];
        return [...left, ...right];
      });
      if (!parts.length) break;
    }
    for (const [x1, x2] of parts) if (x2 - x1 >= MIN_SEGMENT) out.push({ y, x1, x2 });
  });
  return out;
}

/**
 * 一帧画面（w × h 的 4 字节像素，RGBA 或 BGRA 都行，红蓝权重一样）里找横线：某一行和上一行亮度差得多的像素连成一长条就是一条线的上沿
 * （分隔线、上下两块不同颜色的边界、窗口的边）。不整张扫：拖动时只看爪子附近那几行
 */
export class Frame {
  constructor(
    private readonly buf: Uint8Array,
    readonly width: number,
    readonly height: number,
  ) {}

  private lum(i: number): number {
    const j = i * 4;
    return (this.buf[j]! + 2 * this.buf[j + 1]! + this.buf[j + 2]!) >> 2;
  }

  private strong(x: number, y: number): boolean {
    const i = y * this.width + x;
    return Math.abs(this.lum(i) - this.lum(i - this.width)) >= EDGE_CONTRAST;
  }

  /** 第 y 行（1 ≤ y < height）经过 x 的那条线从哪到哪（像素，x2 不含），离 x 最近的亮度差超过 EDGE_GAP 就算不经过 */
  private runAt(x: number, y: number): [number, number] | undefined {
    let left = -1;
    for (let i = x; i >= 0; i--) {
      if (this.strong(i, y)) left = i;
      else if ((left < 0 ? x : left) - i > EDGE_GAP) break;
    }
    let right = -1;
    for (let i = x; i < this.width; i++) {
      if (this.strong(i, y)) right = i;
      else if (i - (right < 0 ? x : right) > EDGE_GAP) break;
    }
    if (left < 0 && right < 0) return undefined;
    return [left >= 0 ? left : right, (right >= 0 ? right : left) + 1];
  }

  /**
   * y0 到 y1 行之间（含）经过 x、至少 minRun 长的线（像素）。很细的线上下两边都是亮度变化的地方，只要上面那条：
   * 上一两行在同一处也有线时这一行不算
   */
  linesAt(x: number, y0: number, y1: number, minRun: number): Segment[] {
    if (x < 0 || x >= this.width) return [];
    const out: Segment[] = [];
    const hits = new Set<number>();
    for (let y = Math.max(1, y0 - 2); y <= Math.min(this.height - 1, y1); y++) {
      const run = this.runAt(x, y);
      if (!run || run[1] - run[0] < minRun) continue;
      if (y >= y0 && !hits.has(y - 1) && !hits.has(y - 2)) out.push({ y, x1: run[0], x2: run[1] });
      hits.add(y);
    }
    return out;
  }
}

/** 截屏前把灵宠窗口从画面里去掉，等这么久让它生效 */
const HIDE_FROM_CAPTURE_MS = 60;

/** 一块屏幕的一帧画面，和它在屏幕坐标（DIP）里的位置 */
export interface ScreenFrame {
  bounds: Electron.Rectangle;
  frame: Frame;
}

/**
 * 截一次每块屏幕的画面，拖动时用 screenLinesAt 在里面找线。截的时候把灵宠窗口设成不进画面（setContentProtection），它挡住的地方也找得到线。
 * macOS 上没给录屏权限时不截（截了会弹授权框），Linux 上 Wayland 不截（会弹选择屏幕的框）
 */
export async function captureScreens(pet: BrowserWindow): Promise<ScreenFrame[]> {
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") return [];
  if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") return [];
  const displays = screen.getAllDisplays();
  const width = Math.max(...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor)));
  const height = Math.max(...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor)));
  let sources: Electron.DesktopCapturerSource[] = [];
  try {
    pet.setContentProtection(true);
    await new Promise((r) => setTimeout(r, HIDE_FROM_CAPTURE_MS));
    sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  } catch {
    return [];
  } finally {
    if (!pet.isDestroyed()) pet.setContentProtection(false);
  }
  const out: ScreenFrame[] = [];
  for (const source of sources) {
    const display = displays.find((d) => String(d.id) === source.display_id) ?? (displays.length === 1 ? displays[0] : undefined);
    const size = source.thumbnail.getSize();
    if (!display || !size.width || !size.height) continue;
    out.push({ bounds: display.bounds, frame: new Frame(source.thumbnail.toBitmap(), size.width, size.height) });
  }
  return out;
}

/** 画面里经过 (x, y ± range) 的横线（DIP），x、y 是屏幕坐标 */
export function screenLinesAt(frames: ScreenFrame[], x: number, y: number, range: number): Segment[] {
  const f = frames.find(({ bounds: b }) => x >= b.x && x < b.x + b.width && y >= b.y - range && y < b.y + b.height + range);
  if (!f) return [];
  const sx = f.bounds.width / f.frame.width;
  const sy = f.bounds.height / f.frame.height;
  const px = Math.floor((x - f.bounds.x) / sx);
  const y0 = Math.floor((y - range - f.bounds.y) / sy);
  const y1 = Math.ceil((y + range - f.bounds.y) / sy);
  return f.frame
    .linesAt(px, y0, y1, Math.ceil(MIN_SCREEN_LINE / sx))
    .map((l) => ({ y: f.bounds.y + l.y * sy, x1: f.bounds.x + l.x1 * sx, x2: f.bounds.x + l.x2 * sx }));
}

/**
 * Windows：一个常驻的 PowerShell，每收到一行就列一次顶层窗口，一行输出 "左,上,右,下;…"（物理像素，前后层次从前到后）。
 * 只要看得见、没最小化、没被系统藏起来（cloaked，比如别的虚拟桌面上的）的普通窗口：工具窗口（含灵宠自己、任务栏）、
 * 鼠标穿透的覆盖层、没有标题的、桌面本身都不要。用窗口的实际边框（DWM 的 extended frame bounds），不含看不见的缩放边。
 * Add-Type 第一次编译要一两秒，所以常驻着
 */
const WINDOWS_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ClaudeAppPetEdges {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public static string List() {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) {}
    var sb = new StringBuilder();
    var cls = new StringBuilder(64);
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0 || (ex & 0x20) != 0) return true;
      if (GetWindowTextLength(h) == 0) return true;
      cls.Clear();
      GetClassName(h, cls, 64);
      string c = cls.ToString();
      if (c == "Progman" || c == "WorkerW") return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      RECT r;
      if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) return true;
      sb.Append(r.L).Append(',').Append(r.T).Append(',').Append(r.R).Append(',').Append(r.B).Append(';');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
'@
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { [Console]::Out.WriteLine([ClaudeAppPetEdges]::List()) } catch { [Console]::Out.WriteLine('') }
}
`;

/** 常驻的 PowerShell 和排着队等结果的请求（一行输出对一个请求） */
let ps: ChildProcessWithoutNullStreams | undefined;
let waiting: ((line: string | null) => void)[] = [];

function startPowerShell(): ChildProcessWithoutNullStreams {
  if (ps && ps.exitCode === null && !ps.killed) return ps;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT], { windowsHide: true });
  let buf = "";
  let ready = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!ready) {
        ready = line === "ready";
        continue;
      }
      waiting.shift()?.(line);
    }
  });
  child.on("error", () => undefined);
  child.on("exit", () => {
    if (ps === child) ps = undefined;
    const rest = waiting;
    waiting = [];
    for (const done of rest) done(null);
  });
  ps = child;
  return child;
}

function listWindows(): Promise<Rect[]> {
  const child = startPowerShell();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), LIST_TIMEOUT_MS);
    const finish = (line: string | null) => {
      clearTimeout(timer);
      waiting = waiting.filter((w) => w !== finish);
      if (!line) return resolve([]);
      const rects: Rect[] = [];
      for (const item of line.split(";")) {
        const n = item.split(",").map(Number);
        if (n.length !== 4 || !n.every(Number.isFinite)) continue;
        const [l, t, r, b] = n as [number, number, number, number];
        // 物理像素换成 DIP：按窗口所在的那块屏幕的缩放换算
        rects.push(screen.screenToDipRect(null, { x: l, y: t, width: r - l, height: b - t }));
      }
      resolve(rects);
    };
    waiting.push(finish);
    child.stdin.write("\n");
  });
}

/**
 * macOS：CGWindowListCopyWindowInfo 列屏幕上的窗口（前后层次从前到后，坐标就是 DIP），只要普通层（layer 0）、看得见的。
 * 窗口的位置大小不需要录屏权限（标题才要）
 */
const MAC_SCRIPT = `
ObjC.import('CoreGraphics');
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
JSON.stringify(list.filter((w) => w.kCGWindowLayer === 0 && (w.kCGWindowAlpha === undefined || w.kCGWindowAlpha > 0))
  .map((w) => [w.kCGWindowOwnerPID, w.kCGWindowBounds.X, w.kCGWindowBounds.Y, w.kCGWindowBounds.Width, w.kCGWindowBounds.Height]));
`;

function listWindowsMac(): Promise<{ pid: number; rect: Rect }[]> {
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT], { timeout: LIST_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const rows = JSON.parse(stdout) as unknown;
        if (!Array.isArray(rows)) return resolve([]);
        resolve(
          rows
            .filter((r): r is [number, number, number, number, number] => Array.isArray(r) && r.length === 5 && r.every((v) => typeof v === "number" && Number.isFinite(v)))
            .map(([pid, x, y, width, height]) => ({ pid, rect: { x, y, width, height } })),
        );
      } catch {
        resolve([]);
      }
    });
  });
}

/** 灵宠一出来就先把 Windows 上的 PowerShell 起好，第一次拖的时候不用等编译 */
export function warmWindowEdges(): void {
  if (process.platform === "win32") startPowerShell();
}

export function stopWindowEdges(): void {
  ps?.kill();
  ps = undefined;
}

/**
 * 别的窗口露出来的上沿（DIP）。pet 是灵宠窗口现在的位置，自己不算。
 * 只有 Windows 和 macOS 有；Linux 上（只是开发机）返回空的，只吸屏幕的边
 */
export async function windowEdges(pet: Rect): Promise<Segment[]> {
  let rects: Rect[] = [];
  if (process.platform === "win32") rects = await listWindows();
  else if (process.platform === "darwin") {
    const same = (r: Rect) => Math.abs(r.x - pet.x) <= 2 && Math.abs(r.y - pet.y) <= 2 && Math.abs(r.width - pet.width) <= 2 && Math.abs(r.height - pet.height) <= 2;
    rects = (await listWindowsMac()).filter((w) => !(w.pid === process.pid && same(w.rect))).map((w) => w.rect);
  }
  return topEdges(rects.filter((r) => r.width >= MIN_WIDTH && r.height >= MIN_HEIGHT));
}
