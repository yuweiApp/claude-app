import { renderAsync } from "docx-preview";
import { OfficePackage, all, inside, kid, kids, setText, type Edits } from "./pkg";

/**
 * Word 文档：版面交给 docx-preview 渲染（样式、编号、表格、图片、页眉页脚），这里只管「渲染出来的元素对应 XML 里的哪个节点」。
 *
 * docx-preview 渲染时不留 XML 节点的对应关系，所以渲染前在一份副本上做记号，渲染完按记号找回来：
 * - 每个段落（<w:p>）开头插一个书签（<w:bookmarkStart w:name="capp-N">），渲染出来是 <span id="capp-N">，它所在的 <p> 就是第 N 个段落
 * - 每段文字（<w:t>）开头加「N.i」，渲染出来的文字节点带着它，去掉记号、包进 <span data-seg="i">
 * 记号只在渲染用的副本里，保存时重新读原文件、只改文字。
 *
 * 段落的编号 N：正文（<w:body>）里所有 <w:p> 按文档顺序数（表格、文本框里的也算），兼容写法（mc:Fallback）里重复的那份不算。
 * 页眉、页脚、脚注不在正文里，只显示，不能选也不能改
 */

const MARK_OPEN = "";
const MARK_CLOSE = "";
const MARK = /^(\d+)\.(\d+)/;
const BOOKMARK = "capp-";

/** 正文里的段落，按文档顺序 */
function bodyParagraphs(doc: Document): Element[] {
  const body = all(doc, "body")[0];
  return all(body, "p").filter((p) => p.namespaceURI === body!.namespaceURI && !inside(p, "Fallback", body));
}

/** 段落自己的文字段（不算里面文本框的段落的） */
function paragraphTexts(p: Element): Element[] {
  return all(p, "t").filter((t) => t.namespaceURI === p.namespaceURI && closestParagraph(t) === p);
}

function closestParagraph(el: Element): Element | null {
  for (let x = el.parentElement; x; x = x.parentElement) if (x.localName === "p" && x.namespaceURI === el.namespaceURI) return x;
  return null;
}

/** 改动写进 XML：只改 <w:t> 的文字，段落、格式都不动；空段落里新建一段文字（格式随段落标记） */
function applyEdits(doc: Document, edits: Edits): boolean {
  const paras = bodyParagraphs(doc);
  let changed = false;
  for (const [key, segs] of Object.entries(edits)) {
    const m = /^p:(\d+)$/.exec(key);
    const p = m ? paras[Number(m[1])] : undefined;
    if (!p || !Array.isArray(segs)) continue;
    const ts = paragraphTexts(p);
    if (ts.length === 0) {
      const text = segs.filter((s) => typeof s === "string").join("");
      if (!text) continue;
      const ns = p.namespaceURI;
      const name = (local: string) => (p.prefix ? `${p.prefix}:${local}` : local);
      const run = doc.createElementNS(ns, name("r"));
      const markProps = kid(kid(p, "pPr"), "rPr");
      if (markProps) run.appendChild(markProps.cloneNode(true));
      const t = doc.createElementNS(ns, name("t"));
      setText(t, text);
      run.appendChild(t);
      p.appendChild(run);
      changed = true;
      continue;
    }
    segs.forEach((s, i) => {
      if (typeof s !== "string") return;
      const t = ts[Math.min(i, ts.length - 1)]!;
      // 比原来的段数多出来的，接在最后一段后面
      setText(t, i < ts.length ? s : (t.textContent ?? "") + s);
      changed = true;
    });
  }
  return changed;
}

/** 段落在文档里的位置，写给模型和用户看的（标注时带上） */
function describe(paras: Element[]): { label: string; cell?: string }[] {
  const body = paras[0]?.ownerDocument ? all(paras[0].ownerDocument, "body")[0] : null;
  const topTables = body ? all(body, "tbl").filter((t) => !inside(t, "tc", body) && !inside(t, "txbxContent", body) && !inside(t, "Fallback", body)) : [];
  let n = 0;
  return paras.map((p) => {
    if (inside(p, "txbxContent", body)) return { label: "文本框里的段落" };
    let tc: Element | null = null;
    for (let x = p.parentElement; x && x !== body; x = x.parentElement) {
      if (x.localName === "tc") {
        tc = x;
        break;
      }
    }
    if (!tc) return { label: `正文第 ${++n} 段` };
    const tr = tc.parentElement;
    const tbl = tr?.parentElement;
    const t = tbl ? topTables.indexOf(tbl) : -1;
    if (!tr || !tbl || t < 0) return { label: "嵌套表格里的段落", cell: "嵌套表格里的单元格" };
    const cell = `第 ${t + 1} 个表格第 ${kids(tbl, "tr").indexOf(tr) + 1} 行第 ${kids(tr, "tc").indexOf(tc) + 1} 列的单元格`;
    const inCell = kids(tc, "p");
    return { label: inCell.length > 1 ? `${cell}里的第 ${inCell.indexOf(p) + 1} 段` : cell, cell };
  });
}

/**
 * HTML 里 <p> 里面不能有块级元素：docx-preview 把图片包在 <p> 里的 <div> 里（直接建的 DOM 可以这样嵌），
 * 但转成 HTML 文本再解析时 <div> 会把 <p> 提前结束，段落就散了。这些标签换成 <span>（原来的属性、样式都留着）
 */
const BLOCK_IN_P = "div, p, ol, ul, section, article, header, footer, h1, h2, h3, h4, h5, h6, pre, blockquote";
function fixBlocksInParagraphs(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("p")).flatMap((p) => Array.from(p.querySelectorAll<HTMLElement>(BLOCK_IN_P)))) {
    // svg 的 foreignObject 里面是另起的一段 HTML，不受这个限制
    if (el.closest("foreignObject")) continue;
    const span = document.createElement("span");
    for (const a of Array.from(el.attributes)) span.setAttribute(a.name, a.value);
    if (!span.style.display) span.style.display = "block";
    span.append(...Array.from(el.childNodes));
    el.replaceWith(span);
  }
}

export interface RenderedDocument {
  /** <body> 里的 HTML */
  body: string;
  css: string;
}

/** 渲染成 HTML；edits 是还没保存的改动，先改进去再渲染 */
export async function renderDocx(bytes: ArrayBuffer, edits: Edits): Promise<RenderedDocument> {
  const pkg = await OfficePackage.load(bytes);
  const main = await pkg.mainPart();
  const doc = main ? await pkg.xml(main) : null;
  if (!main || !doc) throw new Error("文件打不开：里面没有 Word 文档的正文");
  applyEdits(doc, edits);

  const paras = bodyParagraphs(doc);
  const where = describe(paras);
  paras.forEach((p, n) => {
    const ns = p.namespaceURI;
    const prefix = p.prefix ? `${p.prefix}:` : "";
    const mark = doc.createElementNS(ns, `${prefix}bookmarkStart`);
    mark.setAttributeNS(ns, `${prefix}id`, String(900000 + n));
    mark.setAttributeNS(ns, `${prefix}name`, BOOKMARK + n);
    const props = kid(p, "pPr");
    p.insertBefore(mark, props ? props.nextSibling : p.firstChild);
    paragraphTexts(p).forEach((t, i) => (t.textContent = `${MARK_OPEN}${n}.${i}${MARK_CLOSE}${t.textContent ?? ""}`));
  });
  pkg.touch(main);

  const container = document.createElement("div");
  const styles = document.createElement("div");
  await renderAsync(new Blob([await pkg.bytes()]), container, styles, {
    className: "docx",
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    // 图片、字体写成 data: 地址：这里渲染出来的 HTML 要转成文本放进沙箱 iframe，blob: 地址到那边取不到
    useBase64URL: true,
    // 内嵌的 HTML（altChunk）不渲染，批注不显示
    renderAltChunks: false,
    renderComments: false,
    renderChanges: false,
    experimental: false,
  });

  // 文字段：去掉记号，包进 <span data-seg>；所在的 <p> 记下是第几个段落、原来有几段文字
  const counts = paras.map((p) => paragraphTexts(p).length);
  const mapped = new Set<HTMLElement>();
  const mapParagraph = (p: HTMLElement | null, n: number) => {
    if (!p || !where[n]) return;
    p.dataset.edit = `p:${n}`;
    p.dataset.segs = String(counts[n]);
    p.dataset.pickLabel = where[n].label;
    p.dataset.pickKind = "paragraph";
    mapped.add(p);
    const td = p.closest<HTMLElement>("td, th");
    if (td && where[n].cell && !td.dataset.pickLabel) {
      td.dataset.pickLabel = where[n].cell;
      td.dataset.pickKind = "table-cell";
    }
  };
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const node of texts) {
    const m = MARK.exec(node.data);
    if (!m) continue;
    const seg = document.createElement("span");
    seg.dataset.seg = m[2]!;
    seg.textContent = node.data.slice(m[0].length);
    node.replaceWith(seg);
    mapParagraph(seg.closest("p"), Number(m[1]));
  }
  for (const mark of Array.from(container.querySelectorAll<HTMLElement>(`span[id^="${BOOKMARK}"]`))) {
    mapParagraph(mark.closest("p"), Number(mark.id.slice(BOOKMARK.length)));
    mark.remove();
  }
  // 段落里不是 <w:t> 来的文字（制表符、脚注的编号、符号）：改文字时不算在内，标成不能改的
  for (const p of mapped) {
    const inner = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const loose: Text[] = [];
    for (let node = inner.nextNode(); node; node = inner.nextNode()) {
      const parent = node.parentElement;
      if (parent && !parent.closest("[data-seg]") && parent.closest("[data-edit]") === p && (node as Text).data) loose.push(node as Text);
    }
    for (const node of loose) {
      const fixed = document.createElement("span");
      fixed.dataset.noedit = "";
      fixed.contentEditable = "false";
      node.replaceWith(fixed);
      fixed.appendChild(node);
    }
  }
  for (const img of Array.from(container.querySelectorAll<HTMLElement>("img"))) {
    const at = img.closest<HTMLElement>("[data-pick-label]");
    if (!at) continue;
    img.dataset.pickLabel = `${at.dataset.pickLabel}里的图片`;
    img.dataset.pickKind = "image";
  }
  fixBlocksInParagraphs(container);
  // 页面比面板宽时整体缩小（frame.ts 的脚本按 data-fit 算）
  const wrapper = container.querySelector<HTMLElement>(".docx-wrapper");
  if (wrapper) {
    wrapper.dataset.fit = "auto";
    wrapper.dataset.fitMargin = "32";
  }

  const css = Array.from(styles.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  return { body: container.innerHTML, css };
}

/** 原文件按 edits 改好，返回新文件的字节；没有能改的地方时 null */
export async function saveDocx(bytes: ArrayBuffer, edits: Edits): Promise<Uint8Array<ArrayBuffer> | null> {
  const pkg = await OfficePackage.load(bytes);
  const main = await pkg.mainPart();
  const doc = main ? await pkg.xml(main) : null;
  if (!main || !doc || !applyEdits(doc, edits)) return null;
  pkg.touch(main);
  return pkg.bytes();
}

/** 标注时能选的元素（shared/page-picker.ts 的 data-pick-snap） */
export const DOCX_PICK = "[data-pick-label]";

export const DOCX_CSS = `
.docx-wrapper { background: transparent !important; padding: 20px 16px !important; }
.docx-wrapper > section.docx { box-shadow: 0 1px 4px rgba(0, 0, 0, .18) !important; margin-bottom: 16px !important; flex: none; }
`;
