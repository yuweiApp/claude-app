/** 收起 / 展开侧边栏的按钮，图标同 codex-app-server（client/src/icons/sidebar.svg、sidebar-collapsed.svg） */
export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "展开侧边栏" : "收起侧边栏";
  return (
    <button className="icon-btn" title={label} aria-label={label} onClick={onToggle}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.25" />
        {collapsed ? <path d="M6 7.25v5.5" /> : <path d="M7.75 3.75v12.5" />}
      </svg>
    </button>
  );
}
