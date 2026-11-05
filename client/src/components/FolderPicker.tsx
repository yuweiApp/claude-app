import { useEffect, useRef, useState } from "react";
import { desktop } from "../desktop";
import { FolderPickerDialog } from "./FolderPickerDialog";
import { folderName } from "./Sidebar";

interface Props {
  /** 选中的文件夹，null 是没选（在默认工作目录里跑，侧边栏归到「无文件夹」） */
  value: string | null;
  /** 最近用过的文件夹（会话的工作目录） */
  recent: string[];
  onChange: (cwd: string | null) => void;
}

/**
 * 新会话输入框上面的「选择文件夹」（同 codex-app-server 新聊天页输入框上面那一栏）：
 * 点开是最近用过的文件夹，「选择文件夹…」在桌面版里弹系统的文件夹对话框，网页里打开对话框浏览网关这台机器上的文件夹；
 * 没有别的可选时不弹菜单，点按钮直接选
 */
export function FolderPicker({ value, recent, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (cwd: string | null) => {
    onChange(cwd);
    setOpen(false);
  };

  const browse = () => {
    setOpen(false);
    if (!desktop) return setBrowsing(true);
    void desktop.pickFolder(value ?? recent[0]).then((dir) => dir && onChange(dir));
  };
  const onlyBrowse = recent.length === 0 && value === null;

  return (
    <div className="folder-picker" ref={ref}>
      <button className="new-chat-chip" onClick={() => (onlyBrowse ? browse() : setOpen((o) => !o))} title={value ?? "选择会话在哪个文件夹里运行"}>
        <FolderIcon />
        <span className="new-chat-chip-label">{value ? folderName(value) : "选择文件夹"}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          {recent.length > 0 && <div className="menu-label">最近</div>}
          {recent.map((dir) => (
            <button key={dir} className={`menu-item${dir === value ? " selected" : ""}`} onClick={() => pick(dir)} title={dir}>
              <span className="menu-item-name">{folderName(dir)}</span>
              <span className="menu-item-sub">{dir}</span>
            </button>
          ))}
          {value !== null && (
            <button className="menu-item" onClick={() => pick(null)}>
              <span className="menu-item-name">不选文件夹</span>
            </button>
          )}
          {(recent.length > 0 || value !== null) && <div className="menu-divider" />}
          <button className="menu-item" onClick={browse}>
            <span className="menu-item-name">选择文件夹…</span>
          </button>
        </div>
      )}
      {browsing && (
        <FolderPickerDialog
          initial={value ?? recent[0]}
          onClose={() => setBrowsing(false)}
          onPick={(dir) => {
            setBrowsing(false);
            onChange(dir);
          }}
        />
      )}
    </div>
  );
}

export function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  );
}
