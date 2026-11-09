import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  addPageAnnotation,
  addResponseAnnotation,
  clearResponseAnnotations,
  findAnnotationTarget,
  rangeAt,
  removeResponseAnnotation,
  selectionAnnotation,
  updateResponseAnnotation,
  useResponseAnnotations,
  ANNOTATION_TARGET_ATTR,
  type PageAnnotationTarget,
  type ResponseAnnotation,
  type ResponseAnnotationSource,
  type SentResponseAnnotation,
} from "../state/responseAnnotations";

/**
 * 回复 Claude 的某段话，参照 codex-app-server（client/src/components/ResponseAnnotations.tsx）：
 * - 在 Claude 的回复里选中文字，浮出「回复」
 * - 「回复」在选区上方写回复（可以不写），✓ 加进输入框里的「N 条注释」
 * - 加好的注释在原文的末尾显示编号，点编号（或「N 条注释」列表里的「编辑」）改回复、删除
 * - 发出后用户消息上方显示「N 条注释」，点开看所选文本和回复，点一条跳回原文
 * 右侧面板网页上点选元素写的标注也用这里的编辑框和「N 条注释」（见 FileBrowser 的 HtmlPreview）
 */

// ---------------------------------------------------------------------------
// CSS 高亮（不改 DOM）：写回复时选中的那段、跳回原文时闪一下

function setHighlight(name: string, range: Range | null) {
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!registry) return;
  if (range) registry.set(name, new Highlight(range));
  else registry.delete(name);
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** 滚动到原文那段并闪一下；原文不在页面上（例如折叠了）或文字对不上时返回 false */
function revealAnnotationSource(source: ResponseAnnotationSource) {
  const target = findAnnotationTarget(source.messageId);
  const range = target && rangeAt(target, source.startOffset, source.endOffset);
  if (!range) return false;
  range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  setHighlight("annotation-flash", range);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setHighlight("annotation-flash", null), 1600);
  return true;
}

// ---------------------------------------------------------------------------
// 编辑框的状态：全局只有一个

type EditorState =
  | { mode: "new"; sessionId: string; text: string; source: ResponseAnnotationSource; range: Range }
  | { mode: "edit"; sessionId: string; id: string; anchor: () => DOMRect | null }
  /** 网页上点选的元素，✓ 后加进「N 条注释」（要求可以不写）；onClose：编辑框关了（添加、取消、换成别的） */
  | { mode: "page"; sessionId: string; seq: number; text: string; page: PageAnnotationTarget; anchor: () => DOMRect | null; onClose?: () => void };

let editor: EditorState | null = null;
let pageSeq = 0;
const listeners = new Set<() => void>();
function setEditor(next: EditorState | null) {
  const prev = editor;
  editor = next;
  if (prev?.mode === "page" && prev !== next) prev.onClose?.();
  setHighlight("annotation-draft", next?.mode === "new" ? next.range : null);
  listeners.forEach((l) => l());
}
const useEditor = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => editor,
  );

/** 用当前选区开始写一条注释；选区不在 Claude 的回复里时返回 false */
function startAnnotationFromSelection() {
  const sel = selectionAnnotation();
  if (!sel) return false;
  window.getSelection()?.removeAllRanges();
  setEditor({ mode: "new", sessionId: sel.sessionId, text: sel.text, source: sel.source, range: sel.range });
  return true;
}

/** 网页上点了一个元素：打开编辑框写要求（可以不写），✓ 后加进「N 条注释」；anchor 是元素在界面上的位置（跟着网页滚动变） */
export function startPageAnnotation(
  sessionId: string,
  text: string,
  page: PageAnnotationTarget,
  anchor: () => DOMRect | null,
  onClose?: () => void,
) {
  setEditor({ mode: "page", sessionId, seq: ++pageSeq, text, page, anchor, onClose });
}

/** 改已有的注释，编辑框挂在 anchor 上（网页里的编号） */
export function editAnnotationAt(sessionId: string, id: string, anchor: () => DOMRect | null) {
  setEditor({ mode: "edit", sessionId, id, anchor });
}

/** 编辑框挂着的位置变了（网页里滚动），重新定位 */
export function repositionAnnotationEditor() {
  listeners.forEach((l) => l());
}

/** 正在写网页标注的编辑框关掉 */
export function closePageAnnotation() {
  if (editor?.mode === "page") setEditor(null);
}

const markerSelector = (id: string) => `[data-annotation-marker="${CSS.escape(id)}"]`;

/** 改已有的注释：挂在原文末尾的编号上；原文不在页面上（例如折叠了）时挂在输入框里的「N 条注释」上 */
function editAnnotation(sessionId: string, id: string) {
  const marker = document.querySelector(markerSelector(id));
  marker?.scrollIntoView({ block: "center" });
  const anchor = () => (document.querySelector(markerSelector(id)) ?? document.querySelector(".notes-chip"))?.getBoundingClientRect() ?? null;
  setEditor({ mode: "edit", sessionId, id, anchor });
}

// ---------------------------------------------------------------------------
// 选中文字后浮出的「回复」

const BUTTON_H = 32;
const BUTTON_W = 80;
const GAP = 6;

/**
 * 在 Claude 的回复里选中文字后，在选区末尾下方浮出「回复」。
 * 拖着选的时候不显示，松开鼠标后才出来；滚动时跟着选区走
 */
export function AnnotationSelectionButton({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let dragging = false;
    const update = () => {
      const area = scrollRef.current;
      const sel = !dragging && area && !editor ? selectionAnnotation() : null;
      if (!sel || !area?.contains(sel.range.commonAncestorContainer)) return setPos(null);
      const rects = sel.range.getClientRects();
      const last = rects[rects.length - 1] ?? sel.range.getBoundingClientRect();
      const first = rects[0] ?? last;
      const box = area.getBoundingClientRect();
      // 放在最后一行的下面，放不下时放到第一行上面
      let y = last.bottom + GAP;
      if (y + BUTTON_H > box.bottom) y = first.top - GAP - BUTTON_H;
      if (y < box.top || y + BUTTON_H > box.bottom) return setPos(null);
      const x = Math.min(Math.max(last.right - 32, box.left + 8), box.right - BUTTON_W - 8);
      setPos({ x, y });
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".annotation-toolbar"))) return;
      dragging = true;
      setPos(null);
    };
    const up = () => {
      dragging = false;
      // 等浏览器处理完这次点击（点在选区里会取消选中）
      setTimeout(update);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", update);
    const area = scrollRef.current;
    area?.addEventListener("scroll", update, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", update);
      area?.removeEventListener("scroll", update);
    };
  }, [scrollRef]);

  if (!pos) return null;
  return createPortal(
    <div
      className="annotation-toolbar"
      style={{ left: pos.x, top: pos.y }}
      // 按下时不让按钮抢走焦点、不取消选区
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button
        onClick={() => {
          if (startAnnotationFromSelection()) setPos(null);
        }}
      >
        <ReplyIcon />
        回复
      </button>
    </div>,
    document.body,
  );
}

function ReplyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 4 3 7.5 6.5 11" />
      <path d="M3.5 7.5h5.5a4 4 0 0 1 4 4V12" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.8 2.7l2.5 2.5M2.5 13.5l.6-3 7.7-7.8 2.5 2.5-7.8 7.7z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.6 9h6.8l.6-9M6.5 7v4M9.5 7v4" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5h-.5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 写回复 / 改回复的小框

const EDITOR_W = 340;

/** 写回复的框，挂在选区（新的注释）或编号（已有的）上方，放不下时放到下面；会话里只放一个。onSaved：添加、保存后调用（把焦点交给输入框，再按回车就发出去） */
export function AnnotationEditor({ sessionId, onSaved }: { sessionId: string | null; onSaved?: () => void }) {
  const state = useEditor();
  const annotations = useResponseAnnotations(sessionId);
  const [, rerender] = useState(0);
  // repositionAnnotationEditor 通知的是 useEditor 的订阅，state 没变也要重新渲染
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const current = state?.mode === "edit" ? annotations.find((a) => a.id === state.id) : null;
  const [draft, setDraft] = useState("");

  // 打开时填好原来的回复、聚焦
  const key = state
    ? state.mode === "edit"
      ? state.id
      : state.mode === "page"
        ? `page:${state.seq}`
        : `new:${state.source.messageId}:${state.source.startOffset}`
    : null;
  useEffect(() => {
    if (!key) return;
    setDraft(current?.annotation ?? "");
    requestAnimationFrame(() => {
      const el = textRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 切换会话、注释被删掉（例如在列表里删了）时关掉
  useEffect(() => {
    if (state && (state.sessionId !== sessionId || (state.mode === "edit" && !current))) setEditor(null);
  }, [state, sessionId, current]);

  // 跟着原文走：滚动、窗口大小变了重新定位；点外面、按 Esc 关掉
  useEffect(() => {
    if (!state) return;
    const move = () => rerender((n) => n + 1);
    const down = (e: PointerEvent) => {
      if (e.target instanceof Node && boxRef.current?.contains(e.target)) return;
      if (e.target instanceof Element && e.target.closest("[data-annotation-marker]")) return;
      setEditor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditor(null);
    };
    document.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [state]);

  // 自动增高
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight 不含边框，box-sizing 是 border-box，要加回去
    el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, 160)}px`;
  }, [draft, key]);

  if (!sessionId || !state || state.sessionId !== sessionId || (state.mode === "edit" && !current)) return null;
  const anchor = state.mode === "new" ? state.range.getBoundingClientRect() : state.anchor();
  if (!anchor) return null;
  const left = Math.min(Math.max(anchor.left - 12, 8), window.innerWidth - EDITOR_W - 8);
  const above = anchor.top > 180;
  const style = above ? { left, top: anchor.top - 8, transform: "translateY(-100%)" } : { left, top: anchor.bottom + 8 };

  const editingPage = state.mode === "page" || !!current?.page;
  const save = () => {
    if (state.mode === "page") addPageAnnotation(sessionId, state.text, draft, state.page);
    else if (state.mode === "new") addResponseAnnotation(sessionId, state.text, draft, state.source);
    else updateResponseAnnotation(sessionId, state.id, draft);
    setEditor(null);
    onSaved?.();
  };

  return createPortal(
    <div ref={boxRef} className={`annotation-editor${state.mode === "edit" ? " annotation-editor-edit" : ""}`} style={{ ...style, width: EDITOR_W }}>
      <textarea
        ref={textRef}
        rows={1}
        value={draft}
        placeholder={editingPage ? "写下要怎么改…" : "添加可选回复…"}
        aria-label={editingPage ? "标注" : "回复"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
      />
      {state.mode !== "edit" ? (
        <button className="annotation-editor-ok" title="添加" aria-label="添加" onClick={save}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m3.5 8.5 3 3 6-7" />
          </svg>
        </button>
      ) : (
        <div className="annotation-editor-actions">
          <button
            className="icon-btn"
            title="删除"
            aria-label="删除"
            onClick={() => {
              removeResponseAnnotation(sessionId, state.id);
              setEditor(null);
            }}
          >
            <TrashIcon />
          </button>
          <span className="annotation-editor-spacer" />
          <button onClick={() => setEditor(null)}>取消</button>
          <button className="primary" onClick={save}>
            保存
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Claude 的一段回复：正文带着位置标记，待发送的注释在原文末尾显示编号

/** 对话区所属的会话，Claude 的回复文字从这里知道注释记在哪个会话下；没有（新会话页）时不显示编号 */
export const AnnotationSessionContext = createContext<string | null>(null);

/** Claude 的一段回复文字（messageId 是这段的 key） */
export function AnnotatableText({ messageId, children }: { messageId: string; children: ReactNode }) {
  const sessionId = useContext(AnnotationSessionContext);
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={boxRef} className="assistant annotatable">
      <div ref={bodyRef} {...{ [ANNOTATION_TARGET_ATTR]: messageId }}>
        {children}
      </div>
      {sessionId && <AnnotationMarkers sessionId={sessionId} messageId={messageId} root={bodyRef} box={boxRef} />}
    </div>
  );
}

/** 待发送的注释在原文末尾显示编号（编号是在列表里的顺序），点了改回复 */
function AnnotationMarkers({
  sessionId,
  messageId,
  root,
  box,
}: {
  sessionId: string;
  messageId: string;
  root: RefObject<HTMLElement | null>;
  box: RefObject<HTMLElement | null>;
}) {
  const all = useResponseAnnotations(sessionId);
  const [marks, setMarks] = useState<{ id: string; n: number; x: number; y: number }[]>([]);
  const mine = all.map((a, i) => ({ a, n: i + 1 })).filter(({ a }) => a.source?.messageId === messageId);
  const sig = mine.map(({ a, n }) => `${a.id}:${n}`).join(",");

  useLayoutEffect(() => {
    const rootEl = root.current;
    const boxEl = box.current;
    if (!rootEl || !boxEl || !sig) return setMarks([]);
    const layout = () => {
      const base = boxEl.getBoundingClientRect();
      setMarks(
        mine.flatMap(({ a, n }) => {
          const range = rangeAt(rootEl, a.source!.startOffset, a.source!.endOffset);
          const rects = range?.getClientRects();
          const last = rects?.[rects.length - 1];
          return last ? [{ id: a.id, n, x: last.right - base.left, y: last.top - base.top }] : [];
        }),
      );
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(boxEl);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, root, box]);

  return (
    <>
      {marks.map((m) => (
        <button
          key={m.id}
          className="annotation-marker"
          data-annotation-marker={m.id}
          style={{ left: m.x, top: m.y }}
          title="编辑注释"
          aria-label={`注释 ${m.n}`}
          onClick={() => editAnnotation(sessionId, m.id)}
        >
          {m.n}
        </button>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// 输入框里的「N 条注释」

const noteLabel = (a: SentResponseAnnotation) => (a.page ? `网页元素（${a.page.file}）：` : "所选文本：");

/** 输入框里待发送的注释：鼠标移上去展开列表，每条可以编辑、删除；× 全部不发送 */
export function NotesChip({ sessionId, annotations }: { sessionId: string; annotations: ResponseAnnotation[] }) {
  // 点了「编辑」后收起列表（编辑框在别处打开），鼠标移开后才恢复悬停展开
  const [hidden, setHidden] = useState(false);
  if (annotations.length === 0) return null;
  return (
    <div className="notes-chip-row">
      <div className={`notes-chip-wrap${hidden ? " pop-hidden" : ""}`} onMouseLeave={() => setHidden(false)}>
        <div className="notes-pop">
          <div className="notes-list">
            {annotations.map((a, i) => (
              <div key={a.id} className="notes-item">
                <span className="notes-item-num">{i + 1}.</span>
                <div className="notes-item-body">
                  <div className="notes-item-label">{noteLabel(a)}</div>
                  <div className="notes-item-text">{a.text}</div>
                  {a.annotation && (
                    <>
                      <div className="notes-item-label">用户回复：</div>
                      <div className="notes-item-text">{a.annotation}</div>
                    </>
                  )}
                </div>
                <span className="notes-item-actions">
                  <button
                    className="icon-btn"
                    title="编辑"
                    onClick={() => {
                      setHidden(true);
                      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                      editAnnotation(sessionId, a.id);
                    }}
                  >
                    <EditIcon />
                  </button>
                  <button className="icon-btn" title="删除" onClick={() => removeResponseAnnotation(sessionId, a.id)}>
                    <TrashIcon />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
        <span className="notes-chip">
          <NoteIcon />
          {annotations.length} 条注释
          <button className="notes-chip-clear" title="全部不发送" aria-label="全部不发送" onClick={() => clearResponseAnnotations(sessionId)}>
            ×
          </button>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 发出去以后

/** 用户消息里带的注释：「N 条注释」，点开看所选文本和回复，点一条跳回原文 */
export function SentNotesChip({ annotations }: { annotations: SentResponseAnnotation[] }) {
  const [open, setOpen] = useState(false);
  if (annotations.length === 0) return null;
  return (
    <div className="sent-notes">
      <button className="sent-notes-chip" onClick={() => setOpen((o) => !o)} title={open ? "收起" : "查看注释"}>
        <NoteIcon />
        {annotations.length} 条注释
      </button>
      {open && (
        <ol className="sent-notes-list">
          {annotations.map((a, i) => (
            <li key={i}>
              <button className="sent-note" disabled={!a.source} onClick={() => a.source && revealAnnotationSource(a.source)}>
                <span className="notes-item-label">{noteLabel(a)}</span>
                <span className="sent-note-text">{a.text}</span>
                {a.annotation && (
                  <>
                    <span className="notes-item-label">用户回复：</span>
                    <span className="sent-note-text">{a.annotation}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
