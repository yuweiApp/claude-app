import { useEffect, useRef, useState, type ReactNode } from "react";
import { Annotation, Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction, countColumn, type Extension } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers, placeholder as placeholderText, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { codeFolding, foldGutter, foldKeymap, foldService, foldedRanges, unfoldEffect } from "@codemirror/language";

/*
 * 右侧面板查看、编辑文本文件的编辑器（CodeMirror）：行号、按缩进折叠（同 VS Code 没有语言支持时的折叠方式），
 * Ctrl/⌘+S 保存，Tab 缩进。value 用 \n 换行（CRLF 的文件由外面换好）。
 * 查找栏（Ctrl/⌘+F，由外面的 findRequest 打开）、定位到行（line + reveal）也在这里。
 * 外面的内容变了（文件被改动后重新读取）只替换变了的那一段，折叠、滚动位置、光标跟着保留
 */

/** 外面传进来的内容，不算用户的修改，也不进撤销历史 */
const external = Annotation.define<boolean>();

/** 文件里的行范围（从 1 开始，含 end） */
export interface LineRange {
  start: number;
  end: number;
}

export interface CodeEditorProps {
  value: string;
  readOnly: boolean;
  placeholder: string;
  /** 要定位的行；reveal 变了（再点一次同一个链接）重新定位 */
  line: LineRange | null;
  reveal: number;
  /** 变了（Ctrl/⌘+F）就打开查找栏，焦点放进去；选中了一行以内的文字时拿它当查找内容 */
  findRequest: number;
  onChange: (value: string) => void;
  onSave: () => void;
}

export function CodeEditor({ value, readOnly, placeholder, line, reveal, findRequest, onChange, onSave }: CodeEditorProps) {
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyConf = useRef(new Compartment());
  const initial = useRef({ value, readOnly, placeholder });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          lineNumbers(),
          foldGutter({ markerDOM: foldMarker }),
          codeFolding({ placeholderText: "…" }),
          indentFolding,
          highlightSpecialChars(),
          drawSelection(),
          history(),
          EditorState.tabSize.of(4),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                latest.current.onSave();
                return true;
              },
            },
            ...foldKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
          readOnlyConf.current.of(EditorState.readOnly.of(initial.current.readOnly)),
          initial.current.placeholder ? placeholderText(initial.current.placeholder) : [],
          findMarks,
          editorTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) latest.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 外面的内容变了：只替换两头相同部分中间的那一段，折叠和光标随改动挪动
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    if (value === doc) return;
    let from = 0;
    const max = Math.min(doc.length, value.length);
    while (from < max && doc.charCodeAt(from) === value.charCodeAt(from)) from++;
    let end = 0;
    while (end < max - from && doc.charCodeAt(doc.length - 1 - end) === value.charCodeAt(value.length - 1 - end)) end++;
    view.dispatch({
      changes: { from, to: doc.length - end, insert: value.slice(from, value.length - end) },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyConf.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  // 定位到行：选中这几行，滚到上方三分之一处；在折叠里的先展开。超出文件末尾的部分不算
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !line || line.start > view.state.doc.lines) return;
    const doc = view.state.doc;
    const from = doc.line(line.start).from;
    const to = doc.line(Math.min(line.end, doc.lines)).to;
    view.focus();
    select(view, from, to, "start");
    // 只在打开、再点同一个链接时定位，不随编辑、文件被改重新定位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, line?.start, line?.end]);

  const find = useFind(viewRef, value, findRequest);
  return (
    <>
      {find}
      <div className="code-editor" ref={hostRef} />
    </>
  );
}

/** 选中 from..to 并滚到看得见（y：start 是上方三分之一处，center 是中间）；落在折叠里的先展开 */
function select(view: EditorView, from: number, to: number, y: "start" | "center") {
  const unfold: StateEffect<{ from: number; to: number }>[] = [];
  foldedRanges(view.state).between(from, to, (a, b) => {
    unfold.push(unfoldEffect.of({ from: a, to: b }));
  });
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: [...unfold, EditorView.scrollIntoView(from, { y, yMargin: y === "start" ? view.scrollDOM.clientHeight / 3 : 5 })],
  });
}

// ---------------------------------------------------------------------------
// 按缩进折叠：这一行后面缩进更深的连续几行（中间的空行算进去，末尾的空行不算）

/** 一行最多往下找这么多行，免得很大的文件里每画一个折叠标记都扫一遍全文 */
const FOLD_SCAN_LINES = 20000;

const indentFolding = foldService.of((state, lineStart) => {
  const doc = state.doc;
  const first = doc.lineAt(lineStart);
  const indent = lineIndent(first.text, state.tabSize);
  if (indent === null) return null;
  let last = first.number;
  const stop = Math.min(doc.lines, first.number + FOLD_SCAN_LINES);
  for (let n = first.number + 1; n <= stop; n++) {
    const ind = lineIndent(doc.line(n).text, state.tabSize);
    if (ind === null) continue;
    if (ind <= indent) break;
    last = n;
  }
  return last > first.number ? { from: first.to, to: doc.line(last).to } : null;
});

/** 行首空白的宽度；空行（只有空白）返回 null */
function lineIndent(text: string, tabSize: number): number | null {
  const m = /^[ \t]*/.exec(text)![0];
  return m.length === text.length ? null : countColumn(m, tabSize);
}

/** 折叠标记：能折叠的是朝下的箭头，折叠了的朝右 */
function foldMarker(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = `cm-fold-marker${open ? "" : " folded"}`;
  span.title = open ? "折叠" : "展开";
  span.innerHTML =
    '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3"/></svg>';
  return span;
}

// ---------------------------------------------------------------------------
// 查找：不分大小写；Enter / Shift+Enter 下一个、上一个，Esc 关闭（把当前这处选中在编辑器里）

/** 查找结果最多标这么多处 */
const MAX_MATCHES = 5000;

const setFindMarks = StateEffect.define<{ ranges: number[]; length: number; current: number }>();
const matchMark = Decoration.mark({ class: "cm-find-match" });
const currentMark = Decoration.mark({ class: "cm-find-match cm-find-current" });

/** 查找结果的高亮，随编辑挪动位置；查找内容变了、换了当前这处时整个换掉 */
const findMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setFindMarks)) continue;
      const b = new RangeSetBuilder<Decoration>();
      e.value.ranges.forEach((at, i) => b.add(at, at + e.value.length, i === e.value.current ? currentMark : matchMark));
      next = b.finish();
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function useFind(viewRef: { current: EditorView | null }, value: string, request: number): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = (() => {
    if (!open || !query) return [];
    const hay = value.toLowerCase();
    const needle = query.toLowerCase();
    // 转小写后长度变了的（少数特殊字符）位置对不上，不查
    if (hay.length !== value.length) return [];
    const out: number[] = [];
    for (let i = hay.indexOf(needle); i >= 0 && out.length < MAX_MATCHES; i = hay.indexOf(needle, i + needle.length)) out.push(i);
    return out;
  })();
  const current = matches.length ? Math.min(index, matches.length - 1) : -1;
  const step = (d: number) => matches.length && setIndex((i) => (Math.min(i, matches.length - 1) + d + matches.length) % matches.length);
  const key = matches.join(",");

  // 高亮跟着结果和当前这处走；当前这处滚到中间（在折叠里的先展开）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setFindMarks.of({ ranges: matches, length: query.length, current }) });
    if (current < 0) return;
    const at = matches[current]!;
    const unfold: StateEffect<{ from: number; to: number }>[] = [];
    foldedRanges(view.state).between(at, at + query.length, (a, b) => {
      unfold.push(unfoldEffect.of({ from: a, to: b }));
    });
    view.dispatch({ effects: [...unfold, EditorView.scrollIntoView(at, { y: "center" })] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, current, query.length]);

  // 打开（再按一次也是）：选中的一行以内的文字作为查找内容，焦点放进查找框并全选
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (!request) return;
    const view = viewRef.current;
    const sel = view?.state.selection.main;
    const text = view && sel && !sel.empty ? view.state.sliceDoc(sel.from, sel.to) : "";
    if (text && !text.includes("\n")) {
      setQuery(text);
      setIndex(0);
    }
    setOpen(true);
    setFocusTick((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  useEffect(() => {
    if (!focusTick) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  const close = () => {
    setOpen(false);
    const view = viewRef.current;
    if (!view) return;
    view.focus();
    if (current >= 0) select(view, matches[current]!, matches[current]! + query.length, "center");
  };

  if (!open) return null;
  return (
    <div className="viewer-find">
      <input
        ref={inputRef}
        aria-label="在文件中查找"
        placeholder="在文件中查找…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      <span className="viewer-find-count">
        {query ? (matches.length ? `${current + 1} / ${matches.length}${matches.length >= MAX_MATCHES ? "+" : ""}` : "无结果") : ""}
      </span>
      <button className="icon-btn" title="上一个（Shift+Enter）" aria-label="上一个结果" disabled={!matches.length} onClick={() => step(-1)}>
        <Arrow up />
      </button>
      <button className="icon-btn" title="下一个（Enter）" aria-label="下一个结果" disabled={!matches.length} onClick={() => step(1)}>
        <Arrow />
      </button>
      <button className="icon-btn" title="关闭（Esc）" aria-label="关闭查找" onClick={close}>
        ×
      </button>
    </div>
  );
}

function Arrow({ up = false }: { up?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: up ? "rotate(-90deg)" : "rotate(90deg)" }}>
      <path d="M3.5 2 6.5 5l-3 3" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 样式：和原来的文本框一样的等宽字体、行高，颜色用界面的变量

const editorTheme: Extension = EditorView.theme({
  "&": { height: "100%", color: "var(--text)", backgroundColor: "transparent", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: 'ui-monospace, "Cascadia Code", "SFMono-Regular", Menlo, Consolas, monospace', lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "8px 0 24px", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 12px 0 4px" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 12px", minWidth: "32px" },
  ".cm-foldGutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", width: "16px", cursor: "pointer" },
  ".cm-fold-marker": { display: "inline-flex", color: "var(--muted)", opacity: "0", transition: "opacity 0.15s" },
  ".cm-fold-marker:not(.folded) svg": { transform: "rotate(90deg)" },
  // 同 VS Code：鼠标移到行号栏上才显示可折叠的箭头，折叠了的一直显示
  ".cm-gutters:hover .cm-fold-marker, .cm-fold-marker.folded": { opacity: "1" },
  ".cm-foldPlaceholder": {
    margin: "0 4px",
    padding: "0 6px",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    backgroundColor: "var(--panel)",
    color: "var(--muted)",
    cursor: "pointer",
  },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-find-match": { backgroundColor: "color-mix(in srgb, #d9b45a 40%, transparent)", borderRadius: "2px" },
  ".cm-find-current": { backgroundColor: "color-mix(in srgb, #e0a030 75%, transparent)" },
});
