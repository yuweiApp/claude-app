import { BrowserWindow, desktopCapturer } from "electron";

/**
 * 桌面工具正在操作的窗口的实时画面（网页右上角的浮窗）：按网关报的窗口标题在 desktopCapturer 的窗口列表里找，
 * 把采集源的 id 交给网页，网页用 getUserMedia（chromeMediaSource: desktop）取视频流。
 * Windows 10 1903+ 用 Windows Graphics Capture、macOS 用 ScreenCaptureKit，被挡住的窗口也有画面；最小化的窗口没有。
 * macOS 要给本应用开「屏幕录制」权限，没开时列表里没有别的应用的窗口
 */

export interface CaptureSource {
  /** desktopCapturer 的采集源 id（window:…） */
  id: string;
  name: string;
  /** 应用图标（data URL），有的平台没有 */
  icon?: string;
}

/** 按标题找窗口：完全相同的优先，其次标题互相包含的（有的平台在标题前后加应用名）；本应用的窗口不算 */
export async function findCaptureSource(title: string): Promise<CaptureSource | null> {
  const wanted = title.trim();
  if (!wanted) return null;
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  const sources = (await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: true })).filter(
    (s) => !own.has(s.id),
  );
  const exact = sources.filter((s) => s.name.trim() === wanted);
  const loose = sources.filter((s) => s.name.includes(wanted) || (s.name.trim().length > 3 && wanted.includes(s.name.trim())));
  const source = exact[0] ?? (loose.length === 1 ? loose[0] : undefined);
  if (!source) return null;
  const icon = source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : undefined;
  return { id: source.id, name: source.name, ...(icon ? { icon } : {}) };
}
