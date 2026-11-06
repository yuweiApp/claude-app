import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { api, RequestError, type FileContent, type ProjectEntry } from "../api";
import { getDraft, setDraft, useHasDraft } from "../state/fileDrafts";
import { useDismiss } from "./ComposerPickers";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";
import { MarkdownLiveEditor } from "./MarkdownLiveEditor";

/**
 * 右侧面板的文件工具（同 codex-app-server 的 FileBrowser）：上面是切换文件树、文件名、复制路径和操作按钮，
 * 下面左边是目录树（可以收起）、右边是文件内容。没选文件时是「打开文件」：提示从目录树里选。
 * 文本打开就能编辑（Ctrl+S 保存，不自动保存）；Markdown 默认所见即所得，直接在渲染效果上改（MarkdownLiveEditor，编辑的是源码），
 * 「预览 / 源代码」开关切到源代码编辑
 */
export function FileBrowser({
  cwd,
  path,
  active,
  onSelectFile,
  onEdited,
}: {
  cwd: string;
  /** 打开的文件（相对项目文件夹）；null 是「打开文件」 */
  path: string | null;
  /** 这个标签页在前面：轮询文件有没有被改 */
  active: boolean;
  /** 在目录树里选了文件；pin 是双击（固定打开），否则是预览打开 */
  onSelectFile: (path: string, pin: boolean) => void;
  /** 改了内容：预览打开的标签要固定下来 */
  onEdited: () => void;
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
  const tree = treeOpen ? <FileTree cwd={cwd} activePath={path} autoFocus={path === null} onSelect={onSelectFile} /> : null;

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
  if (!c) treeCaches.set(cwd, (c = { expanded: new Set(), dirs: {}, scrollTop: 0 }));
  return c;
};

const basename = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p).split("/").pop() || p;
const parentOf = (p: string) => {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i + 1);
};

/**
 * 目录树（同 codex-app-server 的 FileTree）：顶部「筛选文件…」（在整个项目里按名字搜），没在筛选时是刷新按钮；
 * 单击文件预览打开，双击固定打开，点文件夹展开、收起；右边缘拖动调宽度
 */
function FileTree({ cwd, activePath, autoFocus, onSelect }: { cwd: string; activePath: string | null; autoFocus: boolean; onSelect: (path: string, pin: boolean) => void }) {
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
    for (let dir = parentOf(activePath); dir; dir = parentOf(dir)) {
      if (!cache.expanded.has(dir)) {
        cache.expanded.add(dir);
        changed = true;
      }
      if (!cache.dirs[dir]) void load(dir);
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
    // 根目录空着（比如普通会话刚建的 scratch 目录）也写一句，不然面板一片空白
    if (!list.length) rows.push(<div key={`${dir}:empty`} className="files-note" style={{ paddingLeft: pad + 18 }}>空文件夹</div>);
    for (const entry of list) {
      const name = basename(entry.path);
      const open = entry.dir && cache.expanded.has(entry.path);
      rows.push(
        <button
          key={entry.path}
          data-path={entry.path}
          className={`files-row${entry.path === activePath ? " selected" : ""}`}
          style={{ paddingLeft: pad }}
          title={entry.path}
          onClick={() => (entry.dir ? toggle(entry.path) : onSelect(entry.path, false))}
          onDoubleClick={() => !entry.dir && onSelect(entry.path, true)}
        >
          <span className="files-caret">{entry.dir && <Chevron open={open} />}</span>
          <span className="files-icon">{entry.dir ? <FolderTypeIcon open={open} name={name} /> : <TreeFileIcon key={entry.mtimeMs} cwd={cwd} entry={entry} />}</span>
          <span className="files-name">{name}</span>
        </button>,
      );
      if (open) renderDir(entry.path, depth + 1);
    }
  };
  if (hits === null) renderDir("", 0);

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
      <div className="file-tree-list" ref={listRef} onScroll={(e) => hits === null && (cache.scrollTop = e.currentTarget.scrollTop)}>
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
    </div>
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

function FileViewer({
  cwd,
  path,
  active,
  treeToggle,
  tree,
  onEdited,
  onOpenFile,
}: {
  cwd: string;
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
  // Markdown 默认显示渲染效果，开关切到源代码
  const [rendered, setRendered] = useState(true);
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
