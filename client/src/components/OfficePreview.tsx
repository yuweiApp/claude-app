import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { SelectedElement } from "@gateway/shared/types";
import { api } from "../api";
import type { RenderedDocument } from "../office/docx";
import { officeFrameHtml } from "../office/frame";
import { parseEdits, type Edits } from "../office/edits";
import type { RenderedWorkbook } from "../office/xlsx";
import { getDraft, setDraft } from "../state/fileDrafts";
import { useIsDark } from "../theme";
import { usePageAnnotations, type PickedElement } from "./pageAnnotations";

export type OfficeKind = "docx" | "xlsx" | "pptx";

/** 按扩展名认 Office 文档（带宏的、模板也是同一种格式）；老的二进制格式（.doc、.xls、.ppt）是 legacy，不能预览 */
export function officeKind(path: string): OfficeKind | "legacy" | null {
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  if (["docx", "docm", "dotx", "dotm"].includes(ext)) return "docx";
  if (["xlsx", "xlsm", "xltx", "xltm"].includes(ext)) return "xlsx";
  if (["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"].includes(ext)) return "pptx";
  if (["doc", "xls", "ppt"].includes(ext)) return "legacy";
  return null;
}

interface Format {
  /** 标注时能选的元素（CSS 选择器） */
  pick: string;
  render(bytes: ArrayBuffer, edits: Edits): Promise<RenderedDocument>;
  /** 原文件按 edits 改好的字节；没有能改的地方时 null */
  save(bytes: ArrayBuffer, edits: Edits): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** 各种格式的解析、渲染代码（连同 docx-preview、jszip）打开这种文件时才加载 */
const FORMATS: Record<OfficeKind, () => Promise<Format>> = {
  docx: async () => {
    const m = await import("../office/docx");
    return { pick: m.DOCX_PICK, render: async (bytes, edits) => ((doc) => ({ ...doc, css: doc.css + m.DOCX_CSS }))(await m.renderDocx(bytes, edits)), save: m.saveDocx };
  },
  xlsx: async () => {
    const m = await import("../office/xlsx");
    return { pick: m.XLSX_PICK, render: m.renderXlsx, save: m.saveXlsx };
  },
  pptx: async () => {
    const m = await import("../office/pptx");
    return { pick: m.PPTX_PICK, render: m.renderPptx, save: m.savePptx };
  },
};

/** 标注时元素种类的说法（发给模型的 <element tag="…">） */
const KIND_TAGS: Record<string, string> = { paragraph: "paragraph", "table-cell": "table-cell", image: "image", shape: "shape", table: "table", object: "object", slide: "slide" };

export interface OfficePreviewHandle {
  /** 没保存的改动写回文件；冲突时抛 RequestError（status 409），force 覆盖 */
  save(force: boolean): Promise<void>;
}

/**
 * Word、Excel、PowerPoint 文档（docx、xlsx、pptx）的预览：取整个文件，在界面里解析、渲染成 HTML（client/src/office/），
 * 放进沙箱 iframe（office/frame.ts）。和 HTML 预览一样能点选元素写标注；双击文字（段落、单元格）直接改，
 * 改动先记在 fileDrafts 里（标签页上有圆点、标题栏显示「未保存」），Ctrl/⌘+S 保存：重新读一遍原文件，只改那几处的文字，
 * 打包写回去（POST /files/write-bytes），格式、图片和别的内容都不动。
 * 文件被别处改了（修改时间变了）就重新读、重新渲染；自己保存的那次不用
 */
export function OfficePreview({
  ref,
  kind,
  cwd,
  path,
  mtimeMs,
  sessionId,
  annotating,
  onAnnotatingChange,
  onReady,
  onEdited,
  onSave,
  onSaved,
}: {
  ref: Ref<OfficePreviewHandle>;
  kind: OfficeKind;
  cwd: string;
  path: string;
  mtimeMs: number;
  sessionId: string | null;
  annotating: boolean;
  onAnnotatingChange: (on: boolean) => void;
  onReady: (ready: boolean) => void;
  /** 改了内容（有了没保存的修改） */
  onEdited: () => void;
  /** 在文档里按了 Ctrl/⌘+S */
  onSave: () => void;
  /** 保存好了：文件新的修改时间和大小 */
  onSaved: (file: { mtimeMs: number; size: number }) => void;
}) {
  const dark = useIsDark();
  const frameRef = useRef<HTMLIFrameElement>(null);
  /** 现在显示的是哪一版文件：内容和修改时间 */
  const fileRef = useRef<{ bytes: ArrayBuffer; mtimeMs: number } | null>(null);
  const renderedRef = useRef<RenderedDocument | null>(null);
  const [view, setView] = useState<{ html: string } | { error: string } | null>(null);
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    // 自己刚保存的那一版，画面上已经是改完的样子
    if (fileRef.current?.mtimeMs === mtimeMs) return;
    let live = true;
    void (async () => {
      try {
        const [bytes, format] = await Promise.all([api.readBytes(cwd, path), FORMATS[kind]()]);
        const rendered = await format.render(bytes, parseEdits(getDraft(cwd, path)));
        if (!live) return;
        fileRef.current = { bytes, mtimeMs };
        renderedRef.current = rendered;
        setView({ html: officeFrameHtml(rendered, format.pick, darkRef.current) });
      } catch (err) {
        if (live) setView({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      live = false;
    };
  }, [kind, cwd, path, mtimeMs]);

  /** 发给模型的元素：种类、它在文档里的位置和文字（渲染出来的 HTML 结构对模型没用，不带） */
  const describe = useCallback((picked: PickedElement): SelectedElement => {
    const workbook = renderedRef.current as Partial<RenderedWorkbook> | null;
    const location = picked.label ?? (picked.key ? workbook?.label?.(picked.key) : null) ?? null;
    return {
      tagName: picked.kind ? (KIND_TAGS[picked.kind] ?? picked.kind) : picked.key?.startsWith("c:") ? "cell" : picked.element.tagName,
      classes: [],
      attributes: location ? { location } : {},
      computedStyles: {},
      ...(picked.element.innerText ? { innerText: picked.element.innerText } : {}),
    };
  }, []);

  const onMessage = useCallback(
    (d: Record<string, unknown>) => {
      if (d.type === "office-save") onSave();
      else if (d.type === "office-edit" && typeof d.key === "string" && Array.isArray(d.segs)) {
        const key = d.key.slice(0, 200);
        const segs = d.segs.slice(0, 2000).map((s) => (typeof s === "string" ? s : null));
        const edits = parseEdits(getDraft(cwd, path));
        // 这次没碰到的段（null）沿用之前改的
        const before = edits[key];
        edits[key] = segs.map((s, i) => s ?? before?.[i] ?? null);
        setDraft(cwd, path, JSON.stringify(edits));
        onEdited();
        const cell = typeof segs[0] === "string" ? (renderedRef.current as Partial<RenderedWorkbook> | null)?.cell?.(key, segs[0]) : null;
        if (cell) post({ type: "office-cell", key, text: cell.text, raw: cell.raw, cellType: cell.type });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cwd, path, onSave, onEdited],
  );

  const html = view && "html" in view ? view.html : null;
  const { post } = usePageAnnotations({ frameRef, path, source: html, sessionId, annotating, onAnnotatingChange, onReady, describe, onMessage });

  // 界面换了深浅色：告诉文档，不重新加载
  useEffect(() => {
    post({ type: "office-theme", dark });
  }, [dark, post]);

  useImperativeHandle(
    ref,
    () => ({
      async save(force) {
        const draft = getDraft(cwd, path);
        const file = fileRef.current;
        if (draft === undefined || !file) return;
        const bytes = await (await FORMATS[kind]()).save(file.bytes, parseEdits(draft));
        if (bytes) {
          const saved = await api.writeBytes(cwd, path, bytes, file.mtimeMs, force);
          fileRef.current = { bytes: bytes.buffer, mtimeMs: saved.mtimeMs };
          onSaved(saved);
        }
        // 保存期间又改了的，留着（已经存进去的那些再存一次结果一样）
        if (getDraft(cwd, path) === draft) setDraft(cwd, path, undefined);
      },
    }),
    [kind, cwd, path, onSaved],
  );

  if (!view) return <div className="panel-empty">正在加载文档…</div>;
  if ("error" in view) return <div className="panel-empty files-error">{view.error}</div>;
  return (
    <>
      <iframe ref={frameRef} className="viewer-frame office" srcDoc={view.html} title={path} sandbox="allow-scripts" />
      {annotating && (
        <div className="viewer-annotate-bar">
          <span>点选文档里的内容写标注，随下一条消息发给 Claude</span>
          <button className="icon-btn" title="退出标注（Esc）" aria-label="退出标注" onClick={() => onAnnotatingChange(false)}>
            ×
          </button>
        </div>
      )}
    </>
  );
}
