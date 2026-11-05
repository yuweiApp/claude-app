import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { api } from "../api";
import { getDraft, setDraft, useHasDraft } from "../state/fileDrafts";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileBrowser } from "./FileBrowser";
import { FileTypeIcon } from "./FileTypeIcon";

// xterm 体积大，打开终端时再加载
const TerminalView = lazy(() => import("./TerminalView").then((m) => ({ default: m.TerminalView })));

/**
 * 右侧面板的一个标签页：新标签页（选工具）、文件、终端。
 * 文件标签同 codex-app-server：path 为 null 是「打开文件」（目录树 + 提示）；单击目录树里的文件是预览打开（transient，标签名斜体，
 * 再单击别的文件会换掉它），双击文件、双击标签、改了内容就固定下来
 */
export type PanelTab =
  | { id: string; kind: "new" }
  | { id: string; kind: "files"; path: string | null; transient: boolean }
  | { id: string; kind: "terminal"; terminalId: string; label: string };

/** 一个项目文件夹的面板：标签页和当前选中的 */
export interface PanelState {
  tabs: PanelTab[];
  active: string;
}

export function newPanelState(): PanelState {
  const tab: PanelTab = { id: crypto.randomUUID(), kind: "new" };
  return { tabs: [tab], active: tab.id };
}

const WIDTH_KEY = "sidePanelWidth";
const MIN_WIDTH = 320;
/** 打开面板时对话区至少留这么宽 */
const CHAT_MIN_WIDTH = 420;

function initialWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (n >= MIN_WIDTH) return n;
  } catch {
    // localStorage 不可用
  }
  return Math.round(window.innerWidth * 0.42);
}

interface Props {
  cwd: string;
  state: PanelState;
  onChange: (update: (state: PanelState) => PanelState) => void;
  onClose: () => void;
}

/** 对话区右边的面板（参照 codex-app-server 的 SidePanel）：标签页，新标签页里选「文件」「终端」 */
export function SidePanel({ cwd, state, onChange, onClose }: Props) {
  const [width, setWidth] = useState(initialWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  // 能用的宽度是对话区加面板（侧边栏开着时比窗口窄），窗口或侧边栏变了要重新算
  const [available, setAvailable] = useState(window.innerWidth);
  useEffect(() => {
    const parent = asideRef.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setAvailable(parent.clientWidth));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  const maxWidth = () => Math.max(MIN_WIDTH, available - CHAT_MIN_WIDTH);
  const clampWidth = (n: number) => Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(n)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(clampWidth(drag.current.width - (e.clientX - drag.current.x)));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // 忽略
    }
  };

  // 和网关上这个项目的终端对齐（每 2 秒）：刷新页面后还开着的、模型用 run_in_terminal 开的补成标签页（不抢当前标签），
  // 模型关掉的去掉，标题跟着网关的（模型开的终端有标题）
  const seen = useRef(new Set<string>());
  useEffect(() => {
    let stale = false;
    const sync = () =>
      api.terminals(cwd).then((list) => {
        if (stale) return;
        const ids = new Set(list.map((t) => t.id));
        // 之前见过、现在没了的才算被关掉（刚开的终端可能还没出现在这次的列表里）
        const gone = new Set([...seen.current].filter((id) => !ids.has(id)));
        seen.current = ids;
        onChange((s) => {
          let changed = false;
          let tabs = s.tabs.flatMap((tab): PanelTab[] => {
            if (tab.kind !== "terminal") return [tab];
            if (gone.has(tab.terminalId)) {
              changed = true;
              return [];
            }
            const title = list.find((t) => t.id === tab.terminalId)?.title;
            if (title && title !== tab.label) {
              changed = true;
              return [{ ...tab, label: title }];
            }
            return [tab];
          });
          const have = new Set(tabs.flatMap((t) => (t.kind === "terminal" ? [t.terminalId] : [])));
          const missing = list.filter((t) => t.status === "running" && !have.has(t.id));
          let active = s.active;
          if (missing.length) {
            changed = true;
            const added = missing.map((t, i): PanelTab => ({ id: crypto.randomUUID(), kind: "terminal", terminalId: t.id, label: t.title ?? terminalLabel(tabs, i) }));
            // 只有一个空的新标签页时直接换掉
            const onlyNew = tabs.length === 1 && tabs[0]!.kind === "new";
            tabs = onlyNew ? added : [...tabs, ...added];
            if (onlyNew) active = added[0]!.id;
          }
          if (!changed) return s;
          if (!tabs.length) return newPanelState();
          if (!tabs.some((t) => t.id === active)) active = tabs[0]!.id;
          return { tabs, active };
        });
      }, () => undefined);
    void sync();
    const timer = setInterval(() => void sync(), 2000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [cwd]);

  const select = (id: string) => onChange((s) => ({ ...s, active: id }));
  const addTab = () => {
    const tab: PanelTab = { id: crypto.randomUUID(), kind: "new" };
    onChange((s) => ({ tabs: [...s.tabs, tab], active: tab.id }));
  };
  // 有没保存的修改的文件标签：先问
  const [confirmClose, setConfirmClose] = useState<PanelTab | null>(null);
  const requestClose = (tab: PanelTab) => {
    if (tab.kind === "files" && tab.path !== null && getDraft(cwd, tab.path) !== undefined) setConfirmClose(tab);
    else closeTab(tab);
  };
  const closeTab = (tab: PanelTab) => {
    if (tab.kind === "terminal") void api.closeTerminal(tab.terminalId).catch(() => undefined);
    if (tab.kind === "files" && tab.path !== null) setDraft(cwd, tab.path, undefined);
    onChange((s) => {
      const index = s.tabs.findIndex((t) => t.id === tab.id);
      const tabs = s.tabs.filter((t) => t.id !== tab.id);
      if (!tabs.length) return newPanelState();
      const active = s.active === tab.id ? tabs[Math.min(index, tabs.length - 1)]!.id : s.active;
      return { tabs, active };
    });
  };
  /** 新标签页里选了工具：这个标签页变成那个工具 */
  const replaceTab = (id: string, tab: PanelTab) =>
    onChange((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? tab : t)), active: tab.id }));
  /**
   * 在某个文件标签的目录树里选了文件（同 codex-app-server）：已经开着就切过去；
   * 这个标签是「打开文件」或预览打开的，就在这个标签里换；否则换掉别处预览打开的那个，没有就接在后面新开一个
   */
  const openFile = (from: string, path: string, pin: boolean) =>
    onChange((s) => {
      const open = s.tabs.find((t) => t.kind === "files" && t.path === path);
      const set = (id: string, tab: PanelTab) => ({ tabs: s.tabs.map((t) => (t.id === id ? tab : t)), active: id });
      if (open) return set(open.id, { ...open, transient: open.kind === "files" && open.transient && !pin } as PanelTab);
      const here = s.tabs.find((t) => t.id === from);
      if (here?.kind === "files" && (here.path === null || here.transient)) return set(here.id, { ...here, path, transient: !pin });
      const preview = s.tabs.find((t) => t.kind === "files" && t.transient);
      if (preview) return set(preview.id, { ...preview, path, transient: !pin } as PanelTab);
      const tab: PanelTab = { id: crypto.randomUUID(), kind: "files", path, transient: !pin };
      const index = s.tabs.findIndex((t) => t.id === from);
      const tabs = [...s.tabs];
      tabs.splice(index < 0 ? tabs.length : index + 1, 0, tab);
      return { tabs, active: tab.id };
    });
  /** 固定预览打开的文件标签 */
  const pin = (id: string) =>
    onChange((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id && t.kind === "files" && t.transient ? { ...t, transient: false } : t)) }));
  const openTerminal = async (id: string) => {
    try {
      const terminal = await api.createTerminal(cwd, 80, 24);
      onChange((s) => {
        const tab: PanelTab = { id, kind: "terminal", terminalId: terminal.id, label: terminalLabel(s.tabs.filter((t) => t.id !== id), 0) };
        return { tabs: s.tabs.map((t) => (t.id === id ? tab : t)), active: id };
      });
    } catch (err) {
      window.alert((err as Error).message);
    }
  };

  return (
    <aside className="side-panel" ref={asideRef} style={{ width: Math.min(width, maxWidth()) }}>
      <div
        className="side-panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整右侧面板宽度"
        title="拖动调整宽度"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="panel-head">
        <div className="panel-tabs">
          {state.tabs.map((tab) => (
            <TabButton
              key={tab.id}
              cwd={cwd}
              tab={tab}
              active={tab.id === state.active}
              onSelect={() => select(tab.id)}
              onPin={() => pin(tab.id)}
              onClose={() => requestClose(tab)}
            />
          ))}
          <button className="icon-btn panel-head-btn" title="新标签页" aria-label="新标签页" onClick={addTab}>
            ＋
          </button>
        </div>
        <button className="icon-btn panel-head-btn active" title="收起面板" aria-label="收起面板" onClick={onClose}>
          <PanelIcon open />
        </button>
      </div>
      <div className="panel-body">
        {state.tabs.map((tab) => (
          // 不在前面的标签页也留着（终端不断开、文件树不重新加载），只是藏起来
          <div key={tab.id} className="panel-page" hidden={tab.id !== state.active}>
            {tab.kind === "new" && (
              <NewTab
                onFiles={() => replaceTab(tab.id, { id: tab.id, kind: "files", path: null, transient: false })}
                onTerminal={() => void openTerminal(tab.id)}
              />
            )}
            {tab.kind === "files" && (
              <FileBrowser
                cwd={cwd}
                path={tab.path}
                active={tab.id === state.active}
                onSelectFile={(path, pinned) => openFile(tab.id, path, pinned)}
                onEdited={() => pin(tab.id)}
              />
            )}
            {tab.kind === "terminal" && (
              <Suspense fallback={<div className="panel-empty">正在加载终端…</div>}>
                <TerminalView terminalId={tab.terminalId} active={tab.id === state.active} />
              </Suspense>
            )}
          </div>
        ))}
      </div>
      {confirmClose && (
        <ConfirmDialog
          title="放弃未保存的修改？"
          message={`「${tabLabel(confirmClose)}」有未保存的修改，关闭后会丢失。`}
          confirmLabel="不保存，关闭"
          onConfirm={() => {
            closeTab(confirmClose);
            setConfirmClose(null);
          }}
          onCancel={() => setConfirmClose(null)}
        />
      )}
    </aside>
  );
}

/** 「终端」「终端 2」…：取没被占用的最小序号 */
function terminalLabel(tabs: PanelTab[], offset: number): string {
  const used = new Set(tabs.flatMap((t) => (t.kind === "terminal" ? [t.label] : [])));
  let n = 1;
  for (let skipped = 0; ; n++) {
    const label = n === 1 ? "终端" : `终端 ${n}`;
    if (used.has(label)) continue;
    if (skipped++ === offset) return label;
  }
}

function tabLabel(tab: PanelTab): string {
  switch (tab.kind) {
    case "new":
      return "新标签页";
    case "files":
      // 没选文件时叫「打开文件」（同 codex-app-server）
      return tab.path === null ? "打开文件" : tab.path.split("/").pop() || tab.path;
    case "terminal":
      return tab.label;
  }
}

function tabIcon(tab: PanelTab): ReactNode {
  switch (tab.kind) {
    case "new":
      return <PlusSquareIcon />;
    case "files":
      return tab.path === null ? <FilesIcon /> : <FileTypeIcon name={tab.path.split("/").pop() || tab.path} />;
    case "terminal":
      return <TerminalIcon />;
  }
}

/** 标签：预览打开的文件是斜体（双击固定），有没保存的修改时关闭按钮的位置显示圆点（鼠标移上去变回 ×） */
function TabButton({ cwd, tab, active, onSelect, onPin, onClose }: { cwd: string; tab: PanelTab; active: boolean; onSelect: () => void; onPin: () => void; onClose: () => void }) {
  const unsaved = useHasDraft(cwd, tab.kind === "files" ? tab.path : null);
  const transient = tab.kind === "files" && tab.transient;
  return (
    <div
      className={`panel-tab${active ? " active" : ""}${transient ? " temporary" : ""}`}
      title={tab.kind === "files" && tab.path ? (transient ? `${tab.path}\n预览打开，双击标签固定` : tab.path) : undefined}
      onClick={onSelect}
      onDoubleClick={onPin}
      onAuxClick={(e) => e.button === 1 && onClose()}
    >
      <span className="panel-tab-icon">{tabIcon(tab)}</span>
      <span className="panel-tab-label">{tabLabel(tab)}</span>
      <button
        className={`panel-tab-close${unsaved ? " unsaved" : ""}`}
        title={unsaved ? "有未保存的修改（Ctrl+S 保存），关闭时会问" : "关闭"}
        aria-label="关闭"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <span className="tab-close-x">×</span>
        {unsaved && <span className="tab-unsaved-dot" />}
      </button>
    </div>
  );
}

/** 新标签页：选一个工具 */
function NewTab({ onFiles, onTerminal }: { onFiles: () => void; onTerminal: () => void }) {
  return (
    <div className="panel-new-tab">
      <div className="panel-section-title">工具</div>
      <div className="panel-tools">
        <button className="panel-tool" onClick={onFiles}>
          <FilesIcon />
          <span>文件</span>
        </button>
        <button className="panel-tool" onClick={onTerminal}>
          <TerminalIcon />
          <span>终端</span>
        </button>
      </div>
    </div>
  );
}

/** 右侧面板图标（参照 codex-app-server）：打开着是一条贯穿的分隔线，收起着是靠右的一小段竖线 */
export function PanelIcon({ open = false }: { open?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      {open ? <line x1="10" y1="2.5" x2="10" y2="13.5" /> : <line x1="11.5" y1="5.75" x2="11.5" y2="10.25" />}
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5zM9 1.5V5h3.5" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
    </svg>
  );
}

function PlusSquareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
      <path d="M8 5.5v5M5.5 8h5" />
    </svg>
  );
}

