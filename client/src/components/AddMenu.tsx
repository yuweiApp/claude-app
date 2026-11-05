import { useRef, useState } from "react";
import { useDismiss } from "./ComposerPickers";

/** 输入框左下角的「＋」：点开是添加菜单，目前只有上传文件 */
export function AddMenu({ onUpload }: { onUpload: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  return (
    <div className="add-menu" ref={ref}>
      <button className="icon-btn composer-add" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="添加" aria-label="添加">
        ＋
      </button>
      {open && (
        <div className="menu add-menu-list" role="menu">
          <div className="menu-label">添加</div>
          <button
            className="add-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onUpload();
            }}
          >
            <PaperclipIcon />
            <span className="add-menu-name">文件</span>
            <span className="add-menu-desc">上传图片或文件</span>
          </button>
        </div>
      )}
    </div>
  );
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m13.5 7.5-5.6 5.6a3.3 3.3 0 0 1-4.7-4.7l5.9-5.9a2.2 2.2 0 0 1 3.1 3.1l-5.9 5.9a1.1 1.1 0 0 1-1.6-1.6l5.4-5.4" />
    </svg>
  );
}
