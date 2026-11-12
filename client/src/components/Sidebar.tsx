import { HostIcon, HostStatusDot } from "./HostIcon";
import { machinePath, parseRemote } from "../remote";
import { sshName, useSshConnections } from "../state/sshConnections";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { SessionListItem } from "../api";
import { useDismiss } from "./ComposerPickers";
import { SidebarToggle } from "./SidebarToggle";

/** 会话标题：网关在第一条消息时生成的 customTitle；没有时用第一条提问。不用 summary，它没有自定义标题时跟着最新一条提问变 */
/** 会话标题；第一条消息里引用的标签页 @[标题](网址)、@chrome[标题](网址) 这样的只留标题 */
export const sessionTitle = (s: SessionListItem) =>
  (s.customTitle || s.firstPrompt || s.summary || "新会话").replace(/@(?:[a-z][a-z0-9]*)?\[([^\]\n]*)\]\([^\s)]+(?: "[^"\n]*")?\)/g, "$1");

/** 项目名：工作目录的最后一级 */
/** 文件夹名（路径最后一级）；远程会话的 ssh://<id> 没有路径时是连接的名称 */
export const folderName = (dir: string) => {
  const remote = parseRemote(dir);
  if (remote && !remote.path) return sshName(remote.host);
  return dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;
};

/** 一个项目：同一个文件夹（工作目录）下的会话。Claude Code 按工作目录区分项目 */
interface FolderGroup {
  cwd: string;
  sessions: SessionListItem[];
}

const COLLAPSED_KEY = "sidebarCollapsedGroups";
const SECTION_PROJECTS = "section:projects";
const SECTION_CHATS = "section:chats";
/** 「会话」和每个项目默认列出的会话数，也是「展开更多」每次多列的个数 */
const PREVIEW_COUNT = 5;

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** 按文件夹分组，最近有活动的组排前面（sessions 已按 lastResponseAt 倒序） */
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
  /** 默认工作目录：没有 cwd 的会话按它分组（普通会话看 SessionListItem.chat，不看这个） */
  workspaceDir: string;
  currentId: string | null;
  onSelect: (id: string) => void;
  /** 新会话；cwd 是在哪个文件夹里，不传是无文件夹 */
  onNew: (cwd?: string) => void;
  /** 删除这些会话（不弹确认） */
  onDelete: (ids: string[]) => void;
  /** 改会话标题（已去掉首尾空白，非空且和原来不同） */
  onRename: (id: string, title: string) => void;
  /** 收起侧边栏；不传时不显示按钮（桌面版的在标题栏上） */
  onCollapse?: () => void;
  width: number;
}

export function Sidebar({ sessions, workspaceDir, currentId, onSelect, onNew, onDelete, onRename, onCollapse, width }: Props) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const current = sessions.find((session) => session.sessionId === currentId);
  useEffect(() => {
    if (!current) return;

    const section = current.chat ? SECTION_CHATS : SECTION_PROJECTS;
    const keysToOpen = [section, ...(!current.chat ? [current.cwd || workspaceDir] : [])];
    setCollapsed((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const key of keysToOpen) changed = next.delete(key) || changed;
      if (changed) {
        try {
          localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
        } catch {
          // 写不了就只在这次打开里生效
        }
      }
      return changed ? next : previous;
    });
  }, [current?.sessionId, current?.chat, current?.cwd, workspaceDir]);

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

  // 同 codex-app-server 的侧边栏：「项目」是选了文件夹的会话，按文件夹分组；「会话」是没选文件夹的（各有网关建的 scratch 目录）
  // 项目按名称排；项目里的会话保持 sessions 的顺序（按最后回复时间倒序），同「会话」
  const projects = groupByFolder(sessions.filter((s) => !s.chat), workspaceDir).sort(
    (a, b) => folderName(a.cwd).localeCompare(folderName(b.cwd), undefined, { numeric: true, sensitivity: "base" }) || a.cwd.localeCompare(b.cwd),
  );
  const chats = sessions.filter((s) => s.chat);
  const projectsOpen = !collapsed.has(SECTION_PROJECTS);
  const chatsOpen = !collapsed.has(SECTION_CHATS);

  // 删除都不弹确认，点了直接删
  const deleteSession = (s: SessionListItem) => onDelete([s.sessionId]);
  const deleteProject = (g: FolderGroup) => onDelete(g.sessions.map((s) => s.sessionId));

  const row = (s: SessionListItem) => (
    <SessionRow key={s.sessionId} session={s} active={s.sessionId === currentId} onSelect={onSelect} onDelete={deleteSession} onRename={onRename} />
  );

  /** 「会话」和各个项目当前列出的会话数（键是 SECTION_CHATS 或项目文件夹），没记的是默认个数；不保存，刷新后都回到默认 */
  const [shownCounts, setShownCounts] = useState<Map<string, number>>(() => new Map());
  const setShownCount = (key: string, count: number) =>
    setShownCounts((prev) => {
      const next = new Map(prev);
      if (count <= PREVIEW_COUNT) next.delete(key);
      else next.set(key, count);
      return next;
    });
  /**
   * 一组会话：默认只列前 PREVIEW_COUNT 个，「展开更多」每次多列这么多个，展开过就能「收起」回默认个数。
   * 当前会话排在后面时一直列到它为止，打开的会话不会藏在「展开更多」里
   */
  const sessionList = (key: string, items: SessionListItem[], className?: string) => {
    const pinned = items.findIndex((s) => s.sessionId === currentId) + 1;
    const count = Math.max(shownCounts.get(key) ?? PREVIEW_COUNT, pinned);
    const canExpand = items.length > count;
    const canCollapse = count > Math.max(PREVIEW_COUNT, pinned);
    return (
      <ul className={className}>
        {items.slice(0, count).map(row)}
        {(canExpand || canCollapse) && (
          <li className="list-toggle">
            {canExpand && (
              <button onClick={() => setShownCount(key, count + PREVIEW_COUNT)}>
                <ChevronIcon />
                展开更多
              </button>
            )}
            {canCollapse && (
              <button onClick={() => setShownCount(key, PREVIEW_COUNT)}>
                <ChevronIcon up />
                收起
              </button>
            )}
          </li>
        )}
      </ul>
    );
  };

  return (
    <aside className="sidebar" style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
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
            onClick: () => onDelete(projects.flatMap((g) => g.sessions.map((s) => s.sessionId))),
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
            <ProjectGroup
              key={g.cwd}
              group={g}
              open={open}
              // 展开时当前会话那一行已经高亮，项目行只在折叠、看不到当前会话时高亮
              active={!open && g.sessions.some((session) => session.sessionId === currentId)}
              onToggle={() => toggle(g.cwd)}
              onNew={onNew}
              onDelete={deleteProject}
              list={sessionList(g.cwd, g.sessions, "group-list")}
            />
          );
        })}

      <SectionHead
        className="section-gap"
        menu={[
          {
            label: "全部删除",
            danger: true,
            disabled: chats.length === 0,
            onClick: () => onDelete(chats.map((s) => s.sessionId)),
          },
        ]}
      >
        <SectionToggle label="会话" icon={<ChatIcon />} count={chats.length} expanded={chatsOpen} onClick={() => toggle(SECTION_CHATS)} />
      </SectionHead>
      {chatsOpen && chats.length === 0 && <div className="group-empty">暂无会话</div>}
      {chatsOpen && sessionList(SECTION_CHATS, chats)}
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

/** 「…」菜单：点按钮时在按钮下方、和按钮右对齐，右键时在鼠标处往右下展开（位置是视口坐标） */
function useRowMenu() {
  const [at, setAt] = useState<{ left?: number; right?: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, at !== null, () => setAt(null));
  return {
    at,
    menuRef,
    close: () => setAt(null),
    openAtButton: (e: MouseEvent<HTMLButtonElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setAt(at ? null : { right: window.innerWidth - rect.right, top: rect.bottom + 4 });
    },
    openAtPointer: (e: MouseEvent) => {
      e.preventDefault();
      setAt({ left: Math.min(e.clientX, window.innerWidth - 180), top: e.clientY });
    },
  };
}

function MoreButton({ className, label, menu }: { className: string; label: string; menu: ReturnType<typeof useRowMenu> }) {
  return (
    <button
      className={`icon-btn ${className}`}
      title="更多"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={menu.at !== null}
      // 菜单开着时按下这个按钮不算点到外面，由 onClick 收起
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        menu.openAtButton(e);
      }}
    >
      <MoreIcon />
    </button>
  );
}

function MenuPopup({ menu, items }: { menu: ReturnType<typeof useRowMenu>; items: MenuAction[] }) {
  if (!menu.at) return null;
  return (
    <div ref={menu.menuRef} className="menu context-menu" role="menu" style={{ left: menu.at.left ?? "auto", right: menu.at.right ?? "auto", top: menu.at.top }}>
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={`menu-item${item.danger ? " danger" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            menu.close();
            item.onClick();
          }}
        >
          <span className="menu-item-name">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** 分区标题行：悬停时右边出现「…」，点它或在这一行上右键弹出菜单 */
function SectionHead({ className, menu: items, children }: { className?: string; menu: MenuAction[]; children: ReactNode }) {
  const menu = useRowMenu();
  return (
    <div className={`section-title section-head${menu.at ? " menu-open" : ""}${className ? ` ${className}` : ""}`} onContextMenu={menu.openAtPointer}>
      {children}
      <MoreButton className="section-more" label="更多" menu={menu} />
      <MenuPopup menu={menu} items={items} />
    </div>
  );
}

/** 一个会话：悬停时右边出现「…」（运行中的转圈让位），点它或右键弹出菜单；重命名时这一行换成输入框，双击标题也能改 */
function SessionRow({
  session: s,
  active,
  onSelect,
  onDelete,
  onRename,
}: {
  session: SessionListItem;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (s: SessionListItem) => void;
  onRename: (id: string, title: string) => void;
}) {
  const menu = useRowMenu();
  const rowRef = useRef<HTMLLIElement>(null);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const title = sessionTitle(s);
  if (renaming)
    return (
      <li ref={rowRef} className="session-item">
        <TitleInput
          initial={title}
          onDone={(next) => {
            setRenaming(false);
            const trimmed = next?.trim();
            if (trimmed && trimmed !== title) onRename(s.sessionId, trimmed);
          }}
        />
      </li>
    );
  return (
    <li ref={rowRef} className={`session-item${menu.at ? " menu-open" : ""}`} onContextMenu={menu.openAtPointer}>
      <button
        className={`session-row${active ? " active" : ""}${s.state === "running" ? " running" : ""}`}
        onClick={() => onSelect(s.sessionId)}
        onDoubleClick={() => setRenaming(true)}
        title={title}
      >
        <span className="session-title">{title}</span>
        <span className="session-meta">{relativeTime(s.lastResponseAt)}</span>
        {s.state === "running" && <span className="session-spinner" aria-label="运行中" />}
      </button>
      <MoreButton className="row-more" label={`「${title}」的更多操作`} menu={menu} />
      <MenuPopup
        menu={menu}
        items={[
          { label: "重命名", onClick: () => setRenaming(true) },
          { label: "删除", danger: true, onClick: () => onDelete(s) },
        ]}
      />
    </li>
  );
}

/** 会话标题输入框：打开时全选；回车或点到别处是确定（onDone 给输入的内容），Esc 是取消（onDone(null)） */
function TitleInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  // 回车之后输入框卸掉还会触发一次 blur，只算第一次
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      ref={ref}
      className="session-title-input"
      aria-label="会话标题"
      defaultValue={initial}
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/** 一个项目（文件夹）：悬停时右边出现「新建会话」和「…」，「…」或右键可以删除整个项目 */
function ProjectGroup({
  group: g,
  open,
  active,
  onToggle,
  onNew,
  onDelete,
  list,
}: {
  group: FolderGroup;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  onNew: (cwd?: string) => void;
  onDelete: (g: FolderGroup) => void;
  /** 这个项目的会话列表（带「展开更多 / 收起」） */
  list: ReactNode;
}) {
  const menu = useRowMenu();
  // 远程主机上的项目：名字后面带主机名，悬停显示远端路径
  useSshConnections();
  const remote = parseRemote(g.cwd);
  return (
    <div className="group">
      <div className={`group-head${active ? " active" : ""}${menu.at ? " menu-open" : ""}`} onContextMenu={menu.openAtPointer}>
        <button className="group-toggle" onClick={onToggle} title={remote ? `${sshName(remote.host)}：${machinePath(g.cwd)}` : g.cwd}>
          <CaretIcon open={open} />
          {/* 远程主机上的项目：文件夹换成主机的系统图标（同 codex-app-server），主机名在悬停提示里 */}
          {remote ? <HostIcon hostId={remote.host} /> : <FolderIcon />}
          <span className="group-name">{folderName(g.cwd)}</span>
          {remote && <HostStatusDot hostId={remote.host} />}
        </button>
        <div className="group-actions">
          <button className="icon-btn" title="在此项目中新建会话" aria-label={`在 ${folderName(g.cwd)} 中新建会话`} onClick={() => onNew(g.cwd)}>
            <ComposeIcon />
          </button>
          <MoreButton className="group-more" label={`项目 ${folderName(g.cwd)} 的更多操作`} menu={menu} />
        </div>
        <MenuPopup menu={menu} items={[{ label: "删除项目", danger: true, onClick: () => onDelete(g) }]} />
      </div>
      {open && list}
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
    <svg className="ic ic-project" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 6.1 8 2.8l6 3.3L8 9.4 2 6.1Z" fill="currentColor" fillOpacity="0.2" />
      <path d="m2.4 8.8 5.6 3.1 5.6-3.1M2.4 11.2 8 14.3l5.6-3.1" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg className="ic ic-compose" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
    <svg className="ic ic-chat" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5h-.5a1 1 0 0 1-1-1z" fill="currentColor" fillOpacity="0.15" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="ic ic-folder" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path fill="currentColor" fillOpacity="0.2" d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  );
}

/** 「展开更多」的向下箭头，「收起」的向上 */
function ChevronIcon({ up }: { up?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
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

