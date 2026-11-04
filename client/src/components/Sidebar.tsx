import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { SessionListItem } from "../api";
import { useDismiss } from "./ComposerPickers";
import { ConfirmDialog } from "./ConfirmDialog";
import { SidebarToggle } from "./SidebarToggle";

/** 会话标题：SDKSessionInfo.summary 就是 SDK 给的显示标题（自定义标题、自动摘要或第一条提问） */
export const sessionTitle = (s: SessionListItem) => s.summary || s.firstPrompt || "新会话";

/** 项目名：工作目录的最后一级 */
export const folderName = (dir: string) => dir.replace(/\/+$/, "").split("/").pop() || dir;

/** 一个项目：同一个文件夹（工作目录）下的会话。Claude Code 按工作目录区分项目 */
interface FolderGroup {
  cwd: string;
  sessions: SessionListItem[];
}

const COLLAPSED_KEY = "sidebarCollapsedGroups";
const SECTION_PROJECTS = "section:projects";
const SECTION_CHATS = "section:chats";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** 按文件夹分组，最近有活动的组排前面（sessions 已按 lastModified 倒序） */
export function groupByFolder(sessions: SessionListItem[], workspaceDir: string): FolderGroup[] {
  const groups: FolderGroup[] = [];
  for (const s of sessions) {
    const cwd = s.cwd || workspaceDir;
    const group = groups.find((g) => g.cwd === cwd);
    if (group) group.sessions.push(s);
    else groups.push({ cwd, sessions: [s] });
  }
  return groups;
}

interface Props {
  sessions: SessionListItem[];
  /** 默认工作目录：没选文件夹的会话在这里跑，列在「会话」里；其他工作目录各是一个「项目」 */
  workspaceDir: string;
  currentId: string | null;
  onSelect: (id: string) => void;
  /** 新会话；cwd 是在哪个文件夹里，不传是无文件夹 */
  onNew: (cwd?: string) => void;
  /** 删除这些会话（已经确认过） */
  onDelete: (ids: string[]) => void;
  /** 收起侧边栏；不传时不显示按钮（桌面版的在标题栏上） */
  onCollapse?: () => void;
}

export function Sidebar({ sessions, workspaceDir, currentId, onSelect, onNew, onDelete, onCollapse }: Props) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  /** 等用户确认的删除 */
  const [pendingDelete, setPendingDelete] = useState<{ title: string; message: string; ids: string[] } | null>(null);
  const toggle = (key: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // 写不了就只在这次打开里生效
      }
      return next;
    });

  // 同 codex-app-server 的侧边栏：「项目」是选了文件夹的会话，按文件夹分组；「会话」是没选文件夹（默认工作目录）的
  const projects = groupByFolder(sessions, workspaceDir).filter((g) => g.cwd !== workspaceDir);
  const chats = sessions.filter((s) => !s.cwd || s.cwd === workspaceDir);
  const projectsOpen = !collapsed.has(SECTION_PROJECTS);
  const chatsOpen = !collapsed.has(SECTION_CHATS);

  const row = (s: SessionListItem) => (
    <li key={s.sessionId}>
      <button
        className={`session-row${s.sessionId === currentId ? " active" : ""}${s.state === "running" ? " running" : ""}`}
        onClick={() => onSelect(s.sessionId)}
        title={sessionTitle(s)}
      >
        <span className="session-title">{sessionTitle(s)}</span>
        <span className="session-meta">{relativeTime(s.lastModified)}</span>
        {s.state === "running" && <span className="session-spinner" aria-label="运行中" />}
      </button>
    </li>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        {onCollapse && <SidebarToggle collapsed={false} onToggle={onCollapse} />}
        <button className="nav-item" onClick={() => onNew()}>
          <ComposeIcon />
          新会话
        </button>
      </div>

      <SectionHead
        menu={[
          {
            label: "全部删除",
            danger: true,
            disabled: projects.length === 0,
            onClick: () => {
              const ids = projects.flatMap((g) => g.sessions.map((s) => s.sessionId));
              setPendingDelete({
                title: "删除全部项目的会话",
                message: `将删除 ${projects.length} 个项目下的 ${ids.length} 个会话，会话记录一起删除，不能恢复。文件夹里的文件不受影响。`,
                ids,
              });
            },
          },
        ]}
      >
        <SectionToggle label="项目" icon={<ProjectsIcon />} count={projects.length} expanded={projectsOpen} onClick={() => toggle(SECTION_PROJECTS)} />
      </SectionHead>
      {projectsOpen && projects.length === 0 && <div className="group-empty">暂无项目，新会话时选择文件夹</div>}
      {projectsOpen &&
        projects.map((g) => {
          const open = !collapsed.has(g.cwd);
          return (
            <div key={g.cwd} className="group">
              <div className="group-head">
                <button className="group-toggle" onClick={() => toggle(g.cwd)} title={g.cwd}>
                  <CaretIcon open={open} />
                  <FolderIcon />
                  <span className="group-name">{folderName(g.cwd)}</span>
                </button>
                <div className="group-actions">
                  <button className="icon-btn" title="在此项目中新建会话" aria-label={`在 ${folderName(g.cwd)} 中新建会话`} onClick={() => onNew(g.cwd)}>
                    <ComposeIcon />
                  </button>
                </div>
              </div>
              {open && <ul className="group-list">{g.sessions.map(row)}</ul>}
            </div>
          );
        })}

      <SectionHead
        className="section-gap"
        menu={[
          { label: "新建会话", onClick: () => onNew() },
          {
            label: "全部删除",
            danger: true,
            disabled: chats.length === 0,
            onClick: () => {
              setPendingDelete({
                title: "删除全部会话",
                message: `将删除「会话」里的 ${chats.length} 个会话，会话记录一起删除，不能恢复。`,
                ids: chats.map((s) => s.sessionId),
              });
            },
          },
        ]}
      >
        <SectionToggle label="会话" icon={<ChatIcon />} count={chats.length} expanded={chatsOpen} onClick={() => toggle(SECTION_CHATS)} />
      </SectionHead>
      {chatsOpen && chats.length === 0 && <div className="group-empty">暂无会话</div>}
      {chatsOpen && <ul>{chats.map(row)}</ul>}
      {pendingDelete && (
        <ConfirmDialog
          title={pendingDelete.title}
          message={pendingDelete.message}
          confirmLabel="全部删除"
          onConfirm={() => {
            onDelete(pendingDelete.ids);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </aside>
  );
}

/** 相对时间：刚刚、N 分钟前、N 小时前、N 天前，更早的显示日期（同 codex-app-server 的 relativeTime；ms 是毫秒） */
function relativeTime(ms: number) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ms).toLocaleDateString();
}

interface MenuAction {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** 分区标题行：悬停时右边出现「…」，点它或在这一行上右键弹出菜单 */
function SectionHead({ className, menu, children }: { className?: string; menu: MenuAction[]; children: ReactNode }) {
  // 菜单位置（视口坐标）：点「…」时在按钮下方、和按钮右对齐，右键时在鼠标处往右下展开
  const [at, setAt] = useState<{ left?: number; right?: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, at !== null, () => setAt(null));

  const openAtButton = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setAt(at ? null : { right: window.innerWidth - rect.right, top: rect.bottom + 4 });
  };
  const openAtPointer = (e: MouseEvent) => {
    e.preventDefault();
    setAt({ left: Math.min(e.clientX, window.innerWidth - 180), top: e.clientY });
  };

  return (
    <div className={`section-title section-head${at ? " menu-open" : ""}${className ? ` ${className}` : ""}`} onContextMenu={openAtPointer}>
      {children}
      <button
        className="icon-btn section-more"
        title="更多"
        aria-label="更多"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        // 菜单开着时按下这个按钮不算点到外面，由 onClick 收起
        onMouseDown={(e) => e.stopPropagation()}
        onClick={openAtButton}
      >
        <MoreIcon />
      </button>
      {at && (
        <div ref={menuRef} className="menu context-menu" role="menu" style={{ left: at.left ?? "auto", right: at.right ?? "auto", top: at.top }}>
          {menu.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`menu-item${item.danger ? " danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                setAt(null);
                item.onClick();
              }}
            >
              <span className="menu-item-name">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionToggle({ label, icon, count, expanded, onClick }: { label: string; icon: ReactNode; count: number; expanded: boolean; onClick: () => void }) {
  return (
    <button className="section-toggle" aria-expanded={expanded} onClick={onClick}>
      <span className="section-icon">{icon}</span>
      <span className="section-label">{label}</span>
      <span className="section-count">{count}</span>
      <span className="section-spacer" />
      <CaretIcon open={expanded} />
    </button>
  );
}

// 图标同 codex-app-server 的 client/src/icons（compose、projects-stack、chat-bubble、folder、group-caret）

function ProjectsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 6.1 8 2.8l6 3.3L8 9.4 2 6.1Z" fill="currentColor" fillOpacity="0.12" />
      <path d="m2.4 8.8 5.6 3.1 5.6-3.1M2.4 11.2 8 14.3l5.6-3.1" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 8.5v4a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5h4M11.8 2.2a1.2 1.2 0 0 1 1.7 1.7L8.2 9.2l-2.4.7.7-2.4z" />
    </svg>
  );
}


function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5h-.5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  );
}

function CaretIcon({ open }: { open: boolean }) {
  return (
    <svg className={`caret${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

