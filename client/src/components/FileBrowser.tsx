import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { api, RequestError, type FileContent, type ProjectEntry } from "../api";
import { getDraft, setDraft, useHasDraft } from "../state/fileDrafts";
import { useDismiss } from "./ComposerPickers";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";
import { MarkdownLiveEditor } from "./MarkdownLiveEditor";
import { closePageAnnotation, editAnnotationAt, repositionAnnotationEditor, startPageAnnotation } from "./ResponseAnnotations";
import { useResponseAnnotations, type PageAnnotationTarget } from "../state/responseAnnotations";

/**
 * 右侧面板的文件工具（同 codex-app-server 的 FileBrowser）：上面是切换文件树、文件名、复制路径和操作按钮，
 * 下面左边是目录树（可以收起）、右边是文件内容。没选文件时是「打开文件」：提示从目录树里选。
 * 文本打开就能编辑（Ctrl+S 保存，不自动保存）；Markdown 默认所见即所得，直接在渲染效果上改（MarkdownLiveEditor，编辑的是源码），
 * 「预览 / 源代码」开关切到源代码编辑；HTML 显示成网页（HtmlPreview），没有开关
 */
export function FileBrowser({
  cwd,
  sessionId,
  path,
  active,
  onSelectFile,
  onEdited,
  onRenamed,
  onDeleted,
}: {
  cwd: string;
  /** 网页上写的标注记在这个会话下；没有（还没发第一条消息）时不能标注 */
  sessionId: string | null;
  /** 打开的文件（相对项目文件夹）；null 是「打开文件」 */
  path: string | null;
  /** 这个标签页在前面：轮询文件有没有被改 */
  active: boolean;
  /** 在目录树里选了文件；pin 是双击（固定打开），否则是预览打开 */
  onSelectFile: (path: string, pin: boolean) => void;
  /** 改了内容：预览打开的标签要固定下来 */
  onEdited: () => void;
  /** 目录树里重命名、拖动了文件或文件夹（文件夹的路径以 / 结尾）：开着的标签跟着换路径 */
  onRenamed: (from: string, to: string) => void;
  /** 目录树里删了文件或文件夹：开着的标签要关掉 */
  onDeleted: (path: string) => void;
}) {
  const [treeOpen, toggleTree] = useTreeOpen();
  const treeToggle = (
    <button
      className={`icon-btn viewer-head-icon${treeOpen ? " on" : ""}`}
      title={treeOpen ? "隐藏文件树" : "显示文件树"}
      aria-label={treeOpen ? "隐藏文件树" : "显示文件树"}
      aria-pressed={treeOpen}
      onClick={toggleTree}
    >
      <FoldersIcon />
    </button>
  );
  const tree = treeOpen ? <FileTree cwd={cwd} activePath={path} autoFocus={path === null} onSelect={onSelectFile} onRenamed={onRenamed} onDeleted={onDeleted} /> : null;

  if (path === null) {
    return (
      <div className="viewer">
        <div className="viewer-head">
          <div className="file-head">{treeToggle}</div>
        </div>
        <div className="viewer-split">
          {tree}
          <div className="viewer-main file-open-empty">
            <FoldersIcon size={28} />
            <h2>打开文件</h2>
            <p>从工作区目录树中选择文件</p>
            {!treeOpen && (
              <button className="btn-small" onClick={toggleTree}>
                显示文件树
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <FileViewer
      key={path}
      cwd={cwd}
      sessionId={sessionId}
      path={path}
      active={active}
      treeToggle={treeToggle}
      tree={tree}
      onEdited={onEdited}
      onOpenFile={(p) => onSelectFile(p, true)}
    />
  );
}

// ---------- 文件树开关：所有文件标签共用，记在本地 ----------

const TREE_KEY = "files.treeOpen";
const readTreeOpen = () => {
  try {
    return localStorage.getItem(TREE_KEY) !== "0";
  } catch {
    return true;
  }
};
function useTreeOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(readTreeOpen);
  useEffect(() => {
    const sync = () => setOpen(readTreeOpen());
    window.addEventListener("files-tree-toggle", sync);
    return () => window.removeEventListener("files-tree-toggle", sync);
  }, []);
  const toggle = () => {
    try {
      localStorage.setItem(TREE_KEY, open ? "0" : "1");
    } catch {
      // 忽略
    }
    setOpen(!open);
    window.dispatchEvent(new Event("files-tree-toggle"));
  };
  return [open, toggle];
}

// ---------- 目录树 ----------

const TREE_WIDTH_KEY = "fileTree.width";
const TREE_MIN = 160;
/** 文件内容区至少留这么宽 */
const CONTENT_MIN = 240;

/** 每个项目的目录树状态（展开了哪些、读到的内容、滚动位置），切标签页、重新打开面板时还原 */
interface TreeCache {
  expanded: Set<string>;
  dirs: Record<string, ProjectEntry[] | { error: string }>;
  scrollTop: number;
}
const treeCaches = new Map<string, TreeCache>();
const treeCache = (cwd: string) => {
  let c = treeCaches.get(cwd);
  // 根目录（""）默认展开
  if (!c) treeCaches.set(cwd, (c = { expanded: new Set([""]), dirs: {}, scrollTop: 0 }));
  return c;
};

const basename = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p).split("/").pop() || p;
const parentOf = (p: string) => {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i + 1);
};

const trimSlash = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p);
/** 同一个项目开着好几个文件标签时各有一棵树（共用 treeCache），一棵改了文件，通知别的也重画 */
const TREE_CHANGED = "files-tree-changed";
/**
 * 要把焦点放到哪一行（F2、Delete 才接得上）：点了别的文件（FileViewer 按路径重新挂载，树跟着重建、焦点丢了）、
 * 重命名或新建完（输入框换回按钮）。看得见的树画完后找到这一行就聚焦；只认 1 秒内的，免得以后别的时候抢焦点
 */
let refocus: { cwd: string; path: string; at: number } | null = null;
/** 新建、重命名时正在输入名字的那一行 */
type Editing = { kind: "new"; dir: string; isDir: boolean } | { kind: "rename"; path: string };
/** 文件名里不能有的：路径分隔符；也不能是 . 和 .. */
const nameError = (name: string) => (name === "." || name === ".." || /[\\/\0]/.test(name) ? "名称不能是 . 或 ..，也不能含有 / 或 \\" : null);

/**
 * 目录树（同 codex-app-server 的 FileTree）：顶部「筛选文件…」（在整个项目里按名字搜），没在筛选时是刷新按钮；
 * 单击文件预览打开，双击固定打开，点文件夹展开、收起；右边缘拖动调宽度。
 * 右键：空白处和第一行（工作目录）新建文件、文件夹，文件夹还能在里面新建；文件、文件夹能重命名（F2）、删除（Delete）。
 * 拖动文件、文件夹到别的文件夹（拖到文件上是放进它所在的文件夹，拖到空白处或第一行是放到根目录），悬停在收起的文件夹上一会儿自动展开
 */
function FileTree({
  cwd,
  activePath,
  autoFocus,
  onSelect,
  onRenamed,
  onDeleted,
}: {
  cwd: string;
  activePath: string | null;
  autoFocus: boolean;
  onSelect: (path: string, pin: boolean) => void;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (path: string) => void;
}) {
  const cache = treeCache(cwd);
  const [, rerender] = useState(0);
  const update = () => rerender((n) => n + 1);
  const listRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    (dir: string) =>
      api.listDir(cwd, dir).then(
        (entries) => {
          cache.dirs[dir] = entries;
          update();
        },
        (e: Error) => {
          cache.dirs[dir] = { error: e.message };
          update();
        },
      ),
    [cwd],
  );
  useEffect(() => {
    if (!cache.dirs[""]) void load("");
  }, [load]);

  // 打开的文件在目录树里展开到它所在的文件夹，滚到看得见
  useEffect(() => {
    if (!activePath) return;
    let changed = false;
    for (let dir = parentOf(activePath); ; dir = parentOf(dir)) {
      if (!cache.expanded.has(dir)) {
        cache.expanded.add(dir);
        changed = true;
      }
      if (!cache.dirs[dir]) void load(dir);
      // 一直展开到根目录（""）为止
      if (!dir) break;
    }
    if (changed) update();
  }, [activePath]);
  useEffect(() => {
    if (!activePath) return;
    listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(activePath)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activePath, cache.dirs]);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = cache.scrollTop;
  }, []);
  useEffect(() => {
    const r = refocus;
    if (!r || r.cwd !== cwd) return;
    if (Date.now() - r.at > 1000) {
      refocus = null;
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(r.path)}"]`);
    // 别的文件标签里藏着的树不算
    if (row && row.offsetParent !== null) {
      refocus = null;
      row.focus({ preventScroll: true });
    }
  });

  const toggle = (dir: string) => {
    if (cache.expanded.has(dir)) cache.expanded.delete(dir);
    else {
      cache.expanded.add(dir);
      void load(dir);
    }
    update();
  };
  const refresh = () => {
    void load("");
    for (const dir of cache.expanded) void load(dir);
  };

  // 筛选：在整个项目里搜（同输入框 @ 的候选）
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProjectEntry[] | null>(null);
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.files(cwd, q).then(
        (entries) => {
          if (cancelled) return;
          setHits(entries);
          setCursor(0);
        },
        () => !cancelled && setHits([]),
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, cwd]);
  const pickHit = (hit: ProjectEntry, pin: boolean) => {
    if (hit.dir) {
      // 文件夹：清掉筛选，在目录树里展开到它
      for (let dir = hit.path; dir; dir = parentOf(dir)) {
        cache.expanded.add(dir);
        if (!cache.dirs[dir]) void load(dir);
      }
      cache.expanded.add("");
      setQuery("");
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(hit.path)}"]`)?.scrollIntoView({ block: "nearest" }));
    } else onSelect(hit.path, pin);
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setQuery("");
      return;
    }
    if (!hits?.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[cursor];
      if (hit) pickHit(hit, false);
    }
  };

  // ---------- 新建、重命名、删除、拖动 ----------
  useEffect(() => {
    const onChanged = (e: Event) => (e as CustomEvent<string>).detail === cwd && update();
    window.addEventListener(TREE_CHANGED, onChanged);
    return () => window.removeEventListener(TREE_CHANGED, onChanged);
  }, [cwd]);
  /** 改了文件之后重新读这些文件夹，读完通知同一个项目的别的树 */
  const reload = (dirs: string[]) =>
    Promise.all([...new Set(dirs)].map(load)).then(() => window.dispatchEvent(new CustomEvent(TREE_CHANGED, { detail: cwd })));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProjectEntry | null>(null);
  const fail = (e: unknown) => setOpError((e as Error).message);

  /** 展开到这个文件夹（新建时输入框要看得见） */
  const expandTo = (dir: string) => {
    for (let d = dir; ; d = parentOf(d)) {
      cache.expanded.add(d);
      if (!cache.dirs[d]) void load(d);
      if (!d) break;
    }
  };
  /** 输入框收起后焦点回到那一行，接着能按 F2、Delete */
  const focusRow = (path: string) => {
    refocus = { cwd, path, at: Date.now() };
    update();
  };
  const startNew = (dir: string, isDir: boolean) => {
    setOpError(null);
    expandTo(dir);
    setEditing({ kind: "new", dir, isDir });
  };
  const startRename = (entry: ProjectEntry) => {
    setOpError(null);
    setEditing({ kind: "rename", path: entry.path });
  };
  /** 新建时的默认名字：同 Windows 资源管理器，重名了加 (2)、(3)… */
  const defaultName = (dir: string, isDir: boolean) => {
    const list = cache.dirs[dir];
    const taken = new Set(Array.isArray(list) ? list.map((e) => basename(e.path).toLowerCase()) : []);
    const [base, ext] = isDir ? ["新建文件夹", ""] : ["新建文本文档", ".txt"];
    for (let i = 1; ; i++) {
      const name = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  };
  const commitNew = async (dir: string, isDir: boolean, raw: string | null) => {
    setEditing(null);
    const name = raw?.trim();
    if (!name) return;
    const bad = nameError(name);
    if (bad) return setOpError(bad);
    const path = dir + name;
    try {
      await api.createFile(cwd, path, isDir);
    } catch (e) {
      return fail(e);
    }
    await reload([dir]);
    // 新建的文件直接打开，文件夹滚到看得见
    focusRow(isDir ? path + "/" : path);
    if (!isDir) onSelect(path, true);
    else listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path + "/")}"]`)?.scrollIntoView({ block: "nearest" });
  };
  /** 改路径（重命名、拖动）；文件夹的路径以 / 结尾 */
  const move = async (from: string, to: string) => {
    if (from === to) return;
    setOpError(null);
    try {
      await api.renameFile(cwd, trimSlash(from), trimSlash(to));
    } catch (e) {
      fail(e);
      focusRow(from);
      return;
    }
    if (from.endsWith("/")) {
      // 文件夹里展开着的跟着换路径，读过的内容作废
      cache.expanded = new Set([...cache.expanded].map((k) => (k.startsWith(from) ? to + k.slice(from.length) : k)));
      for (const k of Object.keys(cache.dirs)) if (k.startsWith(from)) delete cache.dirs[k];
    }
    // 先记下要聚焦的行：开着的文件改了路径树会重建，读完之后重画时再聚焦
    focusRow(to);
    onRenamed(from, to);
    await reload([parentOf(from), parentOf(to), ...[...cache.expanded].filter((k) => k.startsWith(to))]);
  };
  const commitRename = (entry: ProjectEntry, raw: string | null) => {
    setEditing(null);
    const name = raw?.trim();
    if (!name || name === basename(entry.path)) return focusRow(entry.path);
    const bad = nameError(name);
    if (bad) {
      setOpError(bad);
      return focusRow(entry.path);
    }
    void move(entry.path, parentOf(entry.path) + name + (entry.dir ? "/" : ""));
  };
  const remove = async (entry: ProjectEntry) => {
    setConfirmDelete(null);
    setOpError(null);
    try {
      await api.deleteFile(cwd, trimSlash(entry.path));
    } catch (e) {
      return fail(e);
    }
    if (entry.dir) {
      for (const k of [...cache.expanded]) if (k.startsWith(entry.path)) cache.expanded.delete(k);
      for (const k of Object.keys(cache.dirs)) if (k.startsWith(entry.path)) delete cache.dirs[k];
    }
    onDeleted(entry.path);
    await reload([parentOf(entry.path)]);
  };

  // 右键菜单：entry 为 null 是空白处或第一行（工作目录）
  const [menu, setMenu] = useState<{ x: number; y: number; entry: ProjectEntry | null } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menuRef, menu !== null, closeMenu);
  const openMenu = (e: MouseEvent, entry: ProjectEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    // 筛选结果里没有目录结构，新建的输入框没地方放
    if (hits !== null || editing) return;
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 170), y: Math.min(e.clientY, window.innerHeight - 170), entry });
  };
  const menuItems = (entry: ProjectEntry | null) => {
    const dir = entry ? (entry.dir ? entry.path : null) : "";
    const groups: { label: string; danger?: boolean; onClick: () => void }[][] = [];
    if (dir !== null)
      groups.push([
        { label: "新建文件", onClick: () => startNew(dir, false) },
        { label: "新建文件夹", onClick: () => startNew(dir, true) },
      ]);
    if (entry)
      groups.push([
        { label: "重命名", onClick: () => startRename(entry) },
        { label: "删除", danger: true, onClick: () => setConfirmDelete(entry) },
      ]);
    return groups;
  };
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, entry: ProjectEntry) => {
    if (e.key === "F2") {
      e.preventDefault();
      startRename(entry);
    } else if (e.key === "Delete") {
      e.preventDefault();
      setConfirmDelete(entry);
    }
  };

  // 拖动：dir 是放进去的文件夹（"" 是根目录）；不能放回原来的文件夹，文件夹不能放进自己里面
  const dragging = useRef<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const expandTimer = useRef<{ dir: string; timer: number } | null>(null);
  const clearExpandTimer = () => {
    if (expandTimer.current) window.clearTimeout(expandTimer.current.timer);
    expandTimer.current = null;
  };
  const canDrop = (from: string, dir: string) => parentOf(from) !== dir && !(from.endsWith("/") && dir.startsWith(from));
  const endDrag = () => {
    dragging.current = null;
    setDropDir(null);
    clearExpandTimer();
  };
  const onDragStart = (e: DragEvent, entry: ProjectEntry) => {
    dragging.current = entry.path;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", entry.path);
  };
  const onDragOver = (e: DragEvent, dir: string) => {
    const from = dragging.current;
    if (!from) return;
    e.stopPropagation();
    // 悬停在收起的文件夹上 600ms 自动展开
    if (dir && !cache.expanded.has(dir)) {
      if (expandTimer.current?.dir !== dir) {
        clearExpandTimer();
        const timer = window.setTimeout(() => {
          expandTimer.current = null;
          if (!cache.expanded.has(dir)) toggle(dir);
        }, 600);
        expandTimer.current = { dir, timer };
      }
    } else clearExpandTimer();
    if (!canDrop(from, dir)) {
      setDropDir(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropDir(dir);
  };
  const onDrop = (e: DragEvent, dir: string) => {
    const from = dragging.current;
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    endDrag();
    if (canDrop(from, dir)) void move(from, dir + basename(from) + (from.endsWith("/") ? "/" : ""));
  };

  // 宽度：拖右边缘调整，记在本地
  const [width, setWidth] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(TREE_WIDTH_KEY)) || null;
    } catch {
      return null;
    }
  });
  const drag = useRef<{ x: number; width: number; max: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const tree = treeRef.current;
    if (!tree) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = tree.parentElement?.getBoundingClientRect();
    const start = tree.getBoundingClientRect().width;
    drag.current = { x: e.clientX, width: start, max: box ? box.width - CONTENT_MIN : start };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) setWidth(Math.max(TREE_MIN, Math.min(d.max, Math.round(d.width + e.clientX - d.x))));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      if (width) localStorage.setItem(TREE_WIDTH_KEY, String(width));
    } catch {
      // 忽略
    }
  };

  const rows: ReactNode[] = [];
  const renderDir = (dir: string, depth: number) => {
    const list = cache.dirs[dir];
    const pad = 10 + depth * 14;
    if (!list) {
      rows.push(<div key={`${dir}:loading`} className="files-note" style={{ paddingLeft: pad + 18 }}>加载中…</div>);
      return;
    }
    if (!Array.isArray(list)) {
      rows.push(<div key={`${dir}:error`} className="files-note files-error" style={{ paddingLeft: pad + 18 }}>{list.error}</div>);
      return;
    }
    const adding = editing?.kind === "new" && editing.dir === dir ? editing : null;
    if (adding) {
      const initial = defaultName(dir, adding.isDir);
      rows.push(
        <div key={`${dir}:new`} className="files-row editing" style={{ paddingLeft: pad }}>
          <span className="files-caret" />
          <span className="files-icon">{adding.isDir ? <FolderTypeIcon open={false} name={initial} /> : <FileTypeIcon name={initial} />}</span>
          <NameInput initial={initial} selectExt={!adding.isDir} onDone={(name) => void commitNew(dir, adding.isDir, name)} />
        </div>,
      );
    } else if (!list.length) rows.push(<div key={`${dir}:empty`} className="files-note" style={{ paddingLeft: pad + 18 }}>空文件夹</div>);
    for (const entry of list) {
      const name = basename(entry.path);
      const open = entry.dir && cache.expanded.has(entry.path);
      // 放进哪个文件夹：文件夹就是它自己，文件是它所在的文件夹
      const target = entry.dir ? entry.path : dir;
      if (editing?.kind === "rename" && editing.path === entry.path) {
        rows.push(
          <div key={entry.path} data-path={entry.path} className="files-row editing" style={{ paddingLeft: pad }}>
            <span className="files-caret">{entry.dir && <Chevron open={open} />}</span>
            <span className="files-icon">{entry.dir ? <FolderTypeIcon open={open} name={name} /> : <FileTypeIcon name={name} />}</span>
            <NameInput initial={name} selectExt={!entry.dir} onDone={(next) => commitRename(entry, next)} />
          </div>,
        );
        if (open) renderDir(entry.path, depth + 1);
        continue;
      }
      const classes = ["files-row"];
      if (entry.path === activePath) classes.push("selected");
      if (entry.dir && dropDir === entry.path) classes.push("drop-target");
      if (menu?.entry?.path === entry.path) classes.push("menu-open");
      rows.push(
        <button
          key={entry.path}
          data-path={entry.path}
          className={classes.join(" ")}
          style={{ paddingLeft: pad }}
          title={entry.path}
          draggable
          onClick={() => {
            if (entry.dir) return toggle(entry.path);
            // 换了文件树会重建，焦点要还回来
            if (entry.path !== activePath) refocus = { cwd, path: entry.path, at: Date.now() };
            onSelect(entry.path, false);
          }}
          onDoubleClick={() => !entry.dir && onSelect(entry.path, true)}
          onContextMenu={(e) => openMenu(e, entry)}
          onKeyDown={(e) => onRowKey(e, entry)}
          onDragStart={(e) => onDragStart(e, entry)}
          onDragEnd={endDrag}
          onDragOver={(e) => onDragOver(e, target)}
          onDrop={(e) => onDrop(e, target)}
        >
          <span className="files-caret">{entry.dir && <Chevron open={open} />}</span>
          <span className="files-icon">{entry.dir ? <FolderTypeIcon open={open} name={name} /> : <TreeFileIcon key={entry.mtimeMs} cwd={cwd} entry={entry} />}</span>
          <span className="files-name">{name}</span>
        </button>,
      );
      if (open) renderDir(entry.path, depth + 1);
    }
  };
  // 第一行是工作目录本身（项目文件夹，或者普通会话的 scratch-… 目录），点了收起、展开，悬停看完整路径
  if (hits === null) {
    const rootName = basename(cwd);
    const rootOpen = cache.expanded.has("");
    rows.push(
      <button
        key=":root"
        className={`files-row files-root${dropDir === "" ? " drop-target" : ""}${menu && !menu.entry ? " menu-open" : ""}`}
        style={{ paddingLeft: 10 }}
        title={cwd}
        onClick={() => toggle("")}
        onContextMenu={(e) => openMenu(e, null)}
        onDragOver={(e) => onDragOver(e, "")}
        onDrop={(e) => onDrop(e, "")}
      >
        <span className="files-caret"><Chevron open={rootOpen} /></span>
        <span className="files-icon"><FolderTypeIcon open={rootOpen} name={rootName} /></span>
        <span className="files-name">{rootName}</span>
      </button>,
    );
    if (rootOpen) renderDir("", 1);
  }

  return (
    <div className="file-tree" ref={treeRef} style={width ? { flexBasis: width } : undefined}>
      <div
        className="file-tree-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整文件树宽度"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          setWidth(null);
          try {
            localStorage.removeItem(TREE_WIDTH_KEY);
          } catch {
            // 忽略
          }
        }}
      />
      <div className="file-tree-filter">
        <SearchIcon />
        <input aria-label="筛选文件" placeholder="筛选文件…" value={query} autoFocus={autoFocus} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} />
        {query ? (
          <button className="icon-btn file-tree-btn" title="清除文件筛选" aria-label="清除文件筛选" onClick={() => setQuery("")}>
            ×
          </button>
        ) : (
          <button className="icon-btn file-tree-btn" title="刷新" aria-label="刷新" onClick={refresh}>
            <RefreshIcon />
          </button>
        )}
      </div>
      {opError && (
        <div className="files-note files-error file-tree-error" role="alert" title="点击关闭" onClick={() => setOpError(null)}>
          {opError}
        </div>
      )}
      <div
        className="file-tree-list"
        ref={listRef}
        onScroll={(e) => hits === null && (cache.scrollTop = e.currentTarget.scrollTop)}
        onContextMenu={(e) => openMenu(e, null)}
        onDragOver={(e) => onDragOver(e, "")}
        onDrop={(e) => onDrop(e, "")}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropDir(null)}
      >
        {hits === null
          ? rows
          : hits.length === 0
            ? <div className="files-note">没有匹配的文件</div>
            : hits.map((hit, i) => {
                const dir = parentOf(hit.path).replace(/\/$/, "");
                return (
                  <button
                    key={hit.path}
                    className={`files-hit${i === cursor ? " active" : ""}${hit.path === activePath ? " selected" : ""}`}
                    title={hit.path}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => pickHit(hit, false)}
                    onDoubleClick={() => pickHit(hit, true)}
                  >
                    <span className="files-icon">{hit.dir ? <FolderTypeIcon open={false} name={basename(hit.path)} /> : <FileTypeIcon name={basename(hit.path)} />}</span>
                    <span className="files-name">{basename(hit.path)}</span>
                    {dir && <span className="files-hit-dir">{dir}</span>}
                  </button>
                );
              })}
      </div>
      {menu && (
        <div ref={menuRef} className="menu context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          {menuItems(menu.entry).map((group, i) => (
            <div key={i}>
              {i > 0 && <div className="menu-divider" />}
              {group.map((item) => (
                <button
                  key={item.label}
                  role="menuitem"
                  className={`menu-item${item.danger ? " danger" : ""}`}
                  onClick={() => {
                    setMenu(null);
                    item.onClick();
                  }}
                >
                  <span className="menu-item-name">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={confirmDelete.dir ? "删除文件夹？" : "删除文件？"}
          message={
            confirmDelete.dir
              ? `将永久删除文件夹「${basename(confirmDelete.path)}」及其中的所有内容，无法恢复。`
              : `将永久删除「${basename(confirmDelete.path)}」，无法恢复。`
          }
          confirmLabel="删除"
          onConfirm={() => void remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/** 目录树里新建、重命名时输入名字：回车或点别处确定，Esc 取消；文件先选中扩展名前面的部分 */
function NameInput({ initial, selectExt, onDone }: { initial: string; selectExt: boolean; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = selectExt ? initial.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, []);
  // 回车之后输入框卸掉还会触发一次 blur，只算第一次
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={ref}
      className="files-name-input"
      aria-label="名称"
      defaultValue={initial}
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
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

const THUMB_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
/** 太大的图不当缩略图加载（列表里每张都要读） */
const THUMB_MAX_BYTES = 5 * 1024 * 1024;

/** 目录树里文件的图标；图片显示小缩略图（同 codex-app-server），读不出来时退回类型图标 */
function TreeFileIcon({ cwd, entry }: { cwd: string; entry: ProjectEntry }) {
  const [failed, setFailed] = useState(false);
  const name = basename(entry.path);
  if (failed || !THUMB_EXT.test(name) || entry.size === undefined || entry.size > THUMB_MAX_BYTES) return <FileTypeIcon name={name} />;
  return (
    <img className="files-thumb" src={api.rawFileUrl(cwd, entry.path, entry.mtimeMs)} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
  );
}

// ---------- 文件内容 ----------

/** 打开就能编辑的上限，再大只读（同 codex-app-server：「大文件已以只读模式打开」） */
const EDITABLE_MAX_BYTES = 1024 * 1024;
/** 在前面时多久看一次文件有没有被改（Claude 改了、终端里改了） */
const POLL_MS = 3000;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const HTML = /\.html?$/i;

function FileViewer({
  cwd,
  sessionId,
  path,
  active,
  treeToggle,
  tree,
  onEdited,
  onOpenFile,
}: {
  cwd: string;
  sessionId: string | null;
  path: string;
  active: boolean;
  treeToggle: ReactNode;
  tree: ReactNode;
  onEdited: () => void;
  /** Markdown 里点了指向项目里文件的链接 */
  onOpenFile: (path: string) => void;
}) {
  const [content, setContent] = useState<FileContent | { error: string } | null>(null);
  const markdown = MARKDOWN.test(path);
  const html = HTML.test(path);
  // Markdown 默认显示渲染效果，开关切到源代码
  const [rendered, setRendered] = useState(true);
  // HTML 的标注模式；网页里的标注脚本连上了才能开
  const [annotating, setAnnotating] = useState(false);
  const [pageReady, setPageReady] = useState(false);
  const dirty = useHasDraft(cwd, path);
  // 草稿在 fileDrafts 里，每次输入后重新渲染一下
  const [, rerender] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);

  const load = useCallback(() => {
    api.readFile(cwd, path).then(setContent, (e: Error) => setContent({ error: e.message }));
  }, [cwd, path]);
  useEffect(load, [load]);

  // 在前面、没有没保存的修改时，文件被改了就安静地重新读
  useEffect(() => {
    if (!active || dirty) return;
    const timer = setInterval(() => {
      api.readFile(cwd, path).then(
        (next) => setContent((prev) => (prev && "mtimeMs" in prev && prev.mtimeMs === next.mtimeMs ? prev : next)),
        () => undefined,
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, dirty, cwd, path]);

  const ok = content && !("error" in content) ? content : null;
  const editable = ok?.kind === "text" && ok.size <= EDITABLE_MAX_BYTES;
  const saved = ok?.text ?? "";
  const value = getDraft(cwd, path) ?? saved;

  const save = async (force = false) => {
    if (!ok || !editable || saving) return;
    const text = getDraft(cwd, path);
    if (text === undefined) return;
    setSaving(true);
    try {
      const { mtimeMs } = await api.writeFile(cwd, path, text, ok.mtimeMs, force);
      setContent({ ...ok, text, mtimeMs, size: new Blob([text]).size });
      // 保存期间又输入了的，留着新的内容
      if (getDraft(cwd, path) === text) setDraft(cwd, path, undefined);
      setSaveError(null);
    } catch (err) {
      setSaveError({ message: (err as Error).message, conflict: err instanceof RequestError && err.status === 409 });
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setDraft(cwd, path, undefined);
    setSaveError(null);
    load();
  };
  const change = (next: string) => {
    setDraft(cwd, path, next === saved ? undefined : next);
    rerender((n) => n + 1);
    setSaveError((e) => (e?.conflict ? e : null));
    onEdited();
  };

  let body: ReactNode;
  if (!content) body = <div className="panel-empty">正在加载文件…</div>;
  else if ("error" in content) body = <div className="panel-empty files-error">{content.error}</div>;
  else if (content.kind === "image")
    body = (
      <div className="viewer-image">
        <img src={api.rawFileUrl(cwd, path, content.mtimeMs)} alt={path} />
      </div>
    );
  else if (content.kind === "binary") body = <div className="panel-empty">二进制文件，无法预览（{formatBytes(content.size)}）</div>;
  else if (content.kind === "too-large") body = <div className="panel-empty">文件太大，无法预览（{formatBytes(content.size)}）</div>;
  else if (html)
    body = (
      <HtmlPreview
        cwd={cwd}
        path={path}
        mtimeMs={content.mtimeMs}
        sessionId={sessionId}
        annotating={annotating}
        onAnnotatingChange={setAnnotating}
        onReady={setPageReady}
      />
    );
  else if (markdown && rendered)
    body = (
      <MarkdownLiveEditor
        cwd={cwd}
        path={path}
        value={value}
        editable={editable}
        placeholder="使用 Markdown 编写…"
        onChange={change}
        onSave={() => void save()}
        onOpenFile={onOpenFile}
      />
    );
  else body = <TextEditor value={value} readOnly={!editable} placeholder={markdown ? "使用 Markdown 编写…" : "写点什么…"} onChange={change} onSave={() => void save()} />;

  return (
    <div className="viewer">
      <div className="viewer-head">
        <div className="file-head">
          {treeToggle}
          <span className="file-crumb-file" title={path}>
            {basename(path)}
          </span>
          <CopyPath cwd={cwd} path={path} />
          {dirty && (
            <button className="viewer-unsaved" title="有未保存的修改（Ctrl+S 保存）" disabled={saving} onClick={() => void save()}>
              {saving ? "保存中…" : "未保存"}
            </button>
          )}
        </div>
        <div className="viewer-head-actions">
          {markdown && ok?.kind === "text" && (
            <label className="md-source-switch">
              {rendered ? "预览" : "源代码"}
              <button
                role="switch"
                aria-checked={!rendered}
                className={`switch${rendered ? "" : " on"}`}
                title={rendered ? "查看源代码" : "切到预览"}
                onClick={() => setRendered((r) => !r)}
              >
                <span />
              </button>
            </label>
          )}
          {html && ok?.kind === "text" && (
            <button
              className={`icon-btn viewer-head-icon${annotating ? " on" : ""}`}
              title={!sessionId ? "发出第一条消息后才能标注" : !pageReady ? "这个网页还没加载好，或者不支持标注" : annotating ? "退出标注" : "在网页上点选元素写标注，随下一条消息发给 Claude"}
              aria-label="标注"
              aria-pressed={annotating}
              disabled={!sessionId || !pageReady}
              onClick={() => setAnnotating((a) => !a)}
            >
              <AnnotateIcon />
            </button>
          )}
          <FileOptionsMenu text={ok?.kind === "text" ? value : null} onReload={dirty ? undefined : load} />
        </div>
      </div>
      <div className="viewer-split">
        {tree}
        <div className="viewer-main">
          {saveError && (
            <div className="viewer-save-error">
              <span>保存失败：{saveError.message}</span>
              {saveError.conflict ? (
                <>
                  <button className="btn-small" onClick={discard}>
                    放弃修改，重新加载
                  </button>
                  <button className="btn-small" onClick={() => void save(true)}>
                    覆盖
                  </button>
                </>
              ) : (
                <button className="btn-small" onClick={() => void save()}>
                  重试
                </button>
              )}
            </div>
          )}
          {ok?.kind === "text" && !editable && <div className="file-truncated">大文件已以只读模式打开</div>}
          {body}
        </div>
      </div>
    </div>
  );
}

/**
 * HTML 显示成网页：iframe 取网关的预览地址，网页里的相对路径（样式、脚本、图片）照常加载。
 * 显示的是保存了的文件，文件改了（修改时间变了）就重新加载。
 * sandbox 不给 allow-same-origin：网页和界面同源，脚本不能碰界面的存储和接口。
 *
 * 标注（参照 codex-app-server 的浏览器批注）：网关在网页末尾接了一段脚本（gateway/src/http/page-picker.ts），
 * 和这里互相 postMessage。标注模式下在网页上点一个元素，界面上打开编辑框写要怎么改，
 * 加进输入框里的「N 条注释」，随下一条消息发出；已有的标注在元素上显示编号，点编号修改
 */
function HtmlPreview({
  cwd,
  path,
  mtimeMs,
  sessionId,
  annotating,
  onAnnotatingChange,
  onReady,
}: {
  cwd: string;
  path: string;
  mtimeMs: number;
  sessionId: string | null;
  annotating: boolean;
  onAnnotatingChange: (on: boolean) => void;
  /** 网页里的标注脚本连上了（每次加载后），换地址时先报 false */
  onReady: (ready: boolean) => void;
}) {
  const [url, setUrl] = useState<{ ok: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.pageUrl(cwd, path).then(
      (ok) => live && setUrl({ ok }),
      (e: Error) => live && setUrl({ error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [cwd, path]);
  const src = url && "ok" in url ? `${url.ok}?v=${Math.round(mtimeMs)}` : null;

  const frameRef = useRef<HTMLIFrameElement>(null);
  /** 网页当前显示的文件（点链接可能跳到别的页面）和第几次加载 */
  const [loaded, setLoaded] = useState<{ file: string; n: number } | null>(null);
  const fileRef = useRef(path);
  fileRef.current = loaded?.file ?? path;
  const pickedRect = useRef<PageRect | null>(null);

  const annotations = useResponseAnnotations(sessionId);
  const file = loaded?.file;
  const marks = useMemo(
    () => annotations.flatMap((a, i) => (a.page && a.page.file === file ? [{ id: a.id, n: i + 1, selector: a.page.selector }] : [])),
    [annotations, file],
  );

  const post = useCallback((msg: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ ...msg, source: "claude-app" }, "*");
  }, []);
  /** 网页视口里的位置换成界面上的 */
  const toScreen = useCallback((r: PageRect | null) => {
    const f = frameRef.current?.getBoundingClientRect();
    return r && f ? new DOMRect(f.left + r.x, f.top + r.y, r.width, r.height) : null;
  }, []);

  useEffect(() => {
    onReady(false);
    setLoaded(null);
  }, [src, onReady]);

  // 每次加载好、标注模式和编号变了，都把状态告诉网页
  useEffect(() => {
    if (loaded) post({ type: "state", annotating: annotating && !!sessionId, marks });
  }, [loaded, annotating, sessionId, marks, post]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      const d = e.data as Record<string, unknown> | null;
      if (!frame || e.source !== frame.contentWindow || !d || d.source !== "claude-app-page") return;
      if (d.type === "ready") {
        setLoaded((prev) => ({ file: pageFile(d.path) ?? path, n: (prev?.n ?? 0) + 1 }));
        onReady(true);
      } else if (d.type === "pick" && sessionId) {
        const target = pageTarget(d, fileRef.current);
        if (!target) return;
        pickedRect.current = pageRect(d.rect);
        const pickId = d.pickId;
        startPageAnnotation(
          sessionId,
          str(d.label, 300),
          target,
          () => toScreen(pickedRect.current),
          () => post({ type: "clear-pick", pickId }),
        );
      } else if (d.type === "picked-rect") {
        pickedRect.current = pageRect(d.rect);
        repositionAnnotationEditor();
      } else if (d.type === "edit" && sessionId && typeof d.id === "string") {
        const rect = pageRect(d.rect);
        editAnnotationAt(sessionId, d.id, () => toScreen(rect));
      } else if (d.type === "escape") onAnnotatingChange(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [path, sessionId, post, toScreen, onReady, onAnnotatingChange]);

  // 退出标注模式、关掉文件时，没写完的标注框也关掉
  useEffect(() => {
    if (!annotating) closePageAnnotation();
  }, [annotating]);
  useEffect(() => closePageAnnotation, []);

  if (!url) return <div className="panel-empty">正在加载网页…</div>;
  if ("error" in url) return <div className="panel-empty files-error">{url.error}</div>;
  return (
    <>
      <iframe ref={frameRef} className="viewer-frame" src={src!} title={path} sandbox="allow-scripts allow-forms allow-modals allow-popups" />
      {annotating && (
        <div className="viewer-annotate-bar">
          <span>点选网页上的元素写标注，随下一条消息发给 Claude</span>
          <button className="icon-btn" title="退出标注（Esc）" aria-label="退出标注" onClick={() => onAnnotatingChange(false)}>
            ×
          </button>
        </div>
      )}
    </>
  );
}

interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 网页发来的消息是网页里的脚本发的，逐个字段检查
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
function pageRect(v: unknown): PageRect | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) };
}
function pageTarget(d: Record<string, unknown>, file: string): PageAnnotationTarget | null {
  const selector = str(d.selector, 1000);
  const tag = str(d.tag, 40);
  if (!selector || !tag) return null;
  const p = (d.point ?? {}) as Record<string, unknown>;
  const v = (d.viewport ?? {}) as Record<string, unknown>;
  return {
    file,
    selector,
    tag,
    point: { x: Math.round(num(p.x)), y: Math.round(num(p.y)) },
    viewport: { width: Math.round(num(v.width)), height: Math.round(num(v.height)) },
  };
}
/** 网页地址的路径（…/files/page/<id>/<相对路径>）里的文件，文件夹是里面的 index.html */
function pageFile(pathname: unknown): string | null {
  if (typeof pathname !== "string") return null;
  const m = /\/files\/page\/[^/]+\/(.*)$/.exec(pathname);
  if (!m) return null;
  try {
    const rel = m[1]!.split("/").map(decodeURIComponent).join("/");
    return !rel || rel.endsWith("/") ? `${rel}index.html` : rel;
  } catch {
    return null;
  }
}

/** 带行号的编辑器（同 codex-app-server）：不自动换行，行号和每一行对齐；Ctrl/⌘+S 保存 */
function TextEditor({
  value,
  readOnly,
  placeholder,
  onChange,
  onSave,
}: {
  value: string;
  readOnly: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const lines = value.split("\n");
  return (
    <div className="viewer-edit">
      <pre className="viewer-edit-gutter" aria-hidden="true">
        {lines.map((_, i) => i + 1).join("\n")}
      </pre>
      <textarea
        className="viewer-editor"
        value={value}
        wrap="off"
        spellCheck={false}
        rows={lines.length + 1}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            onSave();
          } else if (e.key === "Tab" && !readOnly && !e.ctrlKey && !e.altKey && !e.metaKey) {
            // Tab 插入缩进，不跳出编辑器
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: start, selectionEnd: end } = el;
            const next = `${el.value.slice(0, start)}  ${el.value.slice(end)}`;
            onChange(next);
            requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
          }
        }}
      />
    </div>
  );
}

/** 复制路径：按钮复制相对项目的路径，旁边的下拉可以选绝对路径 */
function CopyPath({ cwd, path }: { cwd: string; path: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  const absolute = `${cwd.replace(/[\\/]+$/, "")}${sep}${sep === "\\" ? path.replaceAll("/", "\\") : path}`;
  const copy = async (text: string) => {
    setOpen(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      window.alert(`复制失败：${(err as Error).message}`);
    }
  };
  return (
    <div className="file-copy-path" ref={ref}>
      <button className="icon-btn file-copy-btn" title={copied ? "已复制" : "复制项目相对路径"} aria-label="复制项目相对路径" onClick={() => void copy(path)}>
        {copied ? "✓" : <CopyIcon />}
      </button>
      <button className="icon-btn file-copy-more" title="复制路径的选项" aria-label="复制路径的选项" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Chevron open />
      </button>
      {open && (
        <div className="menu file-menu" role="menu">
          <button className="menu-item" role="menuitem" onClick={() => void copy(absolute)}>
            <span className="menu-item-name">绝对路径</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => void copy(path)}>
            <span className="menu-item-name">相对于项目的路径</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** 顶部的「…」：复制文件内容、重新加载 */
function FileOptionsMenu({ text, onReload }: { text: string | null; onReload?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div className="file-options" ref={ref}>
      <button className="icon-btn viewer-head-icon" title="文件选项" aria-label="文件选项" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreIcon />
      </button>
      {open && (
        <div className="menu file-menu file-menu-right" role="menu">
          <button
            className="menu-item"
            role="menuitem"
            disabled={text === null}
            onClick={() => {
              setOpen(false);
              if (text !== null) void navigator.clipboard.writeText(text);
            }}
          >
            <span className="menu-item-name">复制文件内容</span>
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!onReload}
            title={onReload ? undefined : "有未保存的修改，先保存或放弃"}
            onClick={() => {
              setOpen(false);
              onReload?.();
            }}
          >
            <span className="menu-item-name">重新加载</span>
          </button>
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- 图标 ----------

/** 两个叠着的文件夹（「切换文件树」） */
function AnnotateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5h-.5a1 1 0 0 1-1-1z" />
      <path d="M5.5 5.5h5M5.5 7.5h3" />
    </svg>
  );
}

export function FoldersIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 4V3.5a1 1 0 0 1 1-1h2l1 1h4a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H12" />
      <path d="M2 6.5a1 1 0 0 1 1-1h2.2l1 1H10a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined }}>
      <path d="M3.5 2 6.5 5l-3 3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
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
