import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SelectedElement } from "@gateway/shared/types";
import { desktop } from "../desktop";
import { sanitizeElement, uploadElementScreenshot, useResponseAnnotations } from "../state/responseAnnotations";
import { closePageAnnotation, editAnnotationAt, repositionAnnotationEditor, startPageAnnotation } from "./ResponseAnnotations";

/**
 * 右侧面板里 iframe 显示的网页上点选元素写标注（同 Claude 桌面版的「选择元素」，和内置浏览器的一样）：
 * HTML 预览（FileBrowser 的 HtmlPreview）和 Office 文档预览（OfficePreview）共用。
 * 网页在沙箱里（单独的源），界面碰不到里面的 DOM，由网页里的脚本（gateway/src/shared/page-picker.ts）和这里互相 postMessage。
 * 标注模式下在网页上点一个元素，网页里的脚本取元素信息（gateway/src/shared/element-context.ts），
 * 桌面版再截一张元素的图（网页版截不了），界面上打开编辑框写要怎么改，加进输入框里的「N 条注释」，随下一条消息发出，
 * 加完、按 Esc 不加了都退出标注模式（要再标一个重新点按钮）；已有的标注在元素上显示编号，点编号修改
 */

interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 网页里选中的元素；label、kind、key 是 Office 文档预览在元素上写的位置、种类和键 */
export interface PickedElement {
  element: SelectedElement;
  label: string | null;
  kind: string | null;
  key: string | null;
}

// 网页发来的消息是网页里的脚本发的，逐个字段检查
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
function pageRect(v: unknown): PageRect | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) };
}

/**
 * 桌面版：截一张元素的图（四周多 80px，限在网页的范围里，同内置浏览器），PNG 的 base64；网页版、元素不在画面上时 null。
 * 截的是界面窗口，网页里此时没有画选中框（等 show-pick）
 */
async function captureElement(frame: HTMLIFrameElement, el: DOMRect | null): Promise<string | null> {
  if (!desktop || !el) return null;
  const f = frame.getBoundingClientRect();
  const left = Math.max(f.left, el.left - 80);
  const top = Math.max(f.top, el.top - 80);
  const right = Math.min(f.right, el.right + 80);
  const bottom = Math.min(f.bottom, el.bottom + 80);
  if (right - left < 1 || bottom - top < 1) return null;
  return desktop.captureRect({ x: left, y: top, width: right - left, height: bottom - top }).catch(() => null);
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

export function usePageAnnotations({
  frameRef,
  path,
  source,
  sessionId,
  annotating,
  onAnnotatingChange,
  onReady,
  describe,
  onMessage,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  /** 打开的文件，相对项目文件夹 */
  path: string;
  /** iframe 里放的内容（地址或者 srcdoc），变了就是重新加载 */
  source: string | null;
  sessionId: string | null;
  annotating: boolean;
  onAnnotatingChange: (on: boolean) => void;
  /** 网页里的标注脚本连上了（每次加载后），换内容时先报 false */
  onReady: (ready: boolean) => void;
  /** 选中的元素发给模型前换一种说法（Office 文档换成它在文档里的位置）；不给就用网页里取的 */
  describe?: (picked: PickedElement) => SelectedElement;
  /** 标注之外的消息（Office 文档预览改内容的） */
  onMessage?: (data: Record<string, unknown>) => void;
}): { post: (msg: Record<string, unknown>) => void } {
  /** 网页当前显示的文件（点链接可能跳到别的页面）和第几次加载 */
  const [loaded, setLoaded] = useState<{ file: string; n: number } | null>(null);
  const fileRef = useRef(path);
  fileRef.current = loaded?.file ?? path;
  const pickedRect = useRef<PageRect | null>(null);
  /** 第几次选：截图、上传期间又选了别的，前一次的就不打开编辑框了 */
  const pickSeq = useRef(0);
  const describeRef = useRef(describe);
  describeRef.current = describe;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const annotations = useResponseAnnotations(sessionId);
  const file = loaded?.file;
  const marks = useMemo(
    () => annotations.flatMap((a, i) => (a.element?.selector && a.element.file === file ? [{ id: a.id, n: i + 1, selector: a.element.selector }] : [])),
    [annotations, file],
  );

  const post = useCallback(
    (msg: Record<string, unknown>) => {
      frameRef.current?.contentWindow?.postMessage({ ...msg, source: "claude-app" }, "*");
    },
    [frameRef],
  );
  /** 网页视口里的位置换成界面上的 */
  const toScreen = useCallback(
    (r: PageRect | null) => {
      const f = frameRef.current?.getBoundingClientRect();
      return r && f ? new DOMRect(f.left + r.x, f.top + r.y, r.width, r.height) : null;
    },
    [frameRef],
  );

  useEffect(() => {
    onReady(false);
    setLoaded(null);
  }, [source, onReady]);

  // 每次加载好、标注模式和编号变了，都把状态告诉网页
  useEffect(() => {
    if (loaded) post({ type: "state", annotating: annotating && !!sessionId, marks });
  }, [loaded, annotating, sessionId, marks, post]);

  useEffect(() => {
    const listener = (e: MessageEvent) => {
      const frame = frameRef.current;
      const d = e.data as Record<string, unknown> | null;
      if (!frame || e.source !== frame.contentWindow || !d || d.source !== "claude-app-page") return;
      if (d.type === "ready") {
        setLoaded((prev) => ({ file: pageFile(d.path) ?? path, n: (prev?.n ?? 0) + 1 }));
        onReady(true);
      } else if (d.type === "pick" && sessionId) {
        const raw = sanitizeElement(d.element);
        const selector = str(d.selector, 1000);
        if (!raw || !selector) return;
        const element = describeRef.current ? describeRef.current({ element: raw, label: str(d.label, 300) || null, kind: str(d.kind, 60) || null, key: str(d.key, 200) || null }) : raw;
        const file = fileRef.current;
        pickedRect.current = pageRect(d.rect);
        const pickId = d.pickId;
        const seq = ++pickSeq.current;
        void (async () => {
          const shot = await captureElement(frame, toScreen(pickedRect.current));
          post({ type: "show-pick", pickId });
          const screenshot = await uploadElementScreenshot(shot);
          if (seq !== pickSeq.current) return;
          startPageAnnotation(
            sessionId,
            { file, selector, element, ...(screenshot ? { screenshot } : {}) },
            () => toScreen(pickedRect.current),
            () => post({ type: "clear-pick", pickId }),
            () => onAnnotatingChange(false),
          );
        })();
      } else if (d.type === "picked-rect") {
        pickedRect.current = pageRect(d.rect);
        repositionAnnotationEditor();
      } else if (d.type === "edit" && sessionId && typeof d.id === "string") {
        const rect = pageRect(d.rect);
        editAnnotationAt(sessionId, d.id, () => toScreen(rect));
      } else if (d.type === "escape") onAnnotatingChange(false);
      else onMessageRef.current?.(d);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [frameRef, path, sessionId, post, toScreen, onReady, onAnnotatingChange]);

  // 退出标注模式、关掉文件时，没写完的标注框也关掉
  useEffect(() => {
    if (!annotating) closePageAnnotation();
  }, [annotating]);
  useEffect(() => closePageAnnotation, []);

  return { post };
}
