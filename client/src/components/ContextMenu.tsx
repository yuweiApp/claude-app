import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "./ComposerPickers";

export interface ContextMenuItem {
  label: string;
  run: () => void;
}

/**
 * 右键菜单（同系统菜单的样子，见 .context-menu）：children 拿到 onContextMenu 挂在元素上，
 * 右键处弹出 items，贴着窗口右边、下边时往里收；点外面、按 Esc 关掉。items 为空时不拦右键
 */
export function ContextMenu({ items, children }: { items: ContextMenuItem[]; children: (onContextMenu: (e: MouseEvent<HTMLElement>) => void) => ReactNode }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAt(null), []);
  useDismiss(menuRef, at !== null, close);
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    if (!items.length) return;
    e.preventDefault();
    // 菜单宽约 200，每项约 36 高
    setAt({ left: Math.min(e.clientX, window.innerWidth - 210), top: Math.min(e.clientY, window.innerHeight - 12 - items.length * 36) });
  };
  return (
    <>
      {children(onContextMenu)}
      {at &&
        createPortal(
          <div ref={menuRef} className="menu context-menu" role="menu" style={{ left: at.left, top: at.top }}>
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  close();
                  item.run();
                }}
              >
                <span className="menu-item-name">{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
