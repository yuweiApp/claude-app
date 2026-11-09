import { useMemo, useSyncExternalStore } from "react";

/**
 * 回复 Claude 的某段话（参照 codex-app-server 的 response annotations）：在 Claude 的回复里选中一段文字，
 * 可以写一句回复，按会话记在本地，挂在输入框里的「N 条注释」上，随下一条消息发出，发出后清空。
 * 右侧面板里显示成网页的 HTML 文件上点选元素写的标注（参照 codex-app-server 的浏览器批注）也放在这里，带 page
 */
export interface ResponseAnnotationSource {
  /** 被回复的那段文字的 key（消息 uuid:块序号） */
  messageId: string;
  /** 选中的文字在那段正文里的位置（按渲染出来的文字算） */
  startOffset: number;
  endOffset: number;
}

/** 网页上点选的元素 */
export interface PageAnnotationTarget {
  /** 网页文件，相对项目文件夹（网页里点链接跳到别的页面后是那个页面） */
  file: string;
  /** 能找回这个元素的 CSS 选择器 */
  selector: string;
  /** 标签名（小写） */
  tag: string;
  /** 点的位置和当时的视口大小（CSS 像素） */
  point: { x: number; y: number };
  viewport: { width: number; height: number };
}

export interface ResponseAnnotation {
  id: string;
  /** 回复里选中的文字；网页标注是元素的 aria-label、alt、文字等，都没有时是 <标签名> */
  text: string;
  /** 用户写的回复，没写时没有 */
  annotation?: string;
  source?: ResponseAnnotationSource;
  page?: PageAnnotationTarget;
}

/** 发出去的消息里解析出来的注释（没有本地 id） */
export type SentResponseAnnotation = Omit<ResponseAnnotation, "id">;

// ---------------------------------------------------------------------------
// 按会话存在 localStorage（刷新页面后还在）；浏览器禁止存储时读到空列表

const PREFIX = "responseAnnotations:";
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function readRaw(sessionId: string) {
  try {
    return localStorage.getItem(PREFIX + sessionId) ?? "";
  } catch {
    return "";
  }
}

function read(sessionId: string): ResponseAnnotation[] {
  try {
    const list = JSON.parse(readRaw(sessionId) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(sessionId: string, list: ResponseAnnotation[]) {
  try {
    if (list.length) localStorage.setItem(PREFIX + sessionId, JSON.stringify(list));
    else localStorage.removeItem(PREFIX + sessionId);
  } catch {
    // 浏览器禁止存储
  }
  notify();
}

export function useResponseAnnotations(sessionId: string | null): ResponseAnnotation[] {
  const raw = useSyncExternalStore(subscribe, () => (sessionId ? readRaw(sessionId) : ""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (sessionId ? read(sessionId) : []), [raw, sessionId]);
}

let seq = 0;
const cleanComment = (comment: string) => comment.trim() || undefined;

export function addResponseAnnotation(sessionId: string, text: string, comment: string, source: ResponseAnnotationSource) {
  const t = text.trim();
  if (!t) return;
  write(sessionId, [...read(sessionId), { id: `${Date.now().toString(36)}-${++seq}`, text: t, annotation: cleanComment(comment), source }]);
}

/** 网页上点选的元素，要求可以不写 */
export function addPageAnnotation(sessionId: string, text: string, comment: string, page: PageAnnotationTarget) {
  write(sessionId, [...read(sessionId), { id: `${Date.now().toString(36)}-${++seq}`, text: text.trim() || `<${page.tag}>`, annotation: cleanComment(comment), page }]);
}

export function updateResponseAnnotation(sessionId: string, id: string, comment: string) {
  write(
    sessionId,
    read(sessionId).map((a) => (a.id === id ? { ...a, annotation: cleanComment(comment) } : a)),
  );
}

export function removeResponseAnnotation(sessionId: string, id: string) {
  write(
    sessionId,
    read(sessionId).filter((a) => a.id !== id),
  );
}

export function clearResponseAnnotations(sessionId: string) {
  write(sessionId, []);
}

// ---------------------------------------------------------------------------
// 消息格式：接在用户写的文字后面（放后面是因为 /技能 要在消息开头才算）
//
//   用户写的文字
//   （空行）
//   # Response annotations:
//   Each item is text the user selected from an earlier response of yours ...
//   <response-annotations>
//   [{"text":"选中的文字","annotation":"回复","source":{"messageId":"…","startOffset":0,"endOffset":10}}]
//
// source 是原文在页面上的位置，发出去以后点注释能跳回原文；网页标注没有 source，带 page
//   </response-annotations>

const HEADER = "# Response annotations:";
const OPEN_TAG = "<response-annotations>";
const CLOSE_TAG = "</response-annotations>";
const INSTRUCTIONS =
  "Each item is either text the user selected from an earlier response of yours (`source` is the selection's position on the user's screen), " +
  "or an element the user picked on an HTML file shown as a web page in the side panel (`page`: `file` is the page's path relative to the working directory, " +
  "`selector` a CSS selector for the element, `tag` its tag name, `point` the clicked position in a viewport of `viewport` size, in CSS pixels; " +
  "`text` is the element's label or text taken from the page). The user's comment is in `annotation` when they wrote one. " +
  "The user sees the items numbered Annotation 1, Annotation 2, and so on in array order.";

export function formatResponseAnnotations(list: SentResponseAnnotation[]): string {
  const items = list.map((a) => ({ text: a.text, annotation: a.annotation, source: a.source, page: a.page }));
  return `${HEADER}\n${INSTRUCTIONS}\n${OPEN_TAG}\n${JSON.stringify(items)}\n${CLOSE_TAG}`;
}

/** 用户写的文字后面接上注释 */
export function withResponseAnnotations(text: string, list: SentResponseAnnotation[]): string {
  if (!list.length) return text;
  const block = formatResponseAnnotations(list);
  return text ? `${text}\n\n${block}` : block;
}

const isOffset = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function parsePage(p: unknown): PageAnnotationTarget | undefined {
  if (!p || typeof p !== "object") return undefined;
  const { file, selector, tag, point, viewport } = p as Record<string, unknown>;
  const pt = point as { x?: unknown; y?: unknown } | null;
  const vp = viewport as { width?: unknown; height?: unknown } | null;
  if (typeof file !== "string" || typeof selector !== "string" || typeof tag !== "string") return undefined;
  if (!pt || !isNum(pt.x) || !isNum(pt.y) || !vp || !isNum(vp.width) || !isNum(vp.height)) return undefined;
  return { file, selector, tag, point: { x: pt.x, y: pt.y }, viewport: { width: vp.width, height: vp.height } };
}

/** 从消息末尾拆出注释段落：返回注释和前面用户写的文字；不是这种格式时返回 null */
export function splitResponseAnnotations(raw: string): { annotations: SentResponseAnnotation[]; text: string } | null {
  const trimmed = raw.trimEnd();
  if (!trimmed.endsWith(CLOSE_TAG)) return null;
  const at = trimmed.lastIndexOf(HEADER);
  if (at < 0 || (at > 0 && trimmed[at - 1] !== "\n")) return null;
  const open = trimmed.indexOf(`\n${OPEN_TAG}\n`, at);
  if (open < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(open + OPEN_TAG.length + 2, trimmed.length - CLOSE_TAG.length - 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const annotations = parsed.flatMap((item): SentResponseAnnotation[] => {
    if (!item || typeof item.text !== "string" || !item.text) return [];
    const s = item.source;
    const source =
      s && typeof s.messageId === "string" && s.messageId && isOffset(s.startOffset) && isOffset(s.endOffset) && s.endOffset > s.startOffset
        ? { messageId: s.messageId, startOffset: s.startOffset, endOffset: s.endOffset }
        : undefined;
    return [
      {
        text: item.text,
        annotation: typeof item.annotation === "string" && item.annotation ? item.annotation : undefined,
        source,
        page: source ? undefined : parsePage(item.page),
      },
    ];
  });
  return { annotations, text: trimmed.slice(0, at).trimEnd() };
}

// ---------------------------------------------------------------------------
// 页面上的选区和位置

/** 会话的消息区域带着这个属性（值是会话 ID） */
export const ANNOTATION_SCOPE_ATTR = "data-annotation-session";
/** Claude 的每段回复文字带着这个属性（值是这段的 key），选中的文字在一段里面才能回复 */
export const ANNOTATION_TARGET_ATTR = "data-response-annotation-target";

export const findAnnotationTarget = (messageId: string) =>
  document.querySelector<HTMLElement>(`[${ANNOTATION_TARGET_ATTR}="${CSS.escape(messageId)}"]`);

const elementOf = (node: Node) => (node instanceof Element ? node : node.parentElement);

/** 选区某一端在 root 里的文字位置 */
function textOffset(root: Node, node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** 文字位置还原成 Range；文字变了（对不上）时返回 null */
export function rangeAt(root: Node, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0;
    if (!started && start <= pos + len) {
      range.setStart(node, start - pos);
      started = true;
    }
    if (started && end <= pos + len) {
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

export interface AnnotationSelection {
  sessionId: string;
  text: string;
  source: ResponseAnnotationSource;
  range: Range;
}

/** 当前选区能不能回复：两端在同一段 Claude 的回复里时返回会话、文字和位置 */
export function selectionAnnotation(): AnnotationSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  const target = start?.closest<HTMLElement>(`[${ANNOTATION_TARGET_ATTR}]`);
  const scope = target?.closest(`[${ANNOTATION_SCOPE_ATTR}]`);
  if (!end || !target || !scope || !target.contains(end)) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const startOffset = textOffset(target, range.startContainer, range.startOffset);
  const endOffset = textOffset(target, range.endContainer, range.endOffset);
  if (endOffset <= startOffset) return null;
  return {
    sessionId: scope.getAttribute(ANNOTATION_SCOPE_ATTR)!,
    text,
    source: { messageId: target.getAttribute(ANNOTATION_TARGET_ATTR)!, startOffset, endOffset },
    range: range.cloneRange(),
  };
}
