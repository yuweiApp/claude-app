import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useDismiss } from "./ComposerPickers";
import { MonitorIcon } from "./DesktopTargetFloat";

interface DesktopWindow {
  id: string;
  app: string;
  title: string;
}

interface Props {
  /** 网关开没开桌面工具（config.yml 的 desktop.enabled），没开不显示按钮 */
  enabled: boolean;
  /** 选中一个窗口 */
  onPick: (window: DesktopWindow) => void;
  /** 选中桌面本身（第一行） */
  onPickDesktop: () => void;
}

/**
 * 输入框上面的「Computer Use」：和「浏览器」一样点开搜索、选择，选中后插在输入框的光标处。
 * 第一行是桌面本身（写成 @桌面），下面是桌面工具（agent-desktop）能看到的窗口（@desktop[标题](window:窗口 id "应用名")），本应用自己的窗口网关已经去掉。
 * 网关没开桌面工具（config.yml 的 desktop.enabled）时不显示按钮；开没开从网关的 /config 来，窗口打开菜单时才列
 */
export function DesktopPicker({ enabled, onPick, onPickDesktop }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [windows, setWindows] = useState<DesktopWindow[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  // 每次打开时重新列窗口（窗口随时在开关）
  useEffect(() => {
    if (!open) {
      setSearch("");
      setWindows(null);
      return;
    }
    inputRef.current?.focus();
    let stale = false;
    api.desktopWindows().then(
      (r) => !stale && setWindows(r.windows),
      () => !stale && setWindows([]),
    );
    return () => {
      stale = true;
    };
  }, [open]);

  if (!enabled) return null;

  const keyword = search.trim().toLowerCase();
  const shown = (windows ?? []).filter((w) => (w.title || w.app) && (!keyword || `${w.title} ${w.app}`.toLowerCase().includes(keyword)));
  const pick = (w: DesktopWindow) => {
    setOpen(false);
    onPick(w);
  };

  return (
    <div className="capability-picker" ref={ref}>
      <button className="new-chat-chip" title="Computer Use" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MonitorIcon className="ic ic-desktop" />
        <span className="new-chat-chip-label">Computer Use</span>
      </button>
      {open && (
        <div className="menu capability-menu tab-picker-menu" role="menu">
          <input ref={inputRef} className="capability-search" value={search} placeholder="搜索窗口标题或应用…" onChange={(e) => setSearch(e.target.value)} />
          <div className="capability-list">
            <div className="tab-picker-group">
              <button
                className="capability-item tab-picker-browser"
                role="menuitem"
                title="引用桌面"
                onClick={() => {
                  setOpen(false);
                  onPickDesktop();
                }}
              >
                <span className="tab-picker-badge desktop-badge">
                  <MonitorIcon className="" />
                </span>
                <span className="capability-name">桌面</span>
                <span className="tab-picker-hint">这台电脑上的应用</span>
              </button>
              {shown.map((w) => (
                <button key={w.id} className="capability-item tab-picker-tab" role="menuitem" title={w.title ? `${w.app} — ${w.title}` : w.app} onClick={() => pick(w)}>
                  <span className="tab-picker-icon">
                    <MonitorIcon className="" />
                  </span>
                  <span className="capability-name">{w.title || w.app}</span>
                  {w.title && w.app && <span className="tab-picker-hint">{w.app}</span>}
                </button>
              ))}
              {shown.length === 0 && (
                <div className="capability-empty tab-picker-empty">{windows === null ? "加载中…" : windows.length ? "没有匹配的窗口" : "没有读到窗口"}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
