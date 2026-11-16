import JSZip from "jszip";

export type { Edits } from "./edits";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const XML_NS = "http://www.w3.org/XML/1998/namespace";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

export interface Rel {
  id: string;
  type: string;
  /** 包里的路径（没有开头的 /）；external 的是原样的网址 */
  target: string;
  external: boolean;
}

/** 一个 Office 文档的包：zip 里的各个 XML 部件。整体的做法见 edits.ts */
export class OfficePackage {
  private docs = new Map<string, Document | null>();
  private changed = new Set<string>();
  private constructor(private zip: JSZip) {}

  static async load(bytes: ArrayBuffer | Uint8Array): Promise<OfficePackage> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new Error("文件打不开：不是 Office 文档（docx、xlsx、pptx），或者已经损坏、加了密码");
    }
    return new OfficePackage(zip);
  }

  has(path: string): boolean {
    return this.zip.file(path) !== null;
  }

  /** 包里的一个 XML；没有这个文件、解析不了时 null。返回的文档改了以后要调 touch，保存时才会写回去 */
  async xml(path: string): Promise<Document | null> {
    if (this.docs.has(path)) return this.docs.get(path)!;
    const text = await this.zip.file(path)?.async("string");
    let doc: Document | null = null;
    if (text !== undefined) {
      doc = new DOMParser().parseFromString(text.replace(/^﻿/, ""), "application/xml");
      if (doc.getElementsByTagName("parsererror").length) doc = null;
    }
    this.docs.set(path, doc);
    return doc;
  }

  touch(path: string): void {
    this.changed.add(path);
  }

  /** 包里的文件转成 data: 地址（图片）；没有时 null */
  async dataUrl(path: string, type: string): Promise<string | null> {
    const b64 = await this.zip.file(path)?.async("base64");
    return b64 === undefined ? null : `data:${type};base64,${b64}`;
  }

  /** 一个部件（如 ppt/slides/slide1.xml）的关系：id → 指向的文件 */
  async rels(part: string): Promise<Map<string, Rel>> {
    const slash = part.lastIndexOf("/");
    const dir = part.slice(0, slash + 1);
    const doc = await this.xml(`${dir}_rels/${part.slice(slash + 1)}.rels`);
    const out = new Map<string, Rel>();
    for (const r of doc ? Array.from(doc.getElementsByTagNameNS(REL_NS, "Relationship")) : []) {
      const id = r.getAttribute("Id");
      const target = r.getAttribute("Target");
      if (!id || target === null) continue;
      const external = r.getAttribute("TargetMode") === "External";
      out.set(id, { id, type: r.getAttribute("Type") ?? "", target: external ? target : resolvePath(dir, target), external });
    }
    return out;
  }

  /** 包的主文档（word/document.xml、xl/workbook.xml、ppt/presentation.xml），按包的关系找 */
  async mainPart(): Promise<string | null> {
    for (const r of (await this.rels("")).values()) if (r.type.endsWith("/officeDocument")) return r.target;
    return null;
  }

  /** 删掉一个部件，连同 [Content_Types].xml 里它的条目；指向它的关系由调用的地方删 */
  async remove(path: string): Promise<void> {
    if (!this.has(path)) return;
    this.zip.remove(path);
    this.docs.delete(path);
    this.changed.delete(path);
    const types = await this.xml("[Content_Types].xml");
    for (const o of types ? Array.from(types.getElementsByTagNameNS(CT_NS, "Override")) : []) {
      if (o.getAttribute("PartName") === `/${path}`) {
        o.remove();
        this.touch("[Content_Types].xml");
      }
    }
  }

  /** 改过的 XML 写回去，重新打包 */
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    const serializer = new XMLSerializer();
    for (const path of this.changed) {
      const doc = this.docs.get(path);
      // 浏览器序列化时带不带 <?xml … ?> 这一行不一定，去掉再统一加上
      if (doc) this.zip.file(path, XML_HEAD + serializer.serializeToString(doc).replace(/^\s*<\?xml[^>]*\?>\s*/, ""));
    }
    this.changed.clear();
    const out = await this.zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
    return new Uint8Array(out);
  }
}

/** 关系里的 Target：/ 开头的从包的根算，否则相对部件所在的文件夹 */
function resolvePath(dir: string, target: string): string {
  const parts = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// XML：各种前缀（w:、a:、p:、x:）只是写法，按不带前缀的名字找

/** 直接子元素里叫这个名字的 */
export function kids(el: Element | null | undefined, name?: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!name || c.localName === name) out.push(c);
  return out;
}

export function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
  return null;
}

/** 一层层往下找：find(sp, "spPr", "xfrm", "off") */
export function find(el: Element | null | undefined, ...names: string[]): Element | null {
  let cur: Element | null = el ?? null;
  for (const n of names) cur = kid(cur, n);
  return cur;
}

/** 里面所有叫这个名字的元素，按文档里的顺序 */
export function all(el: Element | Document | null | undefined, name: string): Element[] {
  return el ? Array.from(el.getElementsByTagNameNS("*", name)) : [];
}

/** 属性，不管前缀（w:val、r:id 都按 val、id 找） */
export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}

const REL_ATTR_NS = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"];
/** 指向关系的属性（r:id、r:embed）：同一个元素上可能还有不带前缀的 id，按命名空间取 */
export function relAttr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const ns of REL_ATTR_NS) {
    const v = el.getAttributeNS(ns, name);
    if (v) return v;
  }
  return null;
}

export function numAttr(el: Element | null | undefined, name: string): number | null {
  const v = attr(el, name);
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 是不是在某个叫 name 的元素里面 */
export function inside(el: Element, name: string, stop?: Element | null): boolean {
  for (let p = el.parentElement; p && p !== stop; p = p.parentElement) if (p.localName === name) return true;
  return false;
}

/** 文字节点 <t> 改成 text，留住首尾空格 */
export function setText(t: Element, text: string): void {
  t.textContent = text;
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
}

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
};
/** 浏览器能显示的图片类型，按扩展名；显示不了的（emf、wmf）null */
export function imageType(path: string): string | null {
  return IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? null;
}
