import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Annotation, Compartment, EditorState, Facet, StateEffect, StateField, Transaction, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder as placeholderText,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { api } from "../api";
import { MermaidBlock } from "./MermaidBlock";

/*
 * 从 codex-app-server 的 MarkdownLiveEditor 移植（去掉了选中文字后的「添加到对话」）。
 * Markdown 的实时预览编辑（与 ChatGPT 桌面应用一致，用 CodeMirror）：编辑的始终是源码，只是把 Markdown 符号藏起来、
 * 按渲染效果显示。整个标题、链接、强调都选中时才露出它的符号；表格的每一行排成表格的样子（竖线藏起来，单元格按列对齐）。
 * 本项目加的：```mermaid 代码块显示成图（和回复里一样，MermaidBlock），光标进到代码块里时露出源码、图跟在下面；
 * 图片写法指向视频、音频文件时显示播放器，HTML 写的 <img>、<video>、<audio> 也显示出来。
 * 保存的就是源码本身，不会改动没编辑过的地方
 */

/** 外面传进来的内容（文件重新读取、源代码里改过），不算用户的修改，也不进撤销历史 */
const external = Annotation.define<boolean>();

interface PreviewOptions {
  /** 图片地址：本地路径换成经网关读取的地址 */
  resolveSrc: (src: string) => string;
  /** 点链接 */
  openHref: (href: string, e: MouseEvent) => void;
}

/** 这个编辑器的选项：状态字段给出的小部件（占整行的）从这里取 */
const previewOptions = Facet.define<PreviewOptions, PreviewOptions | null>({ combine: (values) => values[0] ?? null });

// ---------------------------------------------------------------------------
// 图片、视频、音频：Markdown 的图片写法（![说明](地址)，按地址的扩展名分），或 HTML 的 <img>、<video>、<audio>

interface MediaSpec {
  tag: "img" | "video" | "audio";
  src: string;
  alt: string;
  /** HTML 标签上写的宽高：数字是像素，也可以带单位 */
  width?: string;
  height?: string;
  poster?: string;
  loop?: boolean;
  muted?: boolean;
  autoplay?: boolean;
}

// 同网关 files.ts 的 VIDEO_TYPES、AUDIO_TYPES（/files/raw 按这些扩展名给类型，支持拖动进度条）
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

/** 图片写法的地址指向的是什么：按扩展名认视频、音频，其余当图片 */
function mediaTag(src: string): MediaSpec["tag"] {
  const path = src.replace(/[?#].*$/, "");
  return VIDEO_EXT.test(path) ? "video" : AUDIO_EXT.test(path) ? "audio" : "img";
}

const cssSize = (value: string | undefined) => {
  const v = value?.trim() ?? "";
  return /^\d+(\.\d+)?$/.test(v) ? `${v}px` : /^\d+(\.\d+)?(px|%|em|rem|vw|vh)$/i.test(v) ? v : null;
};

function mediaElement(spec: MediaSpec, resolve: (src: string) => string): HTMLElement {
  const el = document.createElement(spec.tag);
  el.className = spec.tag === "img" ? "cm-md-image" : `cm-md-${spec.tag}`;
  el.src = resolve(spec.src);
  el.title = spec.alt;
  if (el instanceof HTMLImageElement) {
    el.alt = spec.alt;
    el.referrerPolicy = "no-referrer";
  } else {
    el.controls = true;
    el.preload = "metadata";
    el.loop = Boolean(spec.loop);
    el.muted = Boolean(spec.muted);
    // 静音的才自动播放（当动图用的视频）
    el.autoplay = Boolean(spec.autoplay && spec.muted);
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      if (spec.poster) el.poster = resolve(spec.poster);
    }
  }
  if (spec.tag !== "audio") {
    // 写了宽高的按写的来（不再限高），只写一个时另一个按比例
    const width = cssSize(spec.width);
    const height = cssSize(spec.height);
    if (width) el.style.width = width;
    else if (height) el.style.height = height;
    if (width || height) el.style.maxHeight = "none";
  }
  // 读不到（没有会话时的本地文件、地址失效、浏览器放不了的编码）：和回复里一样显示替代文字
  el.addEventListener("error", () => {
    const span = document.createElement("span");
    span.className = "cm-md-image-broken";
    span.textContent = `${spec.tag === "img" ? "图片" : spec.tag === "video" ? "视频" : "音频"}无法显示：${spec.alt || spec.src}`;
    el.replaceWith(span);
  });
  return el;
}

/** 只起包裹、排版作用的标签，里面接着找；<source> 跟着 <video>、<picture> 走，不单独算 */
const MEDIA_WRAPPERS = new Set(["P", "DIV", "CENTER", "A", "SPAN", "FIGURE", "PICTURE", "BR", "SOURCE"]);

/**
 * 一段 HTML 里除了图片、视频、音频（可以包在 <p align="center">、<a> 这类标签里）没有别的内容时，取出它们；
 * 夹着文字或别的标签的不算（照旧显示源码）
 */
function parseMedia(html: string): { items: MediaSpec[]; center: boolean } | null {
  if (!/<(img|video|audio)\b/i.test(html)) return null;
  // DOMParser 建的文档不加载资源、不执行脚本，只用来读属性
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const items: MediaSpec[] = [];
  let center = false;
  const walk = (parent: Element): boolean => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.COMMENT_NODE) continue;
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent?.trim()) return false;
        continue;
      }
      if (!(child instanceof Element)) return false;
      const tag = child.tagName;
      if (tag === "IMG" || tag === "VIDEO" || tag === "AUDIO") {
        // <video> 里面的 <source> 取第一个；里面写给旧浏览器看的文字不管
        const src = child.getAttribute("src") ?? child.querySelector("source[src]")?.getAttribute("src");
        if (!src) return false;
        items.push({
          tag: tag.toLowerCase() as MediaSpec["tag"],
          src,
          alt: child.getAttribute("alt") ?? child.getAttribute("title") ?? "",
          width: child.getAttribute("width") ?? undefined,
          height: child.getAttribute("height") ?? undefined,
          poster: child.getAttribute("poster") ?? undefined,
          loop: child.hasAttribute("loop"),
          muted: child.hasAttribute("muted"),
          autoplay: child.hasAttribute("autoplay"),
        });
        continue;
      }
      if (!MEDIA_WRAPPERS.has(tag)) return false;
      if (tag === "CENTER" || child.getAttribute("align")?.toLowerCase() === "center") center = true;
      if (!walk(child)) return false;
    }
    return true;
  };
  return walk(body) && items.length ? { items, center } : null;
}

// ---------------------------------------------------------------------------
// 小部件

/** 行内的图片、视频、音频 */
class MediaWidget extends WidgetType {
  readonly key: string;
  constructor(
    readonly spec: MediaSpec,
    readonly resolve: (src: string) => string,
  ) {
    super();
    this.key = JSON.stringify(spec);
  }
  eq(other: MediaWidget) {
    return other.key === this.key;
  }
  toDOM() {
    return mediaElement(this.spec, this.resolve);
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "•";
    return span;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-hr";
    return span;
  }
}

/** 任务列表的 [ ] / [x]：显示成复选框，点一下改源码里的那个字符 */
class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 行内的装饰：藏符号、换成小部件、按行加样式

const hide = Decoration.replace({});
// inclusive：单元格两头藏起来的符号（比如行内代码的反引号）也包在单元格里，每个单元格只有一个元素
const cellMark = Decoration.mark({ class: "cm-md-table-cell", inclusive: true });

/** 表格一行里各单元格的范围（两条竖线之间，含两边的空格）；行首、行尾的竖线外面不算单元格 */
function tableCells(row: SyntaxNode): [number, number][] {
  const cells: [number, number][] = [];
  let prev = row.from;
  for (const d of row.getChildren("TableDelimiter")) {
    cells.push([prev, d.from]);
    prev = d.to;
  }
  cells.push([prev, row.to]);
  if (cells.length > 1 && cells[0]![0] === cells[0]![1]) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]![0] === cells[cells.length - 1]![1]) cells.pop();
  return cells;
}
const lineClass = (cls: string) => Decoration.line({ class: cls });

function inlineDecorations(view: EditorView, opts: PreviewOptions): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const sel = state.selection.main;
  // 与 ChatGPT 一致：光标停着、只选中一部分时都不露符号，整个元素都选中了才露出它的符号（选区松开鼠标时已经把符号选进来了）。
  // 编辑器没有焦点、按着鼠标拖选时不露，免得文字跳动
  const active = view.hasFocus && !sel.empty && !state.field(dragging, false);
  const covered = (from: number, to: number) => active && sel.from <= from && sel.to >= to;
  const lineEnd = (pos: number) => doc.lineAt(pos).to;
  const out: Range<Decoration>[] = [];
  const conceal = (from: number, to: number) => from < to && out.push(hide.range(from, to));
  const eachLine = (from: number, to: number, cls: (n: number, first: number, last: number) => string) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) out.push(lineClass(cls(n, first, last)).range(doc.line(n).from));
  };
  const children = (n: SyntaxNodeRef, name: string) => n.node.getChildren(name);
  // 源码整块收起来、只显示图或播放器的块（previewBlocks），不再给它们加行样式
  const hiddenBlocks = state.field(previewBlocks, false)?.hidden;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (n) => {
        const name = n.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(lineClass(`cm-md-h${heading[1]}`).range(doc.lineAt(n.from).from));
          if (!covered(n.from, n.to)) {
            for (const m of children(n, "HeaderMark")) {
              // 开头的 # 连同后面的空格，结尾的 # 连同前面的空格
              if (m.from === n.from) conceal(m.from, Math.min(m.to + 1, n.to));
              else conceal(Math.max(m.from - 1, n.from), m.to);
            }
          }
          return;
        }
        switch (name) {
          case "Emphasis":
          case "StrongEmphasis":
          case "Strikethrough":
            if (!covered(n.from, n.to)) for (const m of [...children(n, "EmphasisMark"), ...children(n, "StrikethroughMark")]) conceal(m.from, m.to);
            return;
          case "InlineCode": {
            out.push(Decoration.mark({ class: "cm-md-inline-code" }).range(n.from, n.to));
            if (!covered(n.from, n.to)) for (const m of children(n, "CodeMark")) conceal(m.from, m.to);
            return false;
          }
          case "FencedCode": {
            // 显示成图的 mermaid 代码块：源码整块收起来了
            if (hiddenBlocks?.has(doc.lineAt(n.from).from)) return false;
            eachLine(n.from, n.to, (k, first, last) => `cm-md-code${k === first ? " cm-md-code-first" : ""}${k === last ? " cm-md-code-last" : ""}`);
            if (!covered(n.from, n.to)) {
              const firstLine = doc.lineAt(n.from);
              const lastLine = doc.lineAt(n.to);
              conceal(firstLine.from, firstLine.to);
              if (lastLine.number > firstLine.number && /^\s*(```|~~~)/.test(lastLine.text)) conceal(lastLine.from, lastLine.to);
            }
            return false;
          }
          case "Blockquote":
            eachLine(n.from, n.to, () => "cm-md-quote");
            return;
          case "QuoteMark":
            if (!covered(n.from, lineEnd(n.from))) conceal(n.from, doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to);
            return;
          case "ListMark":
            // 列表项换行后和文字对齐（悬挂缩进）
            out.push(lineClass("cm-md-list-item").range(doc.lineAt(n.from).from));
            if (n.node.parent?.parent?.name !== "BulletList" || covered(n.from, lineEnd(n.from))) return;
            // 任务项只显示复选框（和渲染效果一样），其他换成圆点
            if (n.node.parent.getChild("Task")) conceal(n.from, doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to);
            else out.push(Decoration.replace({ widget: new BulletWidget() }).range(n.from, n.to));
            return;
          case "TaskMarker":
            if (!covered(n.from, n.to)) {
              const checked = /x/i.test(doc.sliceString(n.from, n.to));
              out.push(Decoration.replace({ widget: new TaskWidget(checked, n.from) }).range(n.from, n.to));
            }
            return;
          case "Link":
          case "Autolink": {
            const marks = children(n, "LinkMark");
            const url = n.node.getChild("URL");
            const href = url ? doc.sliceString(url.from, url.to) : "";
            // [文字](地址)：只留文字；<网址>：去掉尖括号
            const textFrom = name === "Link" ? marks[0]?.to : url?.from;
            const textTo = name === "Link" ? marks[1]?.from : url?.to;
            if (textFrom === undefined || textTo === undefined) return false;
            if (textFrom < textTo) out.push(Decoration.mark({ class: "cm-md-link", attributes: href ? { "data-href": href } : {} }).range(textFrom, textTo));
            if (!covered(n.from, n.to)) {
              conceal(n.from, textFrom);
              conceal(textTo, n.to);
            }
            return false;
          }
          case "Image": {
            if (covered(n.from, n.to)) return false;
            const marks = children(n, "LinkMark");
            const url = n.node.getChild("URL");
            if (!url || marks.length < 2) return false;
            const alt = doc.sliceString(marks[0]!.to, marks[1]!.from);
            const src = doc.sliceString(url.from, url.to);
            out.push(Decoration.replace({ widget: new MediaWidget({ tag: mediaTag(src), src, alt }, opts.resolveSrc) }).range(n.from, n.to));
            return false;
          }
          case "HTMLTag": {
            // 段落里的 <img …>、<video …>…</video>、<audio …>…</audio>（单独成块的见 previewBlocks）
            const open = /^<(img|video|audio)\b/i.exec(doc.sliceString(n.from, Math.min(n.to, n.from + 8)));
            if (!open) return;
            let to = n.to;
            if (open[1]!.toLowerCase() !== "img") {
              const close = new RegExp(`^</${open[1]}\\s*>$`, "i");
              let end = n.node.nextSibling;
              while (end && !(end.name === "HTMLTag" && close.test(doc.sliceString(end.from, end.to)))) end = end.nextSibling;
              if (!end) return;
              to = end.to;
            }
            // 插件给的装饰不能跨行
            if (lineEnd(n.from) < to || covered(n.from, to)) return;
            const media = parseMedia(doc.sliceString(n.from, to));
            if (media) out.push(Decoration.replace({ widget: new MediaWidget(media.items[0]!, opts.resolveSrc) }).range(n.from, to));
            return;
          }
          case "URL":
            // GFM 的裸网址
            out.push(Decoration.mark({ class: "cm-md-link", attributes: { "data-href": doc.sliceString(n.from, n.to) } }).range(n.from, n.to));
            return;
          case "HorizontalRule":
            if (!covered(n.from, n.to)) out.push(Decoration.replace({ widget: new HrWidget() }).range(n.from, n.to));
            return false;
          case "Table": {
            // 与 ChatGPT 一致：每一行排成表格（行是 flex，单元格平分宽度），竖线和单元格两边的空格藏起来；
            // 分隔行（| --- |）收起来。单元格里的行内代码、链接照常处理，可以直接选中、编辑
            for (let row = n.node.firstChild; row; row = row.nextSibling) {
              const line = doc.lineAt(row.from);
              if (row.name === "TableDelimiter") {
                out.push(lineClass("cm-md-table-delim").range(line.from));
                conceal(row.from, row.to);
                continue;
              }
              if (row.name !== "TableHeader" && row.name !== "TableRow") continue;
              out.push(lineClass(`cm-md-table-row${row.name === "TableHeader" ? " cm-md-table-header" : ""}`).range(line.from));
              for (const d of row.getChildren("TableDelimiter")) conceal(d.from, d.to);
              for (const [from, to] of tableCells(row)) {
                const text = doc.sliceString(from, to);
                const a = from + (text.length - text.trimStart().length);
                const b = to - (text.length - text.trimEnd().length);
                if (a < b) {
                  conceal(from, a);
                  out.push(cellMark.range(a, b));
                  conceal(b, to);
                } else if (from < to) out.push(cellMark.range(from, to));
              }
            }
            return;
          }
          case "HTMLBlock":
          case "CommentBlock":
            if (hiddenBlocks?.has(doc.lineAt(n.from).from)) return false;
            eachLine(n.from, n.to, () => "cm-md-html");
            return false;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

function livePreview(opts: PreviewOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = inlineDecorations(view, opts);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.focusChanged ||
          u.state.field(dragging, false) !== u.startState.field(dragging, false) ||
          u.state.field(previewBlocks, false) !== u.startState.field(previewBlocks, false) ||
          syntaxTree(u.state) !== syntaxTree(u.startState)
        )
          this.decorations = inlineDecorations(u.view, opts);
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        // 点链接直接打开（与渲染效果一致），不把光标放进去
        mousedown(e) {
          const a = e.target instanceof Element ? e.target.closest<HTMLElement>(".cm-md-link[data-href]") : null;
          if (!a || e.button !== 0) return false;
          e.preventDefault();
          opts.openHref(a.dataset.href!, e);
          return true;
        },
      },
    },
  );
}

// ---------------------------------------------------------------------------
// 是否按着鼠标（拖选、点进表格）：按着时不露符号、不切换表格，松开后再按选区更新

const setDragging = StateEffect.define<boolean>();

const dragging = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setDragging) ? e.value : acc), v),
});

/** 平时藏起来的 Markdown 符号 */
const MARKS = new Set(["HeaderMark", "QuoteMark", "ListMark", "TaskMarker", "EmphasisMark", "CodeMark", "StrikethroughMark", "LinkMark"]);

/** 行首的符号：内容到行尾 */
const LINE_MARKS = new Set(["HeaderMark", "QuoteMark", "ListMark", "TaskMarker"]);

/** pos 前面紧挨着的开头符号（中间可以隔一个空格，比如 `## `）：符号的起点和它管的内容的终点 */
function openingMark(state: EditorState, pos: number): { from: number; contentEnd: number } | null {
  for (const p of [pos, pos - 1]) {
    if (p < pos && state.sliceDoc(p, pos) !== " ") continue;
    const n = syntaxTree(state).resolveInner(p, -1);
    const parent = n.parent;
    if (!MARKS.has(n.name) || n.to !== p || !parent) continue;
    if (LINE_MARKS.has(n.name)) {
      // 标题结尾的 # 不算开头
      if (n.name === "HeaderMark" && n.from !== parent.from) continue;
      return { from: n.from, contentEnd: state.doc.lineAt(n.from).to };
    }
    if (n.from !== parent.from) continue;
    // 强调、代码到收尾的符号为止，链接、图片到 `]` 为止
    const marks = parent.getChildren(n.name);
    const close = n.name === "LinkMark" ? marks[1] : marks.length > 1 ? marks[marks.length - 1] : undefined;
    if (close) return { from: n.from, contentEnd: close.from };
  }
  return null;
}

/** pos 后面紧挨着的收尾符号：符号的终点（链接的 `]` 连同后面的 `(地址)`）和它管的内容的起点 */
function closingMark(state: EditorState, pos: number): { to: number; contentStart: number } | null {
  const n = syntaxTree(state).resolveInner(pos, 1);
  const parent = n.parent;
  if (!MARKS.has(n.name) || n.from !== pos || !parent) return null;
  const first = parent.getChildren(n.name)[0];
  if (!first || first.from === n.from) return null;
  if (n.name === "LinkMark" && state.sliceDoc(n.from, n.to) === "]") return { to: parent.to, contentStart: first.to };
  if (n.to !== parent.to) return null;
  return { to: n.to, contentStart: n.name === "HeaderMark" ? first.to + 1 : first.to };
}

/**
 * 拖选时符号是藏着的，选区停在符号里面（比如从「开发与检查」开始，不含前面的 `## `）。松开鼠标时，
 * 整个元素的内容都选中了，就把它两头的符号也选进来（与 ChatGPT 一致，随后露出这些符号）；只选中一部分的不动
 */
function selectionWithMarks(state: EditorState) {
  const sel = state.selection.main;
  if (sel.empty) return null;
  let { from, to } = sel;
  for (let m = openingMark(state, from); m && m.from < from && to >= m.contentEnd; m = openingMark(state, from)) from = m.from;
  for (let m = closingMark(state, to); m && m.to > to && from <= m.contentStart; m = closingMark(state, to)) to = m.to;
  if (from === sel.from && to === sel.to) return null;
  return sel.anchor <= sel.head ? { anchor: from, head: to } : { anchor: to, head: from };
}

const pointerTracking = [
  dragging,
  ViewPlugin.define((view) => {
    const up = () => {
      if (!view.state.field(dragging)) return;
      view.dispatch({ effects: setDragging.of(false), selection: selectionWithMarks(view.state) ?? undefined });
    };
    document.addEventListener("mouseup", up);
    return { destroy: () => document.removeEventListener("mouseup", up) };
  }),
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button === 0) view.dispatch({ effects: setDragging.of(true) });
      return false;
    },
  }),
];

// ---------------------------------------------------------------------------
// 单独成块、下面跟着渲染结果的两种：```mermaid 代码块（图，MermaidBlock，同回复里的）和只有图片、视频、音频的 HTML 块
// （<img>、<video>、<audio>，可以包在 <p align="center"> 这类标签里）。平时源码整块收起来只看结果；编辑器有焦点、
// 光标或选区碰到这一块时露出源码（照常编辑），结果留在下面跟着改。列表、引用里的源码一直显示。
// 占整行的小部件、整块收起只能由状态字段给出（插件给的装饰不能改变行的结构），所以不放在 livePreview 里

const setFocused = StateEffect.define<boolean>();

/** 编辑器有没有焦点（状态字段里读不到 view.hasFocus） */
const focused = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setFocused) ? e.value : acc), v),
});

type PreviewBlock = {
  /** 整块（从第一行的行首到最后一行的行尾） */
  from: number;
  to: number;
  /** 顶层的块（不在列表、引用里，前面没有别的字）：可以整块收起 */
  top: boolean;
} & ({ kind: "mermaid"; code: string } | { kind: "media"; items: MediaSpec[]; center: boolean; key: string });

/** 可能包着这些块的节点，其余的不用往里找 */
const BLOCK_CONTAINERS = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

function findPreviewBlocks(state: EditorState, tree: Tree): PreviewBlock[] {
  const doc = state.doc;
  const found: PreviewBlock[] = [];
  tree.iterate({
    enter: (n) => {
      if (n.name !== "FencedCode" && n.name !== "HTMLBlock") return BLOCK_CONTAINERS.has(n.name);
      const node = n.node;
      const first = doc.lineAt(n.from);
      const range = { from: first.from, to: doc.lineAt(n.to).to, top: node.parent?.name === "Document" && !first.text.slice(0, n.from - first.from).trim() };
      if (n.name === "HTMLBlock") {
        const media = parseMedia(doc.sliceString(n.from, n.to));
        if (media) found.push({ ...range, kind: "media", ...media, key: JSON.stringify(media) });
        return false;
      }
      const info = node.getChild("CodeInfo");
      const text = node.getChildren("CodeText");
      // 没写完的（还没有结尾的 ```）当普通代码块
      if (!info || doc.sliceString(info.from, info.to).trim().toLowerCase() !== "mermaid" || node.getChildren("CodeMark").length < 2 || !text.length) return false;
      const code = doc.sliceString(text[0]!.from, text[text.length - 1]!.to);
      if (code.trim()) found.push({ ...range, kind: "mermaid", code });
      return false;
    },
  });
  return found;
}

/** 「编辑源码」：小部件放在这一块最后一行的行尾，按它找到这一块，把光标放进源码（mermaid 是代码的第一行） */
function editBlockSource(view: EditorView, dom: HTMLElement) {
  const pos = view.posAtDOM(dom);
  const block = view.state.field(previewBlocks).blocks.find((b) => b.to === pos);
  if (!block) return;
  const anchor = block.kind === "mermaid" ? Math.min(view.state.doc.lineAt(block.from).to + 1, block.to) : block.from;
  view.focus();
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
}

/** 小部件的 React 根：小部件换了内容（改了源码、源码露出或收起）时接着用，图不会先消失再出现，展开的大图也不会被关掉 */
const mermaidRoots = new WeakMap<HTMLElement, Root>();

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    /** 编辑器正在上面显示源码 */
    readonly sourceAbove: boolean,
    /** 可以点「编辑源码」把光标放进源码 */
    readonly canEdit: boolean,
  ) {
    super();
  }
  eq(other: MermaidWidget) {
    return other.code === this.code && other.sourceAbove === this.sourceAbove && other.canEdit === this.canEdit;
  }
  private render(dom: HTMLElement, view: EditorView) {
    mermaidRoots.get(dom)?.render(
      <MermaidBlock
        code={this.code}
        sourceAbove={this.sourceAbove}
        onEdit={this.canEdit ? () => editBlockSource(view, dom) : undefined}
        // 大图开着时键盘不该还打进编辑器里
        onExpand={() => view.contentDOM.blur()}
      />,
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-md-mermaid";
    // 点图上的按钮不抢编辑器的焦点（焦点一丢源码就收起，图跟着挪位置，按钮点不中）
    dom.addEventListener("mousedown", (e) => e.preventDefault());
    mermaidRoots.set(dom, createRoot(dom));
    this.render(dom, view);
    return dom;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (!mermaidRoots.has(dom)) return false;
    this.render(dom, view);
    return true;
  }
  destroy(dom: HTMLElement) {
    const root = mermaidRoots.get(dom);
    mermaidRoots.delete(dom);
    // 可能正处在 React 的渲染、提交过程中（外面换内容、编辑器销毁），这时不能同步卸载
    if (root) setTimeout(() => root.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

const EDIT_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 3 13 5.5 6 12.5l-3 .5.5-3 7-7Z"/></svg>';

/** HTML 块里的图片、视频、音频；源码收起时右上角有「编辑源码」 */
class MediaBlockWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly items: MediaSpec[],
    readonly center: boolean,
    readonly canEdit: boolean,
  ) {
    super();
  }
  eq(other: MediaBlockWidget) {
    return other.key === this.key && other.canEdit === this.canEdit;
  }
  private fill(dom: HTMLElement, view: EditorView) {
    const resolve = view.state.facet(previewOptions)?.resolveSrc ?? ((src: string) => src);
    const edit = document.createElement("button");
    edit.className = "msg-action cm-md-media-edit";
    edit.title = "编辑源码";
    edit.setAttribute("aria-label", "编辑源码");
    edit.innerHTML = EDIT_ICON;
    edit.addEventListener("mousedown", (e) => e.preventDefault());
    edit.addEventListener("click", () => editBlockSource(view, dom));
    dom.dataset.key = this.key;
    dom.classList.toggle("cm-md-media-center", this.center);
    dom.replaceChildren(...this.items.map((item) => mediaElement(item, resolve)), edit);
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-md-media-block";
    this.fill(dom, view);
    dom.classList.toggle("cm-md-media-editable", this.canEdit);
    return dom;
  }
  // 只是源码露出、收起时不重建（正在放的视频不会断）
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (!dom.classList.contains("cm-md-media-block")) return false;
    if (dom.dataset.key !== this.key) this.fill(dom, view);
    dom.classList.toggle("cm-md-media-editable", this.canEdit);
    return true;
  }
  ignoreEvent() {
    return true;
  }
}

interface PreviewBlocks {
  tree: Tree;
  blocks: PreviewBlock[];
  /** 露出源码的那一块（blocks 的下标），没有时 -1 */
  active: number;
  readOnly: boolean;
  /** 源码整块收起来的块的起点：livePreview 不再给它们加行样式 */
  hidden: Set<number>;
  decorations: DecorationSet;
}

const hideBlock = Decoration.replace({ block: true });

function previewDecorations(blocks: PreviewBlock[], active: number, readOnly: boolean): Pick<PreviewBlocks, "hidden" | "decorations"> {
  const hidden = new Set<number>();
  const out: Range<Decoration>[] = [];
  blocks.forEach((b, i) => {
    const collapsed = b.top && i !== active;
    if (collapsed) {
      hidden.add(b.from);
      out.push(hideBlock.range(b.from, b.to));
    }
    const canEdit = collapsed && !readOnly;
    const widget = b.kind === "mermaid" ? new MermaidWidget(b.code, !collapsed, canEdit) : new MediaBlockWidget(b.key, b.items, b.center, canEdit);
    out.push(Decoration.widget({ widget, block: true, side: 1 }).range(b.to));
  });
  return { hidden, decorations: Decoration.set(out, true) };
}

/** 光标或选区碰到的那一块；编辑器没有焦点时没有 */
function activeBlock(state: EditorState, blocks: PreviewBlock[]): number {
  if (!state.field(focused, false)) return -1;
  const sel = state.selection.main;
  return blocks.findIndex((b) => sel.from <= b.to && sel.to >= b.from);
}

const previewBlocks: StateField<PreviewBlocks> = StateField.define<PreviewBlocks>({
  create(state) {
    const tree = syntaxTree(state);
    const blocks = findPreviewBlocks(state, tree);
    return { tree, blocks, active: -1, readOnly: state.readOnly, ...previewDecorations(blocks, -1, state.readOnly) };
  },
  update(value, tr) {
    const state = tr.state;
    const tree = syntaxTree(state);
    const rescan = tr.docChanged || tree !== value.tree;
    const blocks = rescan ? findPreviewBlocks(state, tree) : value.blocks;
    // 按着鼠标拖选时不切换（源码一露出来文字就跳），松开后再按选区算
    const active = state.field(dragging, false) && !rescan ? value.active : activeBlock(state, blocks);
    if (!rescan && active === value.active && state.readOnly === value.readOnly) return value;
    return { tree, blocks, active, readOnly: state.readOnly, ...previewDecorations(blocks, active, state.readOnly) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

const blockPreview = [focused, EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)), previewBlocks];

// ---------------------------------------------------------------------------
// 样式：Markdown 本身的符号、强调等用高亮，代码块、标题等用行样式（styles.css 的 .cm-md-*）

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: [tags.processingInstruction, tags.url, tags.labelName, tags.contentSeparator], class: "cm-md-syntax" },
  { tag: tags.quote, class: "cm-md-quote-text" },
]);

export interface MarkdownLiveEditorProps {
  /** 项目文件夹：本地图片通过网关读取 */
  cwd: string;
  /** 文件路径（相对项目文件夹）：相对链接、图片按它所在目录解析 */
  path: string;
  value: string;
  onChange: (value: string) => void;
  /** 点了指向项目里文件的链接：在右侧面板打开 */
  onOpenFile?: (path: string) => void;
  /** Ctrl/⌘+S */
  onSave?: () => void;
  editable?: boolean;
  /** 内容为空时显示的提示 */
  placeholder?: string;
  className?: string;
}

export function MarkdownLiveEditor({ cwd, path, value, onChange, onOpenFile, onSave, editable = true, placeholder, className = "file-markdown" }: MarkdownLiveEditorProps) {
  const latest = useRef({ onChange, onOpenFile, onSave });
  latest.current = { onChange, onOpenFile, onSave };

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableConf = useRef(new Compartment());
  const valueRef = useRef(value);
  valueRef.current = value;
  const editableRef = useRef(editable);
  editableRef.current = editable;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    /** 链接、图片地址指向项目里的文件：返回相对项目文件夹的路径 */
    const local = (href: string) => projectFile(cwd, path, href);
    const opts: PreviewOptions = {
      resolveSrc: (src) => {
        const p = src ? local(src) : null;
        return p !== null ? api.rawFileUrl(cwd, p) : src;
      },
      // 项目里的文件在右侧面板打开，网址在新窗口打开
      openHref: (href) => {
        const file = local(href);
        if (file !== null && latest.current.onOpenFile) latest.current.onOpenFile(splitLine(file).path);
        else if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
      },
    };
    const editableExt = (on: boolean) => [EditorView.editable.of(on), EditorState.readOnly.of(!on)];
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          history(),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                latest.current.onSave?.();
                return true;
              },
            },
            ...markdownKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(markdownStyle),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: "false" }),
          editableConf.current.of(editableExt(editableRef.current)),
          placeholder ? placeholderText(placeholder) : [],
          pointerTracking,
          previewOptions.of(opts),
          blockPreview,
          livePreview(opts),
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
    // 换了文件才重建；其他参数通过 latest 取最新的
  }, [cwd, path]);

  // 外面的内容变了（文件被改动后重新读取、源代码里改过）：换成新的内容，不进撤销历史
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableConf.current.reconfigure([EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]) });
  }, [editable]);

  return (
    <div
      ref={hostRef}
      className={`${className} md-live`}
      // 点内容下面的空白处：光标放到末尾
      onMouseDown={(e) => {
        const view = viewRef.current;
        if (!view || !editable || e.target !== e.currentTarget) return;
        e.preventDefault();
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// 链接地址解析（同 codex-app-server 的 Markdown.tsx）

/** 本地路径形式的链接（file://、绝对路径、Windows 盘符），不是返回 null */
function localPath(raw: string): string | null {
  let url = raw;
  try {
    url = decodeURIComponent(raw);
  } catch {
    // 不是合法编码，按原样处理
  }
  if (/^file:\/\//i.test(url)) {
    let p = url.replace(/^file:\/\/(localhost)?/i, "");
    if (/^\/[a-z]:/i.test(p)) p = p.slice(1);
    return p;
  }
  if (/^\/[a-z]:[\\/]/i.test(url)) return url.slice(1);
  if (/^[a-z]:[\\/]/i.test(url) || url.startsWith("\\\\")) return url;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  return null;
}

/** 路径后面的行号（a.ts:12、a.ts#L12） */
function splitLine(p: string): { path: string; line: number | null } {
  const m = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/.exec(p);
  if (!m) return { path: p, line: null };
  return { path: m[1]!, line: Number(m[2] ?? m[3]) || null };
}

/** 相对链接按 Markdown 文件所在目录解析；带协议的网址、#锚点、?查询、//网址返回 null */
function relativeFile(mdFile: string, href: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|[#?]|\/\/)/i.test(href)) return null;
  let rel = href;
  try {
    rel = decodeURIComponent(href);
  } catch {
    // 不是合法编码，按原样处理
  }
  rel = rel.replace(/\?[^#]*/, "").replace(/#(?!L\d)[^]*$/, "");
  if (!rel) return null;
  const parts = mdFile.split("/");
  parts.pop();
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") parts.push(seg);
    else if (parts.length) parts.pop();
    else return null;
  }
  return parts.join("/");
}

/** 链接指向项目里的文件：相对项目文件夹的路径；项目外、网址返回 null */
function projectFile(cwd: string, mdFile: string, href: string): string | null {
  const abs = localPath(href);
  if (abs === null) return relativeFile(mdFile, href);
  const root = cwd.replace(/[\\/]+$/, "");
  const norm = abs.replaceAll("\\", "/");
  const rootNorm = root.replaceAll("\\", "/");
  return norm.startsWith(`${rootNorm}/`) ? norm.slice(rootNorm.length + 1) : null;
}
