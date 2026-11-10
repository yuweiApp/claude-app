import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { api } from "../api";
import { desktop, type BrowserTabInfo } from "../desktop";
import { BrowserTab, BrowserToolbar, GlobeIcon, SiteIcon } from "./BrowserTab";
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
  | { id: string; kind: "terminal"; terminalId: string; label: string }
  /**
   * 内置浏览器（只有桌面版有）：标签页属于对话会话，面板里只显示当前会话的。
   * key 是外壳给的、不随重启变的编号：桌面版重启后标签页恢复了但 browserId 是新的，按 key 对回来
   */
  | { id: string; kind: "browser"; browserId: string; sessionId: string; key?: string };

/** 一个项目文件夹的面板：标签页和当前选中的 */
export interface PanelState {
  tabs: PanelTab[];
  active: string;
}

export function newPanelState(): PanelState {
  const tab: PanelTab = { id: crypto.randomUUID(), kind: "new" };
  return { tabs: [tab], active: tab.id };
}

/**
 * 在面板里打开文件（同 codex-app-server）：已经开着就切过去；from 这个标签是「新标签页」「打开文件」或预览打开的，就在这个标签里换；
 * 否则换掉别处预览打开的那个，没有就接在 from 后面新开一个。from 是目录树所在的标签，或者（回复里的链接）当前标签
 */
export function withFileOpen(s: PanelState, from: string, path: string, pin: boolean): PanelState {
  const open = s.tabs.find((t) => t.kind === "files" && t.path === path);
  const set = (id: string, tab: PanelTab) => ({ tabs: s.tabs.map((t) => (t.id === id ? tab : t)), active: id });
  if (open) return set(open.id, { ...open, transient: open.kind === "files" && open.transient && !pin } as PanelTab);
  const here = s.tabs.find((t) => t.id === from);
  if (here?.kind === "new") return set(here.id, { id: here.id, kind: "files", path, transient: !pin });
  if (here?.kind === "files" && (here.path === null || here.transient)) return set(here.id, { ...here, path, transient: !pin });
  const preview = s.tabs.find((t) => t.kind === "files" && t.transient);
  if (preview) return set(preview.id, { ...preview, path, transient: !pin } as PanelTab);
  const tab: PanelTab = { id: crypto.randomUUID(), kind: "files", path, transient: !pin };
  const index = s.tabs.findIndex((t) => t.id === from);
  const tabs = [...s.tabs];
  tabs.splice(index < 0 ? tabs.length : index + 1, 0, tab);
  return { tabs, active: tab.id };
}

/**
 * 回复里的文件夹链接：切到「打开文件」标签（只有目录树，没打开文件）在树里定位。有就用开着的那个；
 * from（当前标签）是新标签页就在它里面换；否则接在 from 后面新开一个，不动别的标签里打开的文件
 */
export function withFolderTab(s: PanelState, from: string): PanelState {
  const open = s.tabs.find((t) => t.kind === "files" && t.path === null);
  if (open) return { ...s, active: open.id };
  const here = s.tabs.find((t) => t.id === from);
  if (here?.kind === "new") return { tabs: s.tabs.map((t) => (t.id === from ? { id: t.id, kind: "files", path: null, transient: false } : t)), active: from };
  const tab: PanelTab = { id: crypto.randomUUID(), kind: "files", path: null, transient: false };
  const index = s.tabs.findIndex((t) => t.id === from);
  const tabs = [...s.tabs];
  tabs.splice(index < 0 ? tabs.length : index + 1, 0, tab);
  return { tabs, active: tab.id };
}

const WIDTH_KEY = "sidePanelWidth";
const MIN_WIDTH = 320;
/** 打开面板时对话区至少留这么宽 */
const CHAT_MIN_WIDTH = 420;
/** 拖到最小宽度后再往右这么多就收起（同左侧分割线），免得刚好拖到最小时误收 */
const COLLAPSE_MARGIN = 30;

const defaultWidth = () => Math.round(window.innerWidth * 0.42);

function initialWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (n >= MIN_WIDTH) return n;
  } catch {
    // localStorage 不可用
  }
  return defaultWidth();
}

function saveWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // 忽略
  }
}

interface Props {
  cwd: string;
  /** 当前会话（新会话页没有右侧面板，发出第一条消息、会话建好后才有） */
  sessionId: string;
  state: PanelState;
  onChange: (update: (state: PanelState) => PanelState) => void;
  onClose: () => void;
}

/** 对话区右边的面板（参照 codex-app-server 的 SidePanel）：标签页，新标签页里选「文件」「终端」 */
export function SidePanel({ cwd, sessionId, state, onChange, onClose }: Props) {
  const [width, setWidth] = useState(initialWidth);
  const drag = useRef<{ x: number; width: number; latest: number } | null>(null);
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

  // 左边缘的分割线，和侧边栏的一样：拖动调宽度，拖过最小宽度时收起面板，双击恢复默认，也可以用左右方向键
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width, latest: width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = drag.current.width - (e.clientX - drag.current.x);
    if (next < MIN_WIDTH - COLLAPSE_MARGIN) {
      // 宽度回到拖动之前，下次打开还是原来的样子
      setWidth(drag.current.width);
      drag.current = null;
      onClose();
      return;
    }
    drag.current.latest = clampWidth(next);
    setWidth(drag.current.latest);
  };
  const onPointerUp = () => {
    if (drag.current) saveWidth(drag.current.latest);
    drag.current = null;
  };
  const commitWidth = (n: number) => {
    setWidth(n);
    saveWidth(n);
  };
  const onResizerKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    // 面板在右边：往左是变宽
    commitWidth(clampWidth(Math.min(width, maxWidth()) + (e.key === "ArrowLeft" ? 20 : -20)));
  };

  // 和网关上这个项目的终端对齐（每 2 秒）：刷新页面后还开着的、模型用 run_in_terminal 开的补成标签页（不抢当前标签），
  // 模型关掉的去掉，标题跟着网关的（模型开的终端有标题）
  const seen = useRef(new Set<string>());
  // 第一次对齐之前不接终端：上次保存的终端标签可能在网关上已经没有了
  const [terminalsChecked, setTerminalsChecked] = useState(false);
  useEffect(() => {
    let stale = false;
    let first = true;
    const sync = () =>
      api.terminals(cwd).then((list) => {
        if (stale) return;
        const ids = new Set(list.map((t) => t.id));
        // 之前见过、现在没了的才算被关掉（刚开的终端可能还没出现在这次的列表里）；
        // 第一次对齐时，从上次保存的面板状态里恢复的终端标签，网关上已经没有的（网关重启过）也去掉
        const gone = new Set([...seen.current].filter((id) => !ids.has(id)));
        const initial = first;
        first = false;
        seen.current = ids;
        onChange((s) => {
          let changed = false;
          let tabs = s.tabs.flatMap((tab): PanelTab[] => {
            if (tab.kind !== "terminal") return [tab];
            if (gone.has(tab.terminalId) || (initial && !ids.has(tab.terminalId))) {
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
        if (initial) setTerminalsChecked(true);
      }, () => !stale && setTerminalsChecked(true));
    void sync();
    const timer = setInterval(() => void sync(), 2000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [cwd]);

  // 内置浏览器：外壳推来全部标签页。当前会话的、面板里还没有的（AI 开的、刷新页面前开的）补成标签页（不抢当前标签），关掉的去掉。
  // null 是还没从外壳拿到列表
  const browserApi = desktop?.browser;
  const [browserTabs, setBrowserTabs] = useState<Map<string, BrowserTabInfo> | null>(null);
  useEffect(() => {
    if (!browserApi) return;
    const apply = (list: BrowserTabInfo[]) => setBrowserTabs(new Map(list.map((t) => [t.id, t])));
    void browserApi.list().then(apply);
    const offTabs = browserApi.onTabs(apply);
    // AI 切了标签页、用户在网页里点开了新页面（当前会话的），面板跟着切。刚开的标签页可能还没补进面板（标签页列表还没推来），先记着，补上时再切。
    // 更新函数里不改 ref：StrictMode 下会调两次
    const offActivate = browserApi.onActivate((browserId) => {
      pendingActivate.current = browserId;
      onChange((s) => {
        const tab = s.tabs.find((t) => t.kind === "browser" && t.browserId === browserId);
        return tab ? { ...s, active: tab.id } : s;
      });
    });
    return () => {
      offTabs();
      offActivate();
    };
  }, [browserApi]);
  /** 要切过去、但面板里可能还没有的标签页（外壳的 browserId），外壳的列表里有了就交给这次补标签页 */
  const pendingActivate = useRef<string | null>(null);
  useEffect(() => {
    // 拿到外壳的列表之前不能据此删标签页
    if (!browserApi || !browserTabs) return;
    const byKey = new Map([...browserTabs.values()].map((b) => [b.key, b]));
    const want = pendingActivate.current;
    if (want && browserTabs.has(want)) pendingActivate.current = null;
    onChange((s) => {
      let changed = false;
      let tabs = s.tabs.flatMap((t): PanelTab[] => {
        if (t.kind !== "browser") return [t];
        if (browserTabs.has(t.browserId)) {
          if (t.key) return [t];
          // 旧的面板状态没记 key：补上
          changed = true;
          return [{ ...t, key: browserTabs.get(t.browserId)!.key }];
        }
        // 桌面版重启后恢复的标签页：id 换了，按 key 对回来
        const restored = t.key ? byKey.get(t.key) : undefined;
        changed = true;
        return restored ? [{ ...t, browserId: restored.id, sessionId: restored.sessionId }] : [];
      });
      if (sessionId) {
        const have = new Set(tabs.flatMap((t) => (t.kind === "browser" ? [t.browserId] : [])));
        const missing = [...browserTabs.values()].filter((b) => b.sessionId === sessionId && !have.has(b.id));
        if (missing.length) {
          changed = true;
          const added = missing.map((b): PanelTab => ({ id: crypto.randomUUID(), kind: "browser", browserId: b.id, sessionId: b.sessionId, key: b.key }));
          // 已经要切过去的那个（切换通知比标签页列表先到）
          const wanted = want ? added.find((t) => t.kind === "browser" && t.browserId === want) : undefined;
          // 当前会话正看着的是空的新标签页：就地换成第一个，切过去（同渲染时的 activeId：当前标签看不见就算第一个看得见的）
          const visible = tabs.filter((t) => t.kind !== "browser" || t.sessionId === sessionId);
          const current = visible.find((t) => t.id === s.active) ?? visible[0];
          if (current?.kind === "new") {
            const [first, ...rest] = added;
            return { tabs: [...tabs.map((t) => (t === current ? first! : t)), ...rest], active: (wanted ?? first!).id };
          }
          tabs = [...tabs, ...added];
          if (wanted) return { tabs, active: wanted.id };
        }
      }
      if (!changed) return s;
      if (!tabs.length) return newPanelState();
      return { tabs, active: tabs.some((t) => t.id === s.active) ? s.active : tabs[0]!.id };
    });
  }, [browserTabs, sessionId]);

  // 只显示当前会话的浏览器标签页；当前标签是别的会话的就退到第一个看得见的，一个都没有就补一个新标签页
  const visibleTabs = state.tabs.filter((t) => t.kind !== "browser" || t.sessionId === sessionId);
  const activeId = visibleTabs.some((t) => t.id === state.active) ? state.active : visibleTabs[0]?.id;
  useEffect(() => {
    if (visibleTabs.length) return;
    // 按最新状态再判断一次：开发模式（StrictMode）挂载时 effect 跑两次，两次看到的都是旧的 visibleTabs，不能各补一个
    onChange((s) => {
      if (s.tabs.some((t) => t.kind !== "browser" || t.sessionId === sessionId)) return s;
      const tab: PanelTab = { id: crypto.randomUUID(), kind: "new" };
      return { tabs: [...s.tabs, tab], active: tab.id };
    });
  }, [visibleTabs.length, sessionId]);

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
    if (tab.kind === "browser") browserApi?.close(tab.browserId);
    if (tab.kind === "files" && tab.path !== null) setDraft(cwd, tab.path, undefined);
    onChange((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tab.id);
      if (!tabs.length) return newPanelState();
      if (s.active !== tab.id) return { tabs, active: s.active };
      // 关的是当前标签：切到同一个会话里看得见的、原来在它旁边的那个
      const visible = s.tabs.filter((t) => t.kind !== "browser" || t.sessionId === sessionId);
      const index = visible.findIndex((t) => t.id === tab.id);
      const rest = visible.filter((t) => t.id !== tab.id);
      return { tabs, active: rest[Math.min(index, rest.length - 1)]?.id ?? tabs[0]!.id };
    });
    // 关的是当前会话看得见的最后一个标签：收起面板，下次打开是新标签页
    if (visibleTabs.length === 1 && visibleTabs[0]!.id === tab.id) onClose();
  };
  /** 新标签页里选了工具：这个标签页变成那个工具 */
  const replaceTab = (id: string, tab: PanelTab) =>
    onChange((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? tab : t)), active: tab.id }));
  const openFile = (from: string, path: string, pin: boolean) => onChange((s) => withFileOpen(s, from, path, pin));
  /** 目录树里重命名、拖动了（文件夹的路径以 / 结尾）：开着的文件标签跟着换路径，没保存的修改也跟过去 */
  const fileRenamed = (from: string, to: string) => {
    const remap = (p: string) => (p === from ? to : from.endsWith("/") && p.startsWith(from) ? to + p.slice(from.length) : null);
    for (const t of state.tabs) {
      if (t.kind !== "files" || t.path === null) continue;
      const next = remap(t.path);
      const draft = getDraft(cwd, t.path);
      if (next === null || draft === undefined) continue;
      setDraft(cwd, t.path, undefined);
      setDraft(cwd, next, draft);
    }
    onChange((s) => ({
      ...s,
      tabs: s.tabs.map((t) => {
        const next = t.kind === "files" && t.path !== null ? remap(t.path) : null;
        return next === null ? t : { ...t, path: next };
      }),
    }));
  };
  /** 目录树里删了：开着的文件标签关掉，当前看着的那个变回「打开文件」（目录树还在） */
  const fileDeleted = (path: string) => {
    const gone = (t: PanelTab) => t.kind === "files" && t.path !== null && (t.path === path || (path.endsWith("/") && t.path.startsWith(path)));
    for (const t of state.tabs) if (t.kind === "files" && t.path !== null && gone(t)) setDraft(cwd, t.path, undefined);
    onChange((s) => {
      const tabs = s.tabs.flatMap((t): PanelTab[] => (!gone(t) ? [t] : t.id === s.active ? [{ id: t.id, kind: "files", path: null, transient: false }] : []));
      return { tabs, active: s.active };
    });
  };
  /** 固定预览打开的文件标签 */
  const pin = (id: string) =>
    onChange((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id && t.kind === "files" && t.transient ? { ...t, transient: false } : t)) }));
  /** 新标签页的地址栏里输入了网址：给当前会话建一个浏览器标签页，这个标签页变成它 */
  const openBrowser = async (id: string, url: string) => {
    if (!browserApi) return;
    let info;
    try {
      info = await browserApi.create(sessionId, url);
    } catch (err) {
      // 常见于桌面版外壳还是旧的（网页刷新后用了新的预加载脚本，主进程没有对应的处理）：提示重启
      window.alert(`打开网页失败：${(err as Error).message}\n\n如果刚更新过代码，请重启桌面版。`);
      return;
    }
    if (!info) return;
    setBrowserTabs((all) => new Map(all ?? []).set(info.id, info));
    onChange((s) => {
      // 外壳推来的列表可能先到，已经补成了标签页：去掉这个新标签页，切过去
      const existing = s.tabs.find((t) => t.kind === "browser" && t.browserId === info.id);
      if (existing) return { tabs: s.tabs.filter((t) => t.id !== id), active: existing.id };
      const tab: PanelTab = { id, kind: "browser", browserId: info.id, sessionId: info.sessionId, key: info.key };
      return { tabs: s.tabs.map((t) => (t.id === id ? tab : t)), active: id };
    });
  };
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
        aria-valuenow={Math.min(width, maxWidth())}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth()}
        tabIndex={0}
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => commitWidth(clampWidth(defaultWidth()))}
        onKeyDown={onResizerKey}
      />
      <div className="panel-head">
        <div className="panel-tabs">
          {visibleTabs.map((tab) => (
            <TabButton
              key={tab.id}
              cwd={cwd}
              tab={tab}
              browserInfo={tab.kind === "browser" ? browserTabs?.get(tab.browserId) : undefined}
              active={tab.id === activeId}
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
        {visibleTabs.map((tab) => (
          // 不在前面的标签页也留着（终端不断开、文件树不重新加载），只是藏起来
          <div key={tab.id} className="panel-page" hidden={tab.id !== activeId}>
            {tab.kind === "new" && (
              <NewTab
                onFiles={() => replaceTab(tab.id, { id: tab.id, kind: "files", path: null, transient: false })}
                onTerminal={() => void openTerminal(tab.id)}
                // 只有桌面版有内置浏览器
                browser={browserApi ? (url) => void openBrowser(tab.id, url) : undefined}
              />
            )}
            {tab.kind === "browser" && browserApi && (
              <BrowserTab api={browserApi} id={tab.browserId} info={browserTabs?.get(tab.browserId)} active={tab.id === activeId} />
            )}
            {tab.kind === "files" && (
              <FileBrowser
                cwd={cwd}
                sessionId={sessionId}
                path={tab.path}
                active={tab.id === activeId}
                onSelectFile={(path, pinned) => openFile(tab.id, path, pinned)}
                onEdited={() => pin(tab.id)}
                onRenamed={fileRenamed}
                onDeleted={fileDeleted}
              />
            )}
            {tab.kind === "terminal" && !terminalsChecked && <div className="panel-empty">正在连接终端…</div>}
            {tab.kind === "terminal" && terminalsChecked && (
              <Suspense fallback={<div className="panel-empty">正在加载终端…</div>}>
                <TerminalView terminalId={tab.terminalId} active={tab.id === activeId} />
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
    case "browser":
      return "新标签页";
  }
}

function tabIcon(tab: PanelTab): ReactNode {
  switch (tab.kind) {
    case "new":
      // 桌面版的新标签页顶部是地址栏，图标同浏览器
      return desktop?.browser ? <GlobeIcon /> : <PlusSquareIcon />;
    case "files":
      return tab.path === null ? <FilesIcon /> : <FileTypeIcon name={tab.path.split("/").pop() || tab.path} />;
    case "terminal":
      return <TerminalIcon />;
    case "browser":
      return <GlobeIcon />;
  }
}

/** 标签：预览打开的文件是斜体（双击固定），有没保存的修改时关闭按钮的位置显示圆点（鼠标移上去变回 ×） */
function TabButton({ cwd, tab, browserInfo, active, onSelect, onPin, onClose }: { cwd: string; tab: PanelTab; browserInfo?: BrowserTabInfo; active: boolean; onSelect: () => void; onPin: () => void; onClose: () => void }) {
  const unsaved = useHasDraft(cwd, tab.kind === "files" ? tab.path : null);
  const transient = tab.kind === "files" && tab.transient;
  return (
    <div
      className={`panel-tab${active ? " active" : ""}${transient ? " temporary" : ""}`}
      title={
        tab.kind === "files" && tab.path
          ? transient
            ? `${tab.path}\n预览打开，双击标签固定`
            : tab.path
          : tab.kind === "browser" && browserInfo
            ? [browserInfo.title, browserInfo.url].filter(Boolean).join("\n")
            : undefined
      }
      onClick={onSelect}
      onDoubleClick={onPin}
      onAuxClick={(e) => e.button === 1 && onClose()}
    >
      <span className="panel-tab-icon">{tab.kind === "browser" ? <SiteIcon src={browserInfo?.favicon} /> : tabIcon(tab)}</span>
      <span className="panel-tab-label">{(tab.kind === "browser" && (browserInfo?.title || browserInfo?.url)) || tabLabel(tab)}</span>
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
/**
 * 新标签页：桌面版顶部是浏览器的地址栏（同 codex-app-server），输入网址这个标签页就变成浏览器；下面选别的工具。
 * browser：undefined 是没有内置浏览器（网页版）
 */
function NewTab({ onFiles, onTerminal, browser }: { onFiles?: () => void; onTerminal: () => void; browser?: (url: string) => void }) {
  const [address, setAddress] = useState("");
  return (
    <div className="panel-new-tab-wrap">
      {browser !== undefined && (
        <BrowserToolbar
          address={address}
          onAddress={setAddress}
          onReset={() => undefined}
          onSubmit={(url) => browser?.(url)}
          suggest={desktop?.browser.suggest}
        />
      )}
    <div className="panel-new-tab">
      <div className="panel-section-title">工具</div>
      <div className="panel-tools">
        {onFiles && (
          <button className="panel-tool" onClick={onFiles}>
            <FilesIcon />
            <span>文件</span>
          </button>
        )}
        <button className="panel-tool" onClick={onTerminal}>
          <TerminalIcon />
          <span>终端</span>
        </button>
      </div>
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

