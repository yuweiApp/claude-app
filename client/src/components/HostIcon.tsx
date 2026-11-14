import { useId } from "react";
import type { SshConnectionInfo } from "../api";
import { useSshConnections } from "../state/sshConnections";

/**
 * 远程主机的系统图标（同 codex-app-server 的 ProjectIcon）：macOS、Windows、Linux 各一个，系统未知（还没连上过）时是通用的远程显示器。
 * 系统来自连接信息里的 platform（darwin-arm64、linux-x64 这样，连上过才有）。带 .host-icon 的颜色，和本机的文件夹区分开；
 * 没连上（未连接、连接中、失败）时是灰色的（.offline）
 */
type Os = "macOS" | "Windows" | "Linux";

function osOf(platform: string | undefined): Os | null {
  const p = platform?.toLowerCase() ?? "";
  if (p.startsWith("darwin") || p.startsWith("mac")) return "macOS";
  if (p.startsWith("win")) return "Windows";
  if (p.startsWith("linux")) return "Linux";
  return null;
}

export function HostIcon({ hostId, size = 16 }: { hostId: string; size?: number }) {
  const conn = useSshConnections().find((c) => c.id === hostId);
  // 苹果彩虹条纹的裁剪路径 id 每个图标一份；useId 带冒号等符号，放进 url(#…) 前去掉
  const clipId = `host-apple-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const os = osOf(conn?.platform);
  const label = `${os ?? "远程"}主机${conn ? ` ${conn.name}` : ""}`;
  const common = { className: `ic host-icon${conn?.status === "ready" ? "" : " offline"}`, width: size, height: size, role: "img", "aria-label": label } as const;
  // 经典彩色图标：苹果是六色彩虹条纹（裁在苹果形状里），Windows 是红绿蓝黄四色窗格；没连上时整体去色（.offline）
  if (os === "macOS")
    return (
      <svg {...common} viewBox="0 0 24 24">
        <defs>
          <clipPath id={clipId}>
            <path d="M16.8 2c.1 2.4-1.4 4.1-3.5 4.5-.3-2.2 1.6-4.4 3.5-4.5ZM16.5 7c-1.4-.1-2.6.8-3.5.8-.9 0-2-.8-3.3-.8C7 7 5 9.1 5 12.4c0 3.8 2.7 8.7 4.9 8.6 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.8 0 3.6-2.8 4.2-4.6-3.3-1.4-3.4-5.7-.1-7.4-.9-1.3-2.1-1.9-3.5-2Z" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <rect x="0" y="0" width="24" height="9.8" fill="#61bb46" />
          <rect x="0" y="9.8" width="24" height="2.3" fill="#fdb827" />
          <rect x="0" y="12.1" width="24" height="2.3" fill="#f5821f" />
          <rect x="0" y="14.4" width="24" height="2.3" fill="#e03a3e" />
          <rect x="0" y="16.7" width="24" height="2.3" fill="#963d97" />
          <rect x="0" y="19" width="24" height="5" fill="#009ddc" />
        </g>
      </svg>
    );
  if (os === "Windows")
    return (
      <svg {...common} viewBox="0 0 24 24">
        <path d="M2 4.5 10.5 3.3v7.9H2z" fill="#f25022" />
        <path d="M12 3.1 22 1.7v9.5H12z" fill="#7fba00" />
        <path d="M2 12.8h8.5v7.9L2 19.5z" fill="#00a4ef" />
        <path d="M12 12.8h10v9.5l-10-1.4z" fill="#ffb900" />
      </svg>
    );
  if (os === "Linux")
    return (
      <svg {...common} viewBox="0 0 24 24">
        <path fill="currentColor" d="M8 7a4 4 0 0 1 8 0v1.5c0 1.3 1.1 2.7 2.1 4.3 1.1 1.8 1.7 3.4 1.4 5-.4 2.1-2.6 3.2-7.5 3.2s-7.1-1.1-7.5-3.2c-.3-1.6.3-3.2 1.4-5C6.9 11.2 8 9.8 8 8.5Z" />
        <ellipse cx="12" cy="15" rx="4.4" ry="5.2" fill="#fff" />
        <ellipse cx="10.1" cy="7.4" rx="1.35" ry="1.7" fill="#fff" />
        <ellipse cx="13.9" cy="7.4" rx="1.35" ry="1.7" fill="#fff" />
        <circle cx="10.5" cy="7.6" r=".55" fill="currentColor" />
        <circle cx="13.5" cy="7.6" r=".55" fill="currentColor" />
        <path d="m9.1 9.2 2.9-1 2.9 1-2.9 2.1Z" fill="#e5ac37" />
        <path d="m7.8 18.6 2.7 2.6-4.7 1-2-1.4 1.8-2.6Zm8.4 0-2.7 2.6 4.7 1 2-1.4-1.8-2.6Z" fill="#e5ac37" />
      </svg>
    );
  return (
    <svg {...common} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.4" />
      <path d="M5.5 13.6h5M8 11.2v2.4" />
      <path d="m4.8 5.6 1.6 1.4-1.6 1.4M8 8.4h2.6" />
    </svg>
  );
}

/** 连接状态的文字（悬停提示用） */
export function hostStatusText(c: SshConnectionInfo | undefined): string {
  switch (c?.status) {
    case "ready":
      return "已连接";
    case "connecting":
      return "连接中…";
    case "deploying":
      return "正在准备远端…";
    case "error":
      return c.hostKey ? "要在设置里确认主机密钥" : c.needsPassword ? "需要密码，在设置里连接" : `连接失败${c.error ? `：${c.error}` : ""}`;
    case "disconnected":
      return "未连接，开始会话时连接";
    default:
      return "连接不存在（可能已经在设置里删掉了）";
  }
}

/**
 * 远程主机的连接状态：黄色连接中（闪），红色失败，灰色未连接；已连接不显示（系统图标是彩色的就是连着）。
 * running：这台主机上（项目里）有会话在跑，已连接时显示呼吸灯
 */
export function HostStatusDot({ hostId, running = false }: { hostId: string; running?: boolean }) {
  const conn = useSshConnections().find((c) => c.id === hostId);
  if (conn?.status === "ready" && !running) return null;
  const cls =
    conn?.status === "ready"
      ? " on running"
      : conn?.status === "connecting" || conn?.status === "deploying"
        ? " busy"
        : conn?.status === "error"
          ? " err"
          : "";
  const text = `${conn?.name ?? hostId}：${hostStatusText(conn)}${running && conn?.status === "ready" ? "，有会话在运行" : ""}`;
  return <span className={`env-dot${cls}`} title={text} role="img" aria-label={text} />;
}
