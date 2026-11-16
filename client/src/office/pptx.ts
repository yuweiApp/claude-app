import { OfficePackage, all, attr, escapeHtml, find, imageType, inside, kid, kids, numAttr, relAttr, type Edits, type Rel } from "./pkg";
import type { RenderedDocument } from "./docx";

/**
 * PowerPoint 演示文稿：自己解析渲染。每张幻灯片是一个固定大小的框，里面的形状按 XML 里写的位置绝对定位；
 * 占位符（标题、正文）没写的位置、字号、项目符号从版式、母版一层层找；颜色、字体从主题里取。
 * 版式、母版上不是占位符的形状（装饰、logo）画在幻灯片内容的下面，只显示，不能选也不能改。
 * 画不了的东西（图表、SmartArt、EMF 图片）画一个带说明的灰框占位置；阴影、三维、动画不管。
 *
 * 段落的键是「p:<第几张幻灯片，从 0 数>:<这张幻灯片里的第几个 <a:p>，按 XML 里的顺序从 0 数>」，
 * 兼容写法（mc:Fallback）里重复的那份不算；文字段是段落里的 <a:r>（一段格式一样的文字）
 */

const DML = "http://schemas.openxmlformats.org/drawingml/2006/main";
/** 幻灯片画多宽（像素），再由 iframe 里的脚本按面板的宽度缩放 */
const SLIDE_WIDTH = 960;
const EMU_PER_PT = 12700;

type RGBA = [number, number, number, number];

interface Deck {
  pkg: OfficePackage;
  /** 每 EMU 多少像素 */
  k: number;
  defaultText: Element | null;
  images: Map<string, string | null>;
}

/** 一个部件（幻灯片、版式、母版）画东西时要用的：它自己的关系（图片）、所属母版的主题和颜色映射 */
interface Part {
  path: string;
  root: Element;
  rels: Map<string, Rel>;
  theme: Theme;
  clrMap: Record<string, string>;
}

interface Theme {
  colors: Record<string, string>;
  major: string | null;
  minor: string | null;
  majorEa: string | null;
  minorEa: string | null;
  lineWidths: number[];
}

// ---------------------------------------------------------------------------
// 颜色

const PRESET_COLORS: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080",
  cyan: "00FFFF", magenta: "FF00FF", orange: "FFA500", purple: "800080", silver: "C0C0C0", navy: "000080", maroon: "800000", lime: "00FF00",
};
const COLOR_TAGS = ["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"];

const hexToRgba = (hex: string): RGBA => [parseInt(hex.slice(0, 2), 16) || 0, parseInt(hex.slice(2, 4), 16) || 0, parseInt(hex.slice(4, 6), 16) || 0, 1];

function rgbToHsl([r, g, b]: RGBA): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const x = (t + 1) % 1;
    return 255 * (x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p);
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}

/** 颜色元素（<a:srgbClr>、<a:schemeClr> …）的颜色，连同里面的亮度、透明度修饰；ph 是「占位色」（主题样式里的 phClr）代表的颜色 */
function colorOf(el: Element | null, part: Part, ph?: RGBA | null): RGBA | null {
  if (!el) return null;
  let c: RGBA | null = null;
  const val = attr(el, "val") ?? "";
  switch (el.localName) {
    case "srgbClr":
      c = hexToRgba(val);
      break;
    case "sysClr":
      c = hexToRgba(attr(el, "lastClr") ?? (val === "window" ? "FFFFFF" : "000000"));
      break;
    case "prstClr":
      c = hexToRgba(PRESET_COLORS[val.toLowerCase()] ?? "000000");
      break;
    case "scrgbClr":
      c = [((numAttr(el, "r") ?? 0) / 100000) * 255, ((numAttr(el, "g") ?? 0) / 100000) * 255, ((numAttr(el, "b") ?? 0) / 100000) * 255, 1];
      break;
    case "schemeClr": {
      if (val === "phClr") c = ph ? [...ph] : null;
      else {
        const hex = part.theme.colors[part.clrMap[val] ?? val];
        c = hex ? hexToRgba(hex) : null;
      }
      break;
    }
  }
  if (!c) return null;
  for (const mod of kids(el)) {
    const v = (numAttr(mod, "val") ?? 100000) / 100000;
    if (mod.localName === "alpha") c[3] = v;
    else if (mod.localName === "lumMod" || mod.localName === "lumOff") {
      const [h, s, l] = rgbToHsl(c);
      const [r, g, b] = hslToRgb(h, s, Math.min(1, Math.max(0, mod.localName === "lumMod" ? l * v : l + v)));
      c = [r, g, b, c[3]];
    } else if (mod.localName === "tint") c = [c[0] * v + 255 * (1 - v), c[1] * v + 255 * (1 - v), c[2] * v + 255 * (1 - v), c[3]];
    else if (mod.localName === "shade") c = [c[0] * v, c[1] * v, c[2] * v, c[3]];
  }
  return c;
}

const colorChild = (el: Element | null | undefined) => kids(el).find((c) => COLOR_TAGS.includes(c.localName)) ?? null;
const cssColor = (c: RGBA) => (c[3] >= 1 ? `rgb(${c.slice(0, 3).map(Math.round).join(",")})` : `rgba(${c.slice(0, 3).map(Math.round).join(",")},${Math.round(c[3] * 100) / 100})`);

// ---------------------------------------------------------------------------
// 填充、线条

interface Fill {
  /** background 的值；none 是明确写了不填充 */
  css: string;
  /** 给 SVG 用的单色（渐变取第一个颜色） */
  solid: string;
}

/** spPr、tcPr、bgPr 这类元素里写的填充；没写时 null（再去样式、占位符里找） */
async function fillOf(el: Element | null, part: Part, deck: Deck, ph?: RGBA | null): Promise<Fill | null> {
  for (const f of kids(el)) {
    if (f.localName === "noFill") return { css: "none", solid: "none" };
    if (f.localName === "solidFill") {
      const c = colorOf(colorChild(f), part, ph);
      return c ? { css: cssColor(c), solid: cssColor(c) } : null;
    }
    if (f.localName === "gradFill") {
      const stops = kids(kid(f, "gsLst"), "gs")
        .map((gs) => ({ pos: (numAttr(gs, "pos") ?? 0) / 1000, color: colorOf(colorChild(gs), part, ph) }))
        .filter((s): s is { pos: number; color: RGBA } => s.color !== null)
        .sort((a, b) => a.pos - b.pos);
      if (!stops.length) return null;
      const list = stops.map((s) => `${cssColor(s.color)} ${s.pos}%`).join(",");
      const lin = kid(f, "lin");
      const css = kid(f, "path") ? `radial-gradient(${list})` : `linear-gradient(${(numAttr(lin, "ang") ?? 5400000) / 60000 + 90}deg,${list})`;
      return { css, solid: cssColor(stops[0]!.color) };
    }
    if (f.localName === "blipFill") {
      const url = await imageUrl(relAttr(kid(f, "blip"), "embed"), part, deck);
      // 单引号：这段 CSS 是放进 style="…" 属性里的，双引号会把属性截断（data: 地址里没有单引号）
      return url ? { css: `url('${url}') center/${kid(f, "tile") ? "auto" : "100% 100%"} no-repeat`, solid: "#ccc" } : null;
    }
    if (f.localName === "pattFill") {
      const c = colorOf(colorChild(kid(f, "fgClr")), part, ph);
      return c ? { css: cssColor(c), solid: cssColor(c) } : null;
    }
    if (f.localName === "grpFill") return null;
  }
  return null;
}

interface Line {
  width: number;
  color: string;
  dash: string;
}

/** <a:ln>（或表格单元格的 lnL 等）；没有线、没写时 null，none 是明确写了没有线 */
function lineOf(ln: Element | null, part: Part, deck: Deck, ph?: RGBA | null): Line | "none" | null {
  if (!ln) return null;
  if (kid(ln, "noFill")) return "none";
  const c = colorOf(colorChild(kid(ln, "solidFill")), part, ph) ?? colorOf(colorChild(kid(kid(kid(ln, "gradFill"), "gsLst"), "gs")), part, ph);
  if (!c) return null;
  const dash = attr(kid(ln, "prstDash"), "val") ?? "solid";
  return { width: Math.max(0.75, (numAttr(ln, "w") ?? 9525) * deck.k), color: cssColor(c), dash: dash === "solid" ? "solid" : /dot/i.test(dash) ? "dotted" : "dashed" };
}

async function imageUrl(relId: string | null, part: Part, deck: Deck): Promise<string | null> {
  const rel = relId ? part.rels.get(relId) : undefined;
  if (!rel || rel.external) return null;
  if (!deck.images.has(rel.target)) {
    const type = imageType(rel.target);
    deck.images.set(rel.target, type ? await deck.pkg.dataUrl(rel.target, type) : null);
  }
  return deck.images.get(rel.target) ?? null;
}

// ---------------------------------------------------------------------------
// 位置

interface Box {
  x: number;
  y: number;
  cx: number;
  cy: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

function boxOf(xfrm: Element | null): Box | null {
  const off = kid(xfrm, "off");
  const ext = kid(xfrm, "ext");
  if (!xfrm || !off || !ext) return null;
  return {
    x: numAttr(off, "x") ?? 0,
    y: numAttr(off, "y") ?? 0,
    cx: numAttr(ext, "cx") ?? 0,
    cy: numAttr(ext, "cy") ?? 0,
    rot: (numAttr(xfrm, "rot") ?? 0) / 60000,
    flipH: attr(xfrm, "flipH") === "1" || attr(xfrm, "flipH") === "true",
    flipV: attr(xfrm, "flipV") === "1" || attr(xfrm, "flipV") === "true",
  };
}

/** 坐标系：像素 = (EMU − 原点) × 比例。组合里的形状用组合自己的坐标系 */
interface Frame {
  ox: number;
  oy: number;
  sx: number;
  sy: number;
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

function placeCss(box: Box, frame: Frame): string {
  let css = `left:${px((box.x - frame.ox) * frame.sx)};top:${px((box.y - frame.oy) * frame.sy)};width:${px(box.cx * frame.sx)};height:${px(box.cy * frame.sy)};`;
  if (box.rot) css += `transform:rotate(${Math.round(box.rot * 100) / 100}deg);`;
  return css;
}

// ---------------------------------------------------------------------------
// 形状的轮廓

/** 多边形的预设形状，坐标是宽高的百分比 */
const POLYGONS: Record<string, string> = {
  triangle: "50,0 100,100 0,100",
  rtTriangle: "0,0 100,100 0,100",
  diamond: "50,0 100,50 50,100 0,50",
  flowChartDecision: "50,0 100,50 50,100 0,50",
  parallelogram: "25,0 100,0 75,100 0,100",
  flowChartInputOutput: "20,0 100,0 80,100 0,100",
  trapezoid: "25,0 75,0 100,100 0,100",
  pentagon: "50,0 100,38 81,100 19,100 0,38",
  hexagon: "25,0 75,0 100,50 75,100 25,100 0,50",
  octagon: "29,0 71,0 100,29 100,71 71,100 29,100 0,71 0,29",
  rightArrow: "0,25 60,25 60,0 100,50 60,100 60,75 0,75",
  leftArrow: "100,25 40,25 40,0 0,50 40,100 40,75 100,75",
  upArrow: "50,0 100,40 75,40 75,100 25,100 25,40 0,40",
  downArrow: "50,100 100,60 75,60 75,0 25,0 25,60 0,60",
  leftRightArrow: "0,50 25,0 25,25 75,25 75,0 100,50 75,100 75,75 25,75 25,100",
  chevron: "0,0 75,0 100,50 75,100 0,100 25,50",
  homePlate: "0,0 75,0 100,50 75,100 0,100",
  star5: "50,0 61,38 100,38 69,61 81,100 50,76 19,100 31,61 0,38 39,38",
  plus: "33,0 67,0 67,33 100,33 100,67 67,67 67,100 33,100 33,67 0,67 0,33 33,33",
  mathPlus: "40,10 60,10 60,40 90,40 90,60 60,60 60,90 40,90 40,60 10,60 10,40 40,40",
};
const ELLIPSES = new Set(["ellipse", "flowChartConnector", "wedgeEllipseCallout", "donut"]);
const LINES = new Set(["line", "straightConnector1", "bentConnector2", "bentConnector3", "bentConnector4", "bentConnector5", "curvedConnector2", "curvedConnector3", "curvedConnector4", "curvedConnector5"]);
/** 只有线条的形状（括号、弧线）：画不出来，至少不要画成一块实心的 */
const OUTLINES = new Set(["arc", "leftBracket", "rightBracket", "leftBrace", "rightBrace", "bracketPair", "bracePair"]);

/** 自定义形状（<a:custGeom>）的路径转成 SVG 的 path；每条路径有自己的坐标范围，换算到 0–100 */
function customPath(geom: Element): string {
  let d = "";
  for (const path of kids(kid(geom, "pathLst"), "path")) {
    const w = numAttr(path, "w") || 1;
    const h = numAttr(path, "h") || 1;
    const pt = (el: Element) => {
      const x = ((numAttr(el, "x") ?? 0) / w) * 100;
      const y = ((numAttr(el, "y") ?? 0) / h) * 100;
      return { x, y, s: `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}` };
    };
    let cur = { x: 0, y: 0 };
    for (const cmd of kids(path)) {
      const pts = kids(cmd, "pt").map(pt);
      if (cmd.localName === "moveTo" && pts[0]) d += `M${pts[0].s}`;
      else if (cmd.localName === "lnTo" && pts[0]) d += `L${pts[0].s}`;
      else if (cmd.localName === "cubicBezTo" && pts.length === 3) d += `C${pts.map((p) => p.s).join(" ")}`;
      else if (cmd.localName === "quadBezTo" && pts.length === 2) d += `Q${pts.map((p) => p.s).join(" ")}`;
      else if (cmd.localName === "close") d += "Z";
      else if (cmd.localName === "arcTo") {
        // 从当前点沿椭圆走 swAng：当前点在椭圆上 stAng 的位置
        const rx = ((numAttr(cmd, "wR") ?? 0) / w) * 100;
        const ry = ((numAttr(cmd, "hR") ?? 0) / h) * 100;
        const st = ((numAttr(cmd, "stAng") ?? 0) / 60000) * (Math.PI / 180);
        const sw = ((numAttr(cmd, "swAng") ?? 0) / 60000) * (Math.PI / 180);
        const end = { x: cur.x - rx * Math.cos(st) + rx * Math.cos(st + sw), y: cur.y - ry * Math.sin(st) + ry * Math.sin(st + sw) };
        d += `A${rx},${ry} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${Math.round(end.x * 100) / 100},${Math.round(end.y * 100) / 100}`;
        cur = end;
        continue;
      }
      const last = pts[pts.length - 1];
      if (last) cur = last;
    }
  }
  return d;
}

/** 形状的底：填充、边框、轮廓。返回放在形状框里的 HTML（一个铺满的元素） */
function geometryHtml(spPr: Element | null, box: Box, frame: Frame, fill: Fill | null, line: Line | null): string {
  const custom = kid(spPr, "custGeom");
  const prst = attr(kid(spPr, "prstGeom"), "prst") ?? "rect";
  const flip = box.flipH || box.flipV ? `transform:scale(${box.flipH ? -1 : 1},${box.flipV ? -1 : 1});` : "";
  const stroke = line ? ` stroke="${line.color}" stroke-width="${Math.round(line.width * 100) / 100}"${line.dash === "solid" ? "" : ` stroke-dasharray="${line.dash === "dotted" ? "1 3" : "5 3"}"`}` : ' stroke="none"';
  const svg = (inner: string) =>
    `<svg class="geo" viewBox="0 0 100 100" preserveAspectRatio="none" style="${flip}">${inner.replace("/>", ` vector-effect="non-scaling-stroke"${stroke}/>`)}</svg>`;
  const solid = fill && fill.css !== "none" ? fill.solid : "none";
  if (LINES.has(prst)) {
    // 横线、竖线的框有一边是 0，SVG 至少要 1 像素才画得出来
    if (!line) return "";
    const lw = box.cx * frame.sx;
    const lh = box.cy * frame.sy;
    return `<svg class="geo" viewBox="0 0 ${Math.max(lw, 1)} ${Math.max(lh, 1)}" style="width:${px(Math.max(lw, 1))};height:${px(Math.max(lh, 1))};${flip}"><line x1="0" y1="0" x2="${lw}" y2="${lh}"${stroke}/></svg>`;
  }
  if (OUTLINES.has(prst)) return "";
  if (custom) {
    const d = customPath(custom);
    return d ? svg(`<path d="${d}" fill="${solid}"/>`) : "";
  }
  if (POLYGONS[prst]) return svg(`<polygon points="${POLYGONS[prst]}" fill="${solid}"/>`);
  if (!fill && !line) return "";
  const w = box.cx * frame.sx;
  const h = box.cy * frame.sy;
  let radius = "";
  if (ELLIPSES.has(prst)) radius = "border-radius:50%;";
  else if (prst === "flowChartTerminator") radius = "border-radius:999px;";
  else if (/round/i.test(prst)) {
    const adj = kids(find(spPr, "prstGeom", "avLst"), "gd").find((g) => attr(g, "name") === "adj" || attr(g, "name") === "adj1");
    const ratio = adj ? Number(/val (-?\d+)/.exec(attr(adj, "fmla") ?? "")?.[1] ?? 16667) / 100000 : 0.16667;
    const r = px(Math.min(w, h) * Math.min(0.5, Math.max(0, ratio)));
    radius = prst === "round2SameRect" ? `border-radius:${r} ${r} 0 0;` : prst === "round1Rect" ? `border-radius:0 ${r} 0 0;` : `border-radius:${r};`;
  }
  return `<div class="geo" style="${flip}${radius}${fill && fill.css !== "none" ? `background:${fill.css};` : ""}${line ? `border:${px(line.width)} ${line.dash} ${line.color};` : ""}"></div>`;
}

// ---------------------------------------------------------------------------
// 文字

/** 找文字属性的顺序：段落自己的 → 形状的 lstStyle → 版式、母版里对应占位符的 → 母版的文字样式 → 演示文稿的默认 */
interface TextStyle {
  /** 各带 lvl1pPr … lvl9pPr 的元素，靠前的优先 */
  lists: (Element | null)[];
  /** 形状样式（<p:style> 的 fontRef）给的文字颜色 */
  fontColor: RGBA | null;
  /** 自动缩小文字的比例 */
  scale: number;
  /** 表格的标题行这类：没写颜色、粗细时用的 */
  color?: RGBA | null;
  bold?: boolean;
}

/** 用 Wingdings 这类符号字体写的项目符号，换成普通字体里长得像的 */
const SYMBOL_BULLETS: Record<string, string> = { "§": "▪", "Ø": "➢", "ü": "✓", l: "●", n: "■", q: "❑", v: "❖", u: "◆", "·": "•", o: "○" };

function first<T>(els: (Element | null)[], get: (el: Element) => T | null | undefined): T | null {
  for (const el of els) {
    if (!el) continue;
    const v = get(el);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function fontFamily(name: string | null, theme: Theme): string | null {
  if (!name) return null;
  if (name === "+mj-lt") return theme.major;
  if (name === "+mn-lt") return theme.minor;
  if (name === "+mj-ea") return theme.majorEa;
  if (name === "+mn-ea") return theme.minorEa;
  return name.startsWith("+") ? null : name;
}

/** 一段文字（<a:r>）的样式；sources 是按优先顺序排的 rPr、defRPr */
function runCss(sources: (Element | null)[], style: TextStyle, part: Part, deck: Deck): { css: string; size: number } {
  const size = ((first(sources, (e) => numAttr(e, "sz")) ?? 1800) / 100) * EMU_PER_PT * deck.k * style.scale;
  let css = `font-size:${px(size)};`;
  const flag = (name: string) => first(sources, (e) => attr(e, name));
  const bold = flag("b");
  if (bold === "1" || bold === "true" || (bold === null && style.bold)) css += "font-weight:700;";
  const italic = flag("i");
  if (italic === "1" || italic === "true") css += "font-style:italic;";
  const underline = flag("u");
  const strike = flag("strike");
  const deco = [underline && underline !== "none" ? "underline" : "", strike && strike !== "noStrike" ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) css += `text-decoration:${deco};`;
  const color = first(sources, (e) => colorOf(colorChild(kid(e, "solidFill")), part)) ?? style.color ?? style.fontColor;
  const fallback = part.theme.colors[part.clrMap.tx1 ?? "dk1"];
  css += `color:${color ? cssColor(color) : fallback ? `#${fallback}` : "#000"};`;
  const latin = fontFamily(first(sources, (e) => attr(kid(e, "latin"), "typeface")), part.theme) ?? part.theme.minor;
  const ea = fontFamily(first(sources, (e) => attr(kid(e, "ea"), "typeface")), part.theme) ?? part.theme.minorEa;
  const fonts = [latin, ea].filter((f): f is string => !!f).map((f) => JSON.stringify(f).replaceAll('"', "'"));
  if (fonts.length) css += `font-family:${fonts.join(",")},sans-serif;`;
  const baseline = first(sources, (e) => numAttr(e, "baseline"));
  if (baseline) css += `vertical-align:${baseline > 0 ? "super" : "sub"};font-size:${px(size * 0.65)};`;
  const spacing = first(sources, (e) => numAttr(e, "spc"));
  if (spacing) css += `letter-spacing:${px((spacing / 100) * EMU_PER_PT * deck.k)};`;
  const cap = flag("cap");
  if (cap === "all") css += "text-transform:uppercase;";
  return { css, size };
}

interface SlideState {
  index: number;
  /** 这张幻灯片里的 <a:p>，按 XML 里的顺序；装饰（版式、母版上的）不在里面 */
  paras: Element[];
}

/** 文字框里的段落；state 是 null 时（版式、母版上的装饰）只显示，不带能改的标记 */
function paragraphsHtml(txBody: Element | null, style: TextStyle, part: Part, deck: Deck, state: SlideState | null): string {
  let html = "";
  const counters = new Map<number, number>();
  for (const p of kids(txBody, "p")) {
    const pPr = kid(p, "pPr");
    const lvl = numAttr(pPr, "lvl") ?? 0;
    const props = [pPr, ...style.lists.map((l) => kid(l, `lvl${lvl + 1}pPr`))];
    const defaults = props.map((e) => kid(e, "defRPr"));
    const runs = kids(p).filter((c) => c.localName === "r" || c.localName === "br" || c.localName === "fld");
    const hasText = runs.some((r) => r.localName !== "br" && (kid(r, "t")?.textContent ?? "") !== "");

    let css = "";
    const align = first(props, (e) => attr(e, "algn"));
    if (align && align !== "l") css += `text-align:${align === "ctr" ? "center" : align === "r" ? "right" : "justify"};`;
    const marL = (first(props, (e) => numAttr(e, "marL")) ?? 0) * deck.k;
    const indent = (first(props, (e) => numAttr(e, "indent")) ?? 0) * deck.k;
    if (marL) css += `padding-left:${px(marL)};`;
    if (indent) css += `text-indent:${px(indent)};`;
    const base = runCss([kid(p, "endParaRPr"), ...defaults], style, part, deck);
    const spacing = (name: string): string | null => {
      const el = first(props, (e) => kid(e, name));
      const pct = numAttr(kid(el, "spcPct"), "val");
      const pts = numAttr(kid(el, "spcPts"), "val");
      if (pct !== null) return name === "lnSpc" ? String(Math.round((pct / 100000) * 1.2 * 100) / 100) : px((pct / 100000) * base.size * 1.2);
      if (pts !== null) return px((pts / 100) * EMU_PER_PT * deck.k);
      return null;
    };
    const lineHeight = spacing("lnSpc");
    if (lineHeight) css += `line-height:${lineHeight};`;
    const before = spacing("spcBef");
    if (before) css += `margin-top:${before};`;
    const after = spacing("spcAft");
    if (after) css += `margin-bottom:${after};`;

    // 项目符号：最先找到的那个说了算（buNone 是明确不要）
    let bullet = "";
    const bu = first(props, (e) => kids(e).find((c) => c.localName === "buNone" || c.localName === "buChar" || c.localName === "buAutoNum"));
    if (bu && bu.localName !== "buNone" && hasText) {
      let mark: string;
      if (bu.localName === "buChar") {
        const ch = attr(bu, "char") ?? "•";
        const font = first(props, (e) => attr(kid(e, "buFont"), "typeface")) ?? "";
        mark = /wingdings|symbol|webdings/i.test(font) ? (SYMBOL_BULLETS[ch] ?? "•") : ch;
        counters.delete(lvl);
      } else {
        const n = (counters.get(lvl) ?? (numAttr(bu, "startAt") ?? 1) - 1) + 1;
        counters.set(lvl, n);
        const type = attr(bu, "type") ?? "arabicPeriod";
        const label = /^alphaLc/.test(type) ? String.fromCharCode(96 + (((n - 1) % 26) + 1)) : /^alphaUc/.test(type) ? String.fromCharCode(64 + (((n - 1) % 26) + 1)) : String(n);
        mark = /ParenBoth$/.test(type) ? `(${label})` : /ParenR$/.test(type) ? `${label})` : /Period$/.test(type) ? `${label}.` : label;
      }
      for (const [l] of counters) if (l > lvl) counters.delete(l);
      const buColor = first(props, (e) => colorOf(colorChild(kid(e, "buClr")), part));
      const buSize = first(props, (e) => numAttr(kid(e, "buSzPct"), "val"));
      bullet =
        `<span class="bu" data-noedit contenteditable="false" style="min-width:${px(Math.max(0, -indent))};${base.css}` +
        `${buColor ? `color:${cssColor(buColor)};` : ""}${buSize ? `font-size:${px((base.size * buSize) / 100000)};` : ""}">${escapeHtml(mark)}</span>`;
    } else if (!bu || bu.localName === "buNone") counters.delete(lvl);

    let inner = "";
    let seg = 0;
    for (const r of runs) {
      if (r.localName === "br") inner += "<br>";
      else {
        const { css: runStyle } = runCss([kid(r, "rPr"), ...defaults], style, part, deck);
        const text = escapeHtml(kid(r, "t")?.textContent ?? "");
        // 域（页码、日期）的文字是 PowerPoint 算出来的，不能改
        inner += r.localName === "fld" ? `<span data-noedit contenteditable="false" style="${runStyle}">${text}</span>` : `<span data-seg="${seg++}" style="${runStyle}">${text}</span>`;
      }
    }
    const n = state ? state.paras.indexOf(p) : -1;
    const edit = state && n >= 0 ? ` data-edit="p:${state.index}:${n}" data-segs="${seg}"` : "";
    // 空段落也占一行：按段落末尾的字号留出高度
    html += `<div class="para"${edit} style="${css}${inner ? "" : `min-height:${px(base.size * 1.2)};`}${base.css}">${bullet}${inner}</div>`;
  }
  return html;
}

interface BodyProps {
  css: string;
  scale: number;
}

/** 文字框的边距、上下对齐、自动缩小；bodyPrs 是形状自己的、版式的、母版的，靠前的优先 */
function bodyProps(bodyPrs: (Element | null)[], deck: Deck): BodyProps {
  const inset = (name: string, fallback: number) => px((first(bodyPrs, (e) => numAttr(e, name)) ?? fallback) * deck.k);
  let css = `padding:${inset("tIns", 45720)} ${inset("rIns", 91440)} ${inset("bIns", 45720)} ${inset("lIns", 91440)};`;
  const anchor = first(bodyPrs, (e) => attr(e, "anchor"));
  css += `justify-content:${anchor === "ctr" ? "center" : anchor === "b" ? "flex-end" : "flex-start"};`;
  if (first(bodyPrs, (e) => attr(e, "wrap")) === "none") css += "white-space:nowrap;align-items:" + (first(bodyPrs, (e) => attr(e, "anchorCtr")) === "1" ? "center;" : "flex-start;");
  const vert = first(bodyPrs, (e) => attr(e, "vert"));
  if (vert === "eaVert" || vert === "vert" || vert === "wordArtVertRtl") css += "writing-mode:vertical-rl;";
  else if (vert === "vert270") css += "writing-mode:sideways-lr;";
  const fit = first(bodyPrs, (e) => kid(e, "normAutofit"));
  return { css, scale: (numAttr(fit, "fontScale") ?? 100000) / 100000 };
}

// ---------------------------------------------------------------------------
// 占位符

/** 占位符的种类归成母版里有的那几种 */
function placeholderKind(type: string | null): string {
  if (type === "ctrTitle" || type === "title") return "title";
  if (type === "dt" || type === "ftr" || type === "sldNum" || type === "hdr") return type;
  if (type === "pic") return "pic";
  return "body";
}

function placeholderOf(sp: Element): { type: string | null; idx: string | null } | null {
  const ph = all(kid(sp, "nvSpPr") ?? kid(sp, "nvPicPr") ?? kid(sp, "nvGraphicFramePr"), "ph")[0];
  return ph ? { type: attr(ph, "type"), idx: attr(ph, "idx") } : null;
}

/** 版式、母版里和这个占位符对应的形状：版式先按 idx、再按种类；母版按种类 */
function matchPlaceholder(root: Element | null, ph: { type: string | null; idx: string | null }, byIdx: boolean): Element | null {
  const shapes = all(find(root, "cSld", "spTree"), "sp").filter((s) => placeholderOf(s));
  if (byIdx && ph.idx !== null) {
    const hit = shapes.find((s) => placeholderOf(s)!.idx === ph.idx);
    if (hit) return hit;
  }
  const kind = placeholderKind(ph.type);
  return shapes.find((s) => placeholderKind(placeholderOf(s)!.type) === kind) ?? null;
}

// ---------------------------------------------------------------------------
// 形状

interface Layers {
  slide: Part;
  layout: Part | null;
  master: Part | null;
}

const nameOf = (sp: Element) => attr(all(kid(sp, "nvSpPr") ?? kid(sp, "nvPicPr") ?? kid(sp, "nvGraphicFramePr") ?? kid(sp, "nvGrpSpPr") ?? kid(sp, "nvCxnSpPr"), "cNvPr")[0], "name") ?? "";

function pickAttrs(state: SlideState | null, what: string, kind: string, sp: Element): string {
  if (!state) return "";
  const name = nameOf(sp);
  return ` data-pick-label="${escapeHtml(`第 ${state.index + 1} 张幻灯片的${what}${name ? `「${name}」` : ""}`)}" data-pick-kind="${kind}"`;
}

async function shapeHtml(sp: Element, part: Part, layers: Layers, deck: Deck, frame: Frame, state: SlideState | null): Promise<string> {
  const spPr = kid(sp, "spPr");
  const ph = placeholderOf(sp);
  // 版式、母版上的占位符只是给幻灯片定位置和样式的，不画
  if (ph && !state) return "";
  const layoutPh = ph && state ? matchPlaceholder(layers.layout?.root ?? null, ph, true) : null;
  const masterPh = ph && state ? matchPlaceholder(layers.master?.root ?? null, ph, false) : null;
  const box = boxOf(kid(spPr, "xfrm")) ?? boxOf(find(layoutPh, "spPr", "xfrm")) ?? boxOf(find(masterPh, "spPr", "xfrm"));
  if (!box) return "";
  const txBody = kid(sp, "txBody");
  const hasText = all(txBody, "t").some((t) => t.textContent);
  // 没填内容的占位符放映时是看不见的
  if (ph && !hasText && !kid(spPr, "solidFill") && !kid(spPr, "blipFill")) return "";

  const styleEl = kid(sp, "style");
  const refColor = (name: string) => {
    const ref = kid(styleEl, name);
    return ref && attr(ref, "idx") !== "0" ? colorOf(colorChild(ref), part) : null;
  };
  let fill = (await fillOf(spPr, part, deck)) ?? (layoutPh ? await fillOf(kid(layoutPh, "spPr"), layers.layout!, deck) : null) ?? (masterPh ? await fillOf(kid(masterPh, "spPr"), layers.master!, deck) : null);
  if (!fill) {
    const c = refColor("fillRef");
    if (c) fill = { css: cssColor(c), solid: cssColor(c) };
  }
  let line = lineOf(kid(spPr, "ln"), part, deck);
  if (line === null) {
    const c = refColor("lnRef");
    const idx = Number(attr(kid(styleEl, "lnRef"), "idx") ?? 0);
    if (c) line = { width: Math.max(0.75, (part.theme.lineWidths[idx - 1] ?? 9525) * deck.k), color: cssColor(c), dash: "solid" };
  }
  const geometry = geometryHtml(spPr, box, frame, fill, line === "none" ? null : line);

  let text = "";
  if (txBody && (hasText || state)) {
    const kind = ph ? placeholderKind(ph.type) : null;
    const txStyles = kid(layers.master?.root ?? null, "txStyles");
    const body = bodyProps([kid(txBody, "bodyPr"), find(layoutPh, "txBody", "bodyPr"), find(masterPh, "txBody", "bodyPr")], deck);
    const style: TextStyle = {
      lists: [
        kid(txBody, "lstStyle"),
        find(layoutPh, "txBody", "lstStyle"),
        find(masterPh, "txBody", "lstStyle"),
        kind === "title" ? kid(txStyles, "titleStyle") : kind === "body" || kind === "pic" ? kid(txStyles, "bodyStyle") : kind ? kid(txStyles, "otherStyle") : null,
        deck.defaultText,
      ],
      fontColor: ((): RGBA | null => {
        const ref = kid(styleEl, "fontRef");
        return ref ? colorOf(colorChild(ref), part) : null;
      })(),
      scale: body.scale,
    };
    const paras = paragraphsHtml(txBody, style, part, deck, state);
    if (paras) text = `<div class="tx" style="${body.css}">${paras}</div>`;
  }
  if (!geometry && !text) return "";
  return `<div class="sp" style="${placeCss(box, frame)}"${pickAttrs(state, "形状", "shape", sp)}>${geometry}${text}</div>`;
}

async function pictureHtml(pic: Element, part: Part, deck: Deck, frame: Frame, state: SlideState | null): Promise<string> {
  const spPr = kid(pic, "spPr");
  const box = boxOf(kid(spPr, "xfrm"));
  if (!box) return "";
  const blipFill = kid(pic, "blipFill");
  const relId = relAttr(kid(blipFill, "blip"), "embed");
  const url = await imageUrl(relId, part, deck);
  const round = ELLIPSES.has(attr(kid(spPr, "prstGeom"), "prst") ?? "") ? "border-radius:50%;" : "";
  const flip = box.flipH || box.flipV ? `transform:scale(${box.flipH ? -1 : 1},${box.flipV ? -1 : 1});` : "";
  let inner: string;
  if (!url) {
    const target = relId ? part.rels.get(relId)?.target : undefined;
    inner = `<div class="stub">图片${target ? `（${escapeHtml(target.slice(target.lastIndexOf(".") + 1).toUpperCase())} 格式，显示不了）` : ""}</div>`;
  } else {
    // 裁剪（srcRect，各边裁掉的比例）：图片放大、挪位置，露出没裁掉的那块
    const crop = kid(blipFill, "srcRect");
    const l = (numAttr(crop, "l") ?? 0) / 100000;
    const t = (numAttr(crop, "t") ?? 0) / 100000;
    const r = (numAttr(crop, "r") ?? 0) / 100000;
    const b = (numAttr(crop, "b") ?? 0) / 100000;
    const w = 1 - l - r || 1;
    const h = 1 - t - b || 1;
    inner = `<img src="${url}" alt="" draggable="false" style="left:${(-l / w) * 100}%;top:${(-t / h) * 100}%;width:${100 / w}%;height:${100 / h}%;">`;
  }
  const line = lineOf(kid(spPr, "ln"), part, deck);
  const border = line && line !== "none" ? `outline:${px(line.width)} ${line.dash} ${line.color};` : "";
  return `<div class="sp pic" style="${placeCss(box, frame)}${round}${border}"${pickAttrs(state, "图片", "image", pic)}><div class="crop" style="${flip}${round}">${inner}</div></div>`;
}

async function tableHtml(tbl: Element, part: Part, deck: Deck, frame: Frame, state: SlideState | null): Promise<string> {
  const tblPr = kid(tbl, "tblPr");
  const flag = (name: string) => attr(tblPr, name) === "1" || attr(tblPr, name) === "true";
  // 用了表格样式（样式的定义在另一个文件里，没解析）：按 PowerPoint 默认的样子画，标题行用强调色、隔行深浅
  const styled = !!kid(tblPr, "tableStyleId")?.textContent;
  const accent = part.theme.colors.accent1 ? hexToRgba(part.theme.colors.accent1) : null;
  const tinted = (c: RGBA, keep: number): RGBA => [c[0] * keep + 255 * (1 - keep), c[1] * keep + 255 * (1 - keep), c[2] * keep + 255 * (1 - keep), 1];
  const cols = kids(kid(tbl, "tblGrid"), "gridCol").map((c) => (numAttr(c, "w") ?? 0) * frame.sx);
  let html = `<table style="width:${px(cols.reduce((a, b) => a + b, 0))}"><colgroup>${cols.map((w) => `<col style="width:${px(w)}">`).join("")}</colgroup>`;
  const rows = kids(tbl, "tr");
  for (const [r, tr] of rows.entries()) {
    html += `<tr style="height:${px((numAttr(tr, "h") ?? 0) * frame.sy)}">`;
    const header = styled && flag("firstRow") && r === 0;
    for (const tc of kids(tr, "tc")) {
      if (attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1" || attr(tc, "hMerge") === "true" || attr(tc, "vMerge") === "true") continue;
      const tcPr = kid(tc, "tcPr");
      let css = "";
      const fill = await fillOf(tcPr, part, deck);
      if (fill && fill.css !== "none") css += `background:${fill.css};`;
      else if (!fill && styled && accent) {
        const band = flag("bandRow") && (r - (flag("firstRow") ? 1 : 0)) % 2 === 0;
        css += `background:${cssColor(header ? accent : tinted(accent, band ? 0.3 : 0.15))};`;
      }
      for (const [side, name] of [["left", "lnL"], ["right", "lnR"], ["top", "lnT"], ["bottom", "lnB"]] as const) {
        const line = lineOf(kid(tcPr, name), part, deck);
        if (line === "none") css += `border-${side}:none;`;
        else if (line) css += `border-${side}:${px(line.width)} ${line.dash} ${line.color};`;
        else if (styled) css += `border-${side}:1px solid #fff;`;
      }
      const mar = (name: string, fallback: number) => px((numAttr(tcPr, name) ?? fallback) * deck.k);
      css += `padding:${mar("marT", 45720)} ${mar("marR", 91440)} ${mar("marB", 45720)} ${mar("marL", 91440)};`;
      const anchor = attr(tcPr, "anchor");
      css += `vertical-align:${anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top"};`;
      const style: TextStyle = { lists: [find(tc, "txBody", "lstStyle"), deck.defaultText], fontColor: null, scale: 1, ...(header ? { color: [255, 255, 255, 1] as RGBA, bold: true } : {}) };
      const span = `${numAttr(tc, "gridSpan") ? ` colspan="${numAttr(tc, "gridSpan")}"` : ""}${numAttr(tc, "rowSpan") ? ` rowspan="${numAttr(tc, "rowSpan")}"` : ""}`;
      html += `<td${span} style="${css}">${paragraphsHtml(kid(tc, "txBody"), style, part, deck, state)}</td>`;
    }
    html += "</tr>";
  }
  return `${html}</table>`;
}

async function frameHtml(gf: Element, part: Part, deck: Deck, frame: Frame, state: SlideState | null): Promise<string> {
  const box = boxOf(kid(gf, "xfrm"));
  if (!box) return "";
  const data = find(gf, "graphic", "graphicData");
  const tbl = kid(data, "tbl");
  if (tbl) return `<div class="sp tbl" style="${placeCss(box, frame)}"${pickAttrs(state, "表格", "table", gf)}>${await tableHtml(tbl, part, deck, frame, state)}</div>`;
  const uri = attr(data, "uri") ?? "";
  const what = /chart/.test(uri) ? "图表" : /diagram/.test(uri) ? "SmartArt 图形" : /ole/.test(uri) ? "嵌入的对象" : "";
  if (!what) return "";
  return `<div class="sp" style="${placeCss(box, frame)}"${pickAttrs(state, what, "object", gf)}><div class="stub">${what}（这里显示不了）</div></div>`;
}

/** 一棵形状树（幻灯片的 spTree 或者一个组合）里的东西，按 XML 里的顺序（就是叠放的顺序） */
async function treeHtml(tree: Element | null, part: Part, layers: Layers, deck: Deck, frame: Frame, state: SlideState | null): Promise<string> {
  let html = "";
  for (let el of kids(tree)) {
    // 新写法和兼容写法两份并排放着：用新写法那份
    if (el.localName === "AlternateContent") {
      const choice = kid(kid(el, "Choice"), "sp") ?? kid(kid(el, "Choice"), "pic") ?? kid(kid(el, "Choice"), "grpSp") ?? kid(kid(el, "Choice"), "graphicFrame") ?? kid(kid(el, "Choice"), "cxnSp");
      if (!choice) continue;
      el = choice;
    }
    if (el.localName === "sp" || el.localName === "cxnSp") html += await shapeHtml(el, part, layers, deck, frame, state);
    else if (el.localName === "pic") html += await pictureHtml(el, part, deck, frame, state);
    else if (el.localName === "graphicFrame") html += await frameHtml(el, part, deck, frame, state);
    else if (el.localName === "grpSp") {
      const xfrm = find(el, "grpSpPr", "xfrm");
      const box = boxOf(xfrm);
      const chOff = kid(xfrm, "chOff");
      const chExt = kid(xfrm, "chExt");
      if (!box) continue;
      const w = numAttr(chExt, "cx") || box.cx || 1;
      const h = numAttr(chExt, "cy") || box.cy || 1;
      const inner: Frame = { ox: numAttr(chOff, "x") ?? box.x, oy: numAttr(chOff, "y") ?? box.y, sx: (frame.sx * box.cx) / w, sy: (frame.sy * box.cy) / h };
      const flip = box.flipH || box.flipV ? ` scale(${box.flipH ? -1 : 1},${box.flipV ? -1 : 1})` : "";
      html += `<div class="sp grp" style="${placeCss({ ...box, rot: 0 }, frame)}${box.rot || flip ? `transform:rotate(${box.rot}deg)${flip};` : ""}">${await treeHtml(el, part, layers, deck, inner, state)}</div>`;
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// 演示文稿

async function loadTheme(pkg: OfficePackage, path: string | undefined): Promise<Theme> {
  const root = (path ? await pkg.xml(path) : null)?.documentElement ?? null;
  const elements = find(root, "themeElements");
  const colors: Record<string, string> = {};
  for (const c of kids(kid(elements, "clrScheme"))) {
    const hex = attr(kid(c, "srgbClr"), "val") ?? attr(kid(c, "sysClr"), "lastClr");
    if (hex) colors[c.localName] = hex;
  }
  const fonts = kid(elements, "fontScheme");
  const face = (group: string, tag: string) => attr(find(fonts, group, tag), "typeface") || null;
  return {
    colors,
    major: face("majorFont", "latin"),
    minor: face("minorFont", "latin"),
    majorEa: face("majorFont", "ea"),
    minorEa: face("minorFont", "ea"),
    lineWidths: kids(find(elements, "fmtScheme", "lnStyleLst"), "ln").map((ln) => numAttr(ln, "w") ?? 9525),
  };
}

const DEFAULT_CLR_MAP: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };

async function loadPart(pkg: OfficePackage, path: string, theme: Theme, clrMap: Record<string, string>): Promise<Part | null> {
  const doc = await pkg.xml(path);
  return doc ? { path, root: doc.documentElement, rels: await pkg.rels(path), theme, clrMap } : null;
}

const relOf = (rels: Map<string, Rel>, suffix: string) => [...rels.values()].find((r) => r.type.endsWith(suffix))?.target;

/** 幻灯片的背景：自己的 → 版式的 → 母版的 */
async function backgroundCss(layers: Layers, deck: Deck): Promise<string> {
  for (const part of [layers.slide, layers.layout, layers.master]) {
    const bg = find(part?.root ?? null, "cSld", "bg");
    if (!part || !bg) continue;
    const fill = await fillOf(kid(bg, "bgPr"), part, deck);
    if (fill && fill.css !== "none") return fill.css;
    const ref = kid(bg, "bgRef");
    const c = ref ? colorOf(colorChild(ref), part) : null;
    if (c) return cssColor(c);
  }
  return "#fff";
}

/** 幻灯片里的段落，按 XML 里的顺序 */
function slideParagraphs(root: Element): Element[] {
  const tree = find(root, "cSld", "spTree");
  return all(tree, "p").filter((p) => p.namespaceURI === DML && !inside(p, "Fallback", tree));
}

/** 改动写进幻灯片的 XML：只改 <a:t> 的文字；空段落里新建一段文字（格式随段落末尾的 endParaRPr） */
function applyEdits(doc: Document, slideIndex: number, edits: Edits): boolean {
  const paras = slideParagraphs(doc.documentElement);
  let changed = false;
  for (const [key, segs] of Object.entries(edits)) {
    const m = /^p:(\d+):(\d+)$/.exec(key);
    if (!m || Number(m[1]) !== slideIndex || !Array.isArray(segs)) continue;
    const p = paras[Number(m[2])];
    if (!p) continue;
    const runs = kids(p, "r");
    const name = (local: string) => (p.prefix ? `${p.prefix}:${local}` : local);
    if (runs.length === 0) {
      const text = segs.filter((s) => typeof s === "string").join("");
      if (!text) continue;
      const run = doc.createElementNS(DML, name("r"));
      const end = kid(p, "endParaRPr");
      if (end) {
        const rPr = doc.createElementNS(DML, name("rPr"));
        for (const a of Array.from(end.attributes)) rPr.setAttribute(a.name, a.value);
        for (const c of Array.from(end.childNodes)) rPr.appendChild(c.cloneNode(true));
        run.appendChild(rPr);
      }
      const t = doc.createElementNS(DML, name("t"));
      t.textContent = text;
      run.appendChild(t);
      p.insertBefore(run, end);
      changed = true;
      continue;
    }
    segs.forEach((s, i) => {
      if (typeof s !== "string") return;
      const run = runs[Math.min(i, runs.length - 1)]!;
      let t = kid(run, "t");
      if (!t) {
        t = doc.createElementNS(DML, name("t"));
        run.appendChild(t);
      }
      t.textContent = i < runs.length ? s : (t.textContent ?? "") + s;
      changed = true;
    });
  }
  return changed;
}

async function slidePaths(pkg: OfficePackage): Promise<{ main: string; presentation: Element; rels: Map<string, Rel>; slides: string[] }> {
  const main = await pkg.mainPart();
  const presentation = (main ? await pkg.xml(main) : null)?.documentElement;
  if (!main || !presentation) throw new Error("文件打不开：里面没有 PowerPoint 演示文稿");
  const rels = await pkg.rels(main);
  const slides = kids(kid(presentation, "sldIdLst"), "sldId").flatMap((s) => {
    const rel = rels.get(relAttr(s, "id") ?? "");
    return rel ? [rel.target] : [];
  });
  return { main, presentation, rels, slides };
}

export async function renderPptx(bytes: ArrayBuffer, edits: Edits): Promise<RenderedDocument> {
  const pkg = await OfficePackage.load(bytes);
  const { presentation, slides } = await slidePaths(pkg);
  const size = kid(presentation, "sldSz");
  const cx = numAttr(size, "cx") || 9144000;
  const cy = numAttr(size, "cy") || 6858000;
  const deck: Deck = { pkg, k: SLIDE_WIDTH / cx, defaultText: kid(presentation, "defaultTextStyle"), images: new Map() };
  const height = Math.round(cy * deck.k);
  const frame: Frame = { ox: 0, oy: 0, sx: deck.k, sy: deck.k };
  const masters = new Map<string, Part | null>();
  const layouts = new Map<string, { layout: Part | null; master: Part | null }>();

  let html = "";
  for (const [index, path] of slides.entries()) {
    const doc = await pkg.xml(path);
    if (!doc) continue;
    applyEdits(doc, index, edits);
    const rels = await pkg.rels(path);
    const layoutPath = relOf(rels, "/slideLayout");
    if (layoutPath && !layouts.has(layoutPath)) {
      const masterPath = relOf(await pkg.rels(layoutPath), "/slideMaster");
      if (masterPath && !masters.has(masterPath)) {
        const theme = await loadTheme(pkg, relOf(await pkg.rels(masterPath), "/theme"));
        const masterDoc = await pkg.xml(masterPath);
        const map: Record<string, string> = { ...DEFAULT_CLR_MAP };
        for (const a of Array.from(kid(masterDoc?.documentElement ?? null, "clrMap")?.attributes ?? [])) map[a.localName] = a.value;
        masters.set(masterPath, await loadPart(pkg, masterPath, theme, map));
      }
      const master = masterPath ? (masters.get(masterPath) ?? null) : null;
      const layout = master ? await loadPart(pkg, layoutPath, master.theme, master.clrMap) : null;
      layouts.set(layoutPath, { layout, master });
    }
    const { layout, master } = (layoutPath ? layouts.get(layoutPath) : undefined) ?? { layout: null, master: null };
    const theme = master?.theme ?? (await loadTheme(pkg, undefined));
    const slide: Part = { path, root: doc.documentElement, rels, theme, clrMap: master?.clrMap ?? DEFAULT_CLR_MAP };
    const layers: Layers = { slide, layout, master };
    const state: SlideState = { index, paras: slideParagraphs(doc.documentElement) };

    const shown = (root: Element | null | undefined) => attr(root, "showMasterSp") !== "0" && attr(root, "showMasterSp") !== "false";
    let inner = "";
    if (master && layout && shown(layout.root) && shown(slide.root)) inner += await treeHtml(find(master.root, "cSld", "spTree"), master, layers, deck, frame, null);
    if (layout && shown(slide.root)) inner += await treeHtml(find(layout.root, "cSld", "spTree"), layout, layers, deck, frame, null);
    inner += await treeHtml(find(slide.root, "cSld", "spTree"), slide, layers, deck, frame, state);
    const hidden = attr(slide.root, "show") === "0" || attr(slide.root, "show") === "false";
    html +=
      `<div class="slide-row"><div class="slide-no">${index + 1}${hidden ? "<br>隐藏" : ""}</div>` +
      `<div class="slide" data-fit="${SLIDE_WIDTH}" data-fit-margin="62" data-fit-max="1.25" style="width:${SLIDE_WIDTH}px;height:${height}px;background:${await backgroundCss(layers, deck)};"` +
      ` data-pick-label="第 ${index + 1} 张幻灯片" data-pick-kind="slide">${inner}</div></div>`;
  }
  if (!html) throw new Error("这个演示文稿里没有幻灯片");
  return { body: `<div class="deck">${html}</div>`, css: PPTX_CSS };
}

export async function savePptx(bytes: ArrayBuffer, edits: Edits): Promise<Uint8Array<ArrayBuffer> | null> {
  const pkg = await OfficePackage.load(bytes);
  const { slides } = await slidePaths(pkg);
  let changed = false;
  for (const [index, path] of slides.entries()) {
    const doc = await pkg.xml(path);
    if (doc && applyEdits(doc, index, edits)) {
      pkg.touch(path);
      changed = true;
    }
  }
  return changed ? pkg.bytes() : null;
}

export const PPTX_PICK = "[data-pick-label]";

const PPTX_CSS = `
.deck { padding: 16px 12px 24px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
.slide-row { display: flex; gap: 8px; align-items: flex-start; }
.slide-no { width: 26px; flex: none; padding-top: 2px; text-align: right; font: 12px system-ui, sans-serif; color: var(--muted); user-select: none; }
.slide { position: relative; overflow: hidden; flex: none; box-shadow: 0 1px 4px rgba(0, 0, 0, .18); font-family: Calibri, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; color: #000; line-height: 1.2; }
.sp { position: absolute; box-sizing: border-box; }
.geo { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box; overflow: visible; }
.tx { position: absolute; inset: 0; box-sizing: border-box; display: flex; flex-direction: column; }
.para { margin: 0; min-width: 0; white-space: pre-wrap; overflow-wrap: break-word; }
.bu { display: inline-block; text-indent: 0; }
.pic .crop { position: absolute; inset: 0; overflow: hidden; }
.pic img { position: absolute; max-width: none; }
.tbl table { border-collapse: collapse; table-layout: fixed; }
.tbl td { box-sizing: border-box; overflow: hidden; }
.stub { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4px; box-sizing: border-box; background: #f1f1f1; border: 1px dashed #b5b5b5; color: #777; font: 13px system-ui, sans-serif; text-align: center; }
`;
