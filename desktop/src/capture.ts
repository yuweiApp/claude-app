import { execFile } from "node:child_process";
import { BrowserWindow, desktopCapturer } from "electron";

/**
 * 桌面工具正在操作的窗口的实时画面（网页右上角的浮窗）：按网关报的窗口（Windows 上有窗口 id 时按 id，否则按标题）在 desktopCapturer 的窗口列表里找，
 * 把采集源的 id 交给网页，网页用 getUserMedia（chromeMediaSource: desktop）取视频流。
 * Windows 10 1903+ 用 Windows Graphics Capture、macOS 用 ScreenCaptureKit，被挡住的窗口也有画面；最小化的窗口不在列表里
 * （Windows 上实测，Notepad++ 等最小化的窗口都没有），找不到，还原后才有：Windows 上网页展开浮窗时调 restoreWindow 不抢焦点地还原，
 * 其他平台网页隔几秒再找。
 * macOS 要给本应用开「屏幕录制」权限，没开时列表里没有别的应用的窗口
 */

export interface CaptureSource {
  /** desktopCapturer 的采集源 id（window:…） */
  id: string;
  name: string;
  /** 应用图标（data URL），有的平台没有 */
  icon?: string;
}

/** agent-desktop 在 Windows 上的窗口 id 是 w-<HWND 十进制>，采集源的 id 是 window:<HWND>:0（2026-11-23 company 上对照实测）；macOS 上没对照过，不按 id 找 */
function hwndOf(windowId: string | undefined): string | null {
  if (process.platform !== "win32" || !windowId) return null;
  return /^w-(\d+)$/.exec(windowId)?.[1] ?? null;
}

/**
 * 找窗口：Windows 上有窗口 id 时只按 id（同名的窗口、改了标题的窗口也找得对，找不到就是没有，不退回按标题）；
 * 否则按标题，完全相同的优先，其次标题互相包含的（有的平台在标题前后加应用名）。本应用的窗口不算
 */
export async function findCaptureSource(title: string, windowId?: string): Promise<CaptureSource | null> {
  const wanted = title.trim();
  const hwnd = hwndOf(windowId);
  if (!wanted && !hwnd) return null;
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  const sources = (await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: true })).filter(
    (s) => !own.has(s.id),
  );
  let source: Electron.DesktopCapturerSource | undefined;
  if (hwnd) source = sources.find((s) => s.id.startsWith(`window:${hwnd}:`));
  else {
    const exact = sources.filter((s) => s.name.trim() === wanted);
    const loose = sources.filter((s) => s.name.includes(wanted) || (s.name.trim().length > 3 && wanted.includes(s.name.trim())));
    source = exact[0] ?? (loose.length === 1 ? loose[0] : undefined);
  }
  if (!source) return null;
  const icon = source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : undefined;
  return { id: source.id, name: source.name, ...(icon ? { icon } : {}) };
}

/** 还原窗口时 PowerShell 最多跑多久（第一次编译 Add-Type 要一两秒） */
const RESTORE_TIMEOUT_MS = 15_000;

/**
 * 不抢焦点地还原最小化的窗口（只有 Windows）：ShowWindow(SW_SHOWNOACTIVATE)，前台窗口不变（2026-11-23 company 上实测，前台的 RustDesk 没被切走）。
 * 不用 agent-desktop 的 restore：它走 UI Automation，实测会把窗口切到前台。Electron 没有调 Win32 的接口，经 PowerShell 的 Add-Type 调。
 * 窗口没最小化时不动它。返回还原后窗口在、而且不是最小化
 */
export async function restoreWindow(windowId: string): Promise<boolean> {
  const hwnd = hwndOf(windowId);
  if (!hwnd) return false;
  const script = [
    "$w = Add-Type -PassThru -Name W -Namespace ClaudeAppCapture -MemberDefinition '",
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
    "'",
    `$h = [IntPtr][long]${hwnd}`,
    "if ($w::IsWindow($h) -and $w::IsIconic($h)) { [void]$w::ShowWindow($h, 4) }",
    "if ($w::IsWindow($h) -and -not $w::IsIconic($h)) { 'ok' } else { 'no' }",
  ].join("\n");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: RESTORE_TIMEOUT_MS },
      (err, stdout) => resolve(!err && stdout.trim() === "ok"),
    );
  });
}
