/**
 * 桌面工具的排查日志：每次 agent-desktop 调用（实际参数、耗时、原始结果）、guard 的判断（本应用的进程号、目标窗口 / 应用、结论）。
 * 写进对话日志（logging/conversation-log.ts），和对话按时间排在一起，每行 { time, sessionId, desktop: {...} }。
 * 网关的运行日志在 Windows 上只输出到桌面版的终端，对话日志是文件，远程也能取
 */
export type DesktopLogEntry = { kind: string; session?: string } & Record<string, unknown>;

let sink: ((entry: DesktopLogEntry) => void) | null = null;

/** 网关启动时接上对话日志 */
export function setDesktopLog(fn: ((entry: DesktopLogEntry) => void) | null): void {
  sink = fn;
}

export function desktopLog(entry: DesktopLogEntry): void {
  try {
    sink?.(entry);
  } catch {
    // 写日志失败不影响桌面工具
  }
}

/** 长文字只留开头 */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字符）` : text);
