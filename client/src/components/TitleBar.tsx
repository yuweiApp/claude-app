import { useEffect, useState } from "react";
import type { DesktopApi } from "../desktop";
import { SidebarToggle } from "./SidebarToggle";

interface Props {
  desktop: DesktopApi;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

/**
 * 桌面版的标题栏（窗口没有系统边框）：左边后退、前进、收起侧边栏，右边最小化、最大化、关闭（会话标题在对话上方那一行）。
 * 空白处可以拖动窗口；macOS 用系统的红绿灯按钮，只在左边留出位置
 */
export function TitleBar({ desktop, canBack, canForward, onBack, onForward, sidebarCollapsed, onToggleSidebar }: Props) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    void desktop.isMaximized().then(setMaximized);
    return desktop.onMaximizedChange(setMaximized);
  }, [desktop]);
  const mac = desktop.platform === "darwin";

  return (
    <header className={`titlebar${mac ? " titlebar-mac" : ""}`}>
      <div className="titlebar-nav">
        <button className="icon-btn" title="后退" aria-label="后退" disabled={!canBack} onClick={onBack}>
          <ArrowIcon dir="left" />
        </button>
        <button className="icon-btn" title="前进" aria-label="前进" disabled={!canForward} onClick={onForward}>
          <ArrowIcon dir="right" />
        </button>
        <SidebarToggle collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
      </div>

      {!mac && (
        <div className="window-controls">
          <button className="window-btn" title="最小化" aria-label="最小化" onClick={() => desktop.minimize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0.5 5h9" stroke="currentColor" />
            </svg>
          </button>
          <button
            className="window-btn"
            title={maximized ? "向下还原" : "最大化"}
            aria-label={maximized ? "向下还原" : "最大化"}
            onClick={() => desktop.toggleMaximize()}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden="true">
                <rect x="0.5" y="2.5" width="7" height="7" />
                <path d="M2.5 2.5v-2h7v7h-2" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" />
              </svg>
            )}
          </button>
          <button className="window-btn window-close" title="关闭" aria-label="关闭" onClick={() => desktop.close()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />
            </svg>
          </button>
        </div>
      )}
    </header>
  );
}

function ArrowIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === "left" ? <path d="M13 8H3M7 4 3 8l4 4" /> : <path d="M3 8h10M9 4l4 4-4 4" />}
    </svg>
  );
}
