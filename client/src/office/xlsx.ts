import { OfficePackage, all, attr, escapeHtml, find, kid, kids, numAttr, relAttr, setText, type Edits } from "./pkg";
import type { RenderedDocument } from "./docx";

/**
 * Excel 工作簿：自己解析（工作表、共享字符串、样式、合并单元格、列宽行高），每张表渲染成一个 <table>，底下是切换工作表的标签。
 * 公式不计算，显示文件里存着的上一次算出来的值；改了别的单元格以后，依赖它的公式要等用 Excel 打开时才重算
 * （保存时给工作簿标上「打开时全部重算」）。
 *
 * 单元格的键是「c:<第几张表，从 0 数>:<单元格，如 B2>」，改动只有一段：输入的内容。= 开头是公式，像数字的是数字，
 * 日期格式的单元格里输入 2024-3-1 这样的是日期，TRUE/FALSE 是逻辑值，空的是清空，别的都是文字
 */

const MAX_ROWS = 2000;
const MAX_COLS = 100;
const MAX_CELLS = 60000;

// ---------------------------------------------------------------------------
// 单元格地址

function colName(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return { col, row: Number(m[2]) };
}

function parseRange(ref: string): { c1: number; r1: number; c2: number; r2: number } | null {
  const [a, b] = ref.split(":");
  const from = parseRef(a ?? "");
  const to = parseRef(b ?? a ?? "");
  return from && to ? { c1: Math.min(from.col, to.col), r1: Math.min(from.row, to.row), c2: Math.max(from.col, to.col), r2: Math.max(from.row, to.row) } : null;
}

// ---------------------------------------------------------------------------
// 颜色

/** 老格式的索引颜色（0–63），64、65 是系统的前景、背景色 */
const INDEXED = (
  "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF " +
  "800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF " +
  "000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 " +
  "3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333"
).split(" ");

function tinted(hex: string, tint: number): string {
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    const v = tint < 0 ? c * (1 + tint) : c + (255 - c) * tint;
    return Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  };
  return ch(0) + ch(2) + ch(4);
}

/** <color>、<fgColor> 这类元素的颜色（#RRGGBB）；自动、没写的 null */
function colorOf(el: Element | null, theme: string[]): string | null {
  if (!el) return null;
  const rgb = attr(el, "rgb");
  let hex: string | undefined;
  if (rgb && /^[0-9a-f]{6,8}$/i.test(rgb)) hex = rgb.slice(-6);
  else if (attr(el, "theme") !== null) hex = theme[Number(attr(el, "theme"))];
  else if (attr(el, "indexed") !== null) hex = INDEXED[Number(attr(el, "indexed"))];
  if (!hex) return null;
  const tint = numAttr(el, "tint");
  return `#${tint ? tinted(hex, tint) : hex}`;
}

// ---------------------------------------------------------------------------
// 数字格式

const BUILTIN_FORMATS: Record<number, string> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 14: "yyyy/m/d", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
  18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy/m/d h:mm", 27: 'yyyy"年"m"月"', 28: 'm"月"d"日"', 29: 'm"月"d"日"',
  30: "m/d/yy", 31: 'yyyy"年"m"月"d"日"', 32: 'h"时"mm"分"', 33: 'h"时"mm"分"ss"秒"', 34: 'AM/PM h"时"mm"分"', 35: 'AM/PM h"时"mm"分"ss"秒"',
  36: 'yyyy"年"m"月"', 37: "#,##0;-#,##0", 38: "#,##0;-#,##0", 39: "#,##0.00;-#,##0.00", 40: "#,##0.00;-#,##0.00", 41: "#,##0", 42: "#,##0",
  43: "#,##0.00", 44: "#,##0.00", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "0.00E+00", 49: "@", 50: 'yyyy"年"m"月"', 51: 'm"月"d"日"',
  52: 'yyyy"年"m"月"', 53: 'm"月"d"日"', 54: 'm"月"d"日"', 55: 'AM/PM h"时"mm"分"', 56: 'AM/PM h"时"mm"分"ss"秒"', 57: 'yyyy"年"m"月"', 58: 'm"月"d"日"',
};

type Token = { lit: string } | { code: string };

/** 格式里的一段（; 分开的）拆成原样输出的文字和格式符号 */
function tokenize(section: string): Token[] {
  const out: Token[] = [];
  const lit = (s: string) => {
    const last = out[out.length - 1];
    if (last && "lit" in last) last.lit += s;
    else out.push({ lit: s });
  };
  for (let i = 0; i < section.length; i++) {
    const ch = section[i]!;
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      lit(section.slice(i + 1, end < 0 ? section.length : end));
      i = end < 0 ? section.length : end;
    } else if (ch === "\\") lit(section[++i] ?? "");
    else if (ch === "_") {
      // 留出下一个字符那么宽的空
      i++;
      lit(" ");
    } else if (ch === "*") i++; // 用下一个字符填满，不管
    else if (ch === "[") {
      const end = section.indexOf("]", i);
      const inner = section.slice(i + 1, end < 0 ? section.length : end);
      i = end < 0 ? section.length : end;
      if (/^(h+|m+|s+)$/i.test(inner)) out.push({ code: `[${inner.toLowerCase()}]` });
      else if (inner.startsWith("$")) lit(inner.slice(1).split("-")[0]!); // [$¥-804] 是货币符号
      // 别的（颜色、条件）不管
    } else out.push({ code: ch });
  }
  return out;
}

function sections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "\\" && !quoted) {
      cur += ch + (code[++i] ?? "");
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "[") bracket = true;
    else if (!quoted && ch === "]") bracket = false;
    if (ch === ";" && !quoted && !bracket) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const codes = (tokens: Token[]) => tokens.map((t) => ("code" in t ? t.code : "")).join("");
const isGeneral = (code: string) => /^general$/i.test(code.trim());

/** 是不是日期、时间的格式 */
export function isDateFormat(code: string): boolean {
  if (!code || isGeneral(code)) return false;
  const c = codes(tokenize(sections(code)[0]!));
  return /[ymdhs]/i.test(c) && !/[0#?]/.test(c.replace(/\.0+/g, ""));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_CN = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number, len: number) => String(n).padStart(len, "0");

/** Excel 的日期序号（1900 年 1 月 1 日是 1，小数是一天里的时间）转成 UTC 的 Date */
function serialToDate(v: number, date1904: boolean): Date {
  return new Date(Math.round((v + (date1904 ? 1462 : 0) - 25569) * 86400000));
}
function dateToSerial(ms: number, date1904: boolean): number {
  return ms / 86400000 + 25569 - (date1904 ? 1462 : 0);
}

function formatDate(v: number, tokens: Token[], date1904: boolean): string {
  const d = serialToDate(v, date1904);
  if (Number.isNaN(d.getTime())) return String(v);
  // 连着的同一个字母合成一个符号
  const parts: Token[] = [];
  for (const t of tokens) {
    const last = parts[parts.length - 1];
    if ("code" in t && last && "code" in last && !t.code.startsWith("[") && !last.code.startsWith("[") && last.code[0]!.toLowerCase() === t.code.toLowerCase() && /[ymdhsa]/i.test(t.code)) last.code += t.code;
    else parts.push({ ...t });
  }
  const text = parts.map((p) => ("code" in p ? p.code : "\0")).join("");
  const ampm = /AM\/PM|A\/P/i.test(text);
  const hours = d.getUTCHours();
  let out = "";
  let skip = 0;
  parts.forEach((p, i) => {
    if (skip > 0) {
      skip--;
      return;
    }
    if ("lit" in p) {
      out += p.lit;
      return;
    }
    const c = p.code.toLowerCase();
    const len = c.length;
    if (c === "[h]" || c === "[hh]") out += String(Math.floor(v * 24));
    else if (c[0] === "[" && c[1] === "m") out += String(Math.floor(v * 1440));
    else if (c[0] === "[" && c[1] === "s") out += String(Math.round(v * 86400));
    else if (c[0] === "y") out += len <= 2 ? pad(d.getUTCFullYear() % 100, 2) : String(d.getUTCFullYear());
    else if (c[0] === "d") out += len === 1 ? String(d.getUTCDate()) : len === 2 ? pad(d.getUTCDate(), 2) : len === 3 ? WEEKDAYS[d.getUTCDay()]!.slice(0, 3) : WEEKDAYS[d.getUTCDay()]!;
    else if (c[0] === "h") out += len === 1 ? String(ampm ? hours % 12 || 12 : hours) : pad(ampm ? hours % 12 || 12 : hours, 2);
    else if (c[0] === "s") out += len === 1 ? String(d.getUTCSeconds()) : pad(d.getUTCSeconds(), 2);
    else if (c[0] === "m") {
      // 前面是小时、后面是秒的 m 是分钟，别的是月份
      const prev = parts.slice(0, i).reverse().find((x) => "code" in x && /[a-z]/i.test(x.code)) as { code: string } | undefined;
      const next = parts.slice(i + 1).find((x) => "code" in x && /[a-z]/i.test(x.code)) as { code: string } | undefined;
      const minute = /h/i.test(prev?.code ?? "") || /s/i.test(next?.code ?? "");
      if (minute) out += len === 1 ? String(d.getUTCMinutes()) : pad(d.getUTCMinutes(), 2);
      else out += len === 1 ? String(d.getUTCMonth() + 1) : len === 2 ? pad(d.getUTCMonth() + 1, 2) : len === 3 ? MONTHS[d.getUTCMonth()]!.slice(0, 3) : len === 5 ? MONTHS[d.getUTCMonth()]![0]! : MONTHS[d.getUTCMonth()]!;
    } else if (c[0] === "a") {
      // AM/PM、A/P（后面的 /、P、M 一起吃掉）；aaa、aaaa 是星期
      const rest = parts
        .slice(i, i + 5)
        .map((x) => ("code" in x ? x.code : "\0"))
        .join("");
      const m = /^(AM\/PM|A\/P)/i.exec(rest);
      if (m) {
        out += m[1]!.length > 3 ? (hours < 12 ? "AM" : "PM") : hours < 12 ? "A" : "P";
        // 这个符号占了几个 parts
        let used = len;
        while (used < m[1]!.length) used += ("code" in parts[i + ++skip]! ? (parts[i + skip] as { code: string }).code : "").length;
      } else out += len >= 4 ? `星期${WEEKDAYS_CN[d.getUTCDay()]}` : len === 3 ? `周${WEEKDAYS_CN[d.getUTCDay()]}` : p.code;
    } else if (c === ".") {
      // 秒后面的小数
      const zeros = parts[i + 1] && "code" in parts[i + 1]! && /^0+$/.test((parts[i + 1] as { code: string }).code) ? (parts[i + 1] as { code: string }).code.length : 0;
      if (zeros) {
        out += `.${pad(Math.floor(d.getUTCMilliseconds() / 10 ** (3 - Math.min(zeros, 3))), Math.min(zeros, 3))}`;
        skip = 1;
      } else out += ".";
    } else out += p.code;
  });
  return out;
}

function general(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-9)) return v.toExponential(5).replace(/\.?0+e/, "E").replace("e", "E");
  return String(Number(v.toPrecision(11)));
}

function withThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+$)/g, ",");
}

/** 数字按格式显示成文字；看不懂的格式按常规显示 */
export function formatNumber(value: number, code: string, date1904: boolean): string {
  if (!code || isGeneral(code)) return general(value);
  const parts = sections(code);
  let section = parts[0]!;
  let v = value;
  if (value < 0 && parts.length >= 2) {
    section = parts[1]!;
    v = -value;
  } else if (value === 0 && parts.length >= 3) section = parts[2]!;
  const negative = v < 0;
  if (isGeneral(section)) return general(v);
  const tokens = tokenize(section);
  if (isDateFormat(section)) return value < 0 ? general(value) : formatDate(value, tokens, date1904);

  // 数字的格式符号（0 # ? . , E+ %）前后的文字原样输出
  const first = tokens.findIndex((t) => "code" in t && /[0#?.]/.test(t.code));
  if (first < 0) return tokens.map((t) => ("lit" in t ? t.lit : t.code === "@" ? general(value) : t.code)).join("");
  // 最后一个数字占位符，连同紧跟着的逗号（缩小一千倍的写法）
  let last = first;
  tokens.forEach((t, i) => {
    if ("code" in t && /[0#?]/.test(t.code)) last = i;
  });
  while (tokens[last + 1] && "code" in tokens[last + 1]! && (tokens[last + 1] as { code: string }).code === ",") last++;
  const pattern = codes(tokens.slice(first, last + 1));
  if (pattern.includes("/")) return general(value);
  const affix = (list: Token[]) => list.map((t) => ("lit" in t ? t.lit : t.code)).join("");
  const prefix = affix(tokens.slice(0, first));
  const suffix = affix(tokens.slice(last + 1));
  const percents = tokens.filter((t) => "code" in t && t.code === "%").length;
  let n = Math.abs(v) * 100 ** percents;

  const exp = /E[+-]?/i.exec(pattern);
  const mantissa = exp ? pattern.slice(0, exp.index) : pattern;
  const [intPattern = "", decPattern = ""] = mantissa.split(".");
  // 末尾的逗号：每个除以一千
  const scale = /,+$/.exec(intPattern)?.[0].length ?? 0;
  n /= 1000 ** scale;
  const minDecimals = (decPattern.match(/0/g) ?? []).length;
  const maxDecimals = (decPattern.match(/[0#?]/g) ?? []).length;
  const minInt = (intPattern.match(/0/g) ?? []).length;
  const thousands = /[0#?],[0#?]/.test(intPattern);
  let body: string;
  if (exp) {
    const [m, e] = n.toExponential(maxDecimals).split("e");
    const digits = (pattern.slice(exp.index + exp[0].length).match(/[0#?]/g) ?? []).length;
    const sign = Number(e) < 0 ? "-" : exp[0].includes("+") ? "+" : "";
    body = `${m}E${sign}${pad(Math.abs(Number(e)), digits)}`;
  } else {
    let fixed = n.toFixed(Math.min(maxDecimals, 20));
    if (maxDecimals > minDecimals && fixed.includes(".")) {
      const cut = fixed.length - (maxDecimals - minDecimals);
      fixed = fixed.slice(0, cut) + fixed.slice(cut).replace(/0+$/, "");
      if (fixed.endsWith(".")) fixed = fixed.slice(0, -1);
    }
    let [int = "0", dec = ""] = fixed.split(".");
    if (minInt === 0 && int === "0" && dec) int = "";
    int = int.padStart(minInt, "0");
    if (thousands) int = withThousands(int);
    body = dec ? `${int}.${dec}` : int;
  }
  return `${negative ? "-" : ""}${prefix}${body}${suffix}`;
}

// ---------------------------------------------------------------------------
// 工作簿

interface Font {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string | null;
  size: number | null;
  name: string | null;
}
interface Border {
  style: string;
  color: string | null;
}
interface Xf {
  format: string;
  font: Font | undefined;
  fill: string | null;
  borders: Partial<Record<"left" | "right" | "top" | "bottom", Border>>;
  horizontal: string | null;
  vertical: string | null;
  wrap: boolean;
}

interface Sheet {
  name: string;
  path: string;
  doc: Document;
}

interface Book {
  pkg: OfficePackage;
  main: string;
  workbook: Document;
  sheets: Sheet[];
  shared: string[];
  xfs: Xf[];
  defaultFont: Font | undefined;
  date1904: boolean;
}

function siText(si: Element | null): string {
  if (!si) return "";
  const direct = kid(si, "t");
  if (direct) return direct.textContent ?? "";
  return kids(si, "r")
    .map((r) => kid(r, "t")?.textContent ?? "")
    .join("");
}

async function loadBook(bytes: ArrayBuffer): Promise<Book> {
  const pkg = await OfficePackage.load(bytes);
  const main = await pkg.mainPart();
  const workbook = main ? await pkg.xml(main) : null;
  if (!main || !workbook) throw new Error("文件打不开：里面没有 Excel 工作簿");
  const rels = await pkg.rels(main);
  const byType = (suffix: string) => [...rels.values()].find((r) => r.type.endsWith(suffix))?.target;

  const sheets: Sheet[] = [];
  for (const s of all(workbook, "sheet")) {
    const rel = rels.get(relAttr(s, "id") ?? "");
    if (!rel || !rel.type.endsWith("/worksheet") || attr(s, "state")?.includes("idden")) continue;
    const doc = await pkg.xml(rel.target);
    if (doc) sheets.push({ name: attr(s, "name") ?? "", path: rel.target, doc });
  }

  const sst = byType("/sharedStrings");
  const shared = all(sst ? await pkg.xml(sst) : null, "si").map(siText);

  const themePath = byType("/theme");
  const scheme = all(themePath ? await pkg.xml(themePath) : null, "clrScheme")[0];
  const schemeColors = kids(scheme).map((c) => attr(kid(c, "srgbClr"), "val") ?? attr(kid(c, "sysClr"), "lastClr") ?? "000000");
  // 主题里是 深1 浅1 深2 浅2 …，单元格颜色的 theme 序号是 浅1 深1 浅2 深2 …
  const theme = schemeColors.length >= 4 ? [schemeColors[1]!, schemeColors[0]!, schemeColors[3]!, schemeColors[2]!, ...schemeColors.slice(4)] : schemeColors;

  const stylesPath = byType("/styles");
  const styles = (stylesPath ? await pkg.xml(stylesPath) : null)?.documentElement ?? null;
  const formats = new Map<number, string>(Object.entries(BUILTIN_FORMATS).map(([k, v]) => [Number(k), v]));
  for (const f of kids(kid(styles, "numFmts"), "numFmt")) formats.set(Number(attr(f, "numFmtId")), attr(f, "formatCode") ?? "");
  const on = (el: Element | null) => el !== null && attr(el, "val") !== "0" && attr(el, "val") !== "false" && attr(el, "val") !== "none";
  const fonts = kids(kid(styles, "fonts"), "font").map(
    (f): Font => ({
      bold: on(kid(f, "b")),
      italic: on(kid(f, "i")),
      underline: on(kid(f, "u")),
      strike: on(kid(f, "strike")),
      color: colorOf(kid(f, "color"), theme),
      size: numAttr(kid(f, "sz"), "val"),
      name: attr(kid(f, "name"), "val"),
    }),
  );
  const fills = kids(kid(styles, "fills"), "fill").map((f) => {
    const pattern = kid(f, "patternFill");
    return attr(pattern, "patternType") === "solid" ? colorOf(kid(pattern, "fgColor"), theme) : null;
  });
  const borders = kids(kid(styles, "borders"), "border").map((b) => {
    const out: Xf["borders"] = {};
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const el = kid(b, side) ?? (side === "left" ? kid(b, "start") : side === "right" ? kid(b, "end") : null);
      const style = attr(el, "style");
      if (style && style !== "none") out[side] = { style, color: colorOf(kid(el, "color"), theme) };
    }
    return out;
  });
  const xfs = kids(kid(styles, "cellXfs"), "xf").map((x): Xf => {
    const align = kid(x, "alignment");
    return {
      format: formats.get(Number(attr(x, "numFmtId") ?? 0)) ?? "",
      font: fonts[Number(attr(x, "fontId") ?? 0)],
      fill: fills[Number(attr(x, "fillId") ?? 0)] ?? null,
      borders: borders[Number(attr(x, "borderId") ?? 0)] ?? {},
      horizontal: attr(align, "horizontal"),
      vertical: attr(align, "vertical"),
      wrap: attr(align, "wrapText") === "1" || attr(align, "wrapText") === "true",
    };
  });
  const pr = find(workbook.documentElement, "workbookPr");
  return { pkg, main, workbook, sheets, shared, xfs, defaultFont: fonts[0], date1904: attr(pr, "date1904") === "1" || attr(pr, "date1904") === "true" };
}

// ---------------------------------------------------------------------------
// 单元格的值

type Input = { kind: "empty" } | { kind: "formula"; formula: string } | { kind: "number"; value: number } | { kind: "bool"; value: boolean } | { kind: "string"; text: string };

/** 输入的内容算成什么；dateCell：单元格是日期格式的，2024-3-1、2024/3/1 12:30 这样的输入当日期 */
function interpret(raw: string, dateCell: boolean, date1904: boolean): Input {
  if (raw === "") return { kind: "empty" };
  if (raw.startsWith("=") && raw.length > 1) return { kind: "formula", formula: raw.slice(1) };
  const t = raw.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return { kind: "number", value: Number(t) };
  if (/^(true|false)$/i.test(t)) return { kind: "bool", value: /^true$/i.test(t) };
  if (dateCell) {
    const m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
    const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
    if (m) return { kind: "number", value: dateToSerial(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)), date1904) };
    if (time) return { kind: "number", value: (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3] ?? 0)) / 86400 };
  }
  return { kind: "string", text: raw };
}

interface CellView {
  /** 显示的文字 */
  text: string;
  /** 双击修改时编辑框里的内容 */
  raw: string;
  /** n 数字（靠右）、t 文字、c 逻辑值和错误（居中）、f 没有算过的公式 */
  type: "n" | "t" | "c" | "f";
}

/** 日期格式的单元格，编辑时显示成能再输回去的写法 */
function dateRaw(v: number, date1904: boolean): string {
  const d = serialToDate(v, date1904);
  if (Number.isNaN(d.getTime()) || v < 0) return String(v);
  const time = `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds(), 2)}` : ""}`;
  if (v < 1) return time;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
  return v % 1 ? `${date} ${time}` : date;
}

function viewOfInput(input: Input, xf: Xf | undefined, date1904: boolean): CellView {
  switch (input.kind) {
    case "empty":
      return { text: "", raw: "", type: "t" };
    case "formula":
      return { text: `=${input.formula}`, raw: `=${input.formula}`, type: "f" };
    case "number": {
      const format = xf?.format ?? "";
      return { text: formatNumber(input.value, format, date1904), raw: isDateFormat(format) ? dateRaw(input.value, date1904) : String(input.value), type: "n" };
    }
    case "bool":
      return { text: input.value ? "TRUE" : "FALSE", raw: input.value ? "TRUE" : "FALSE", type: "c" };
    case "string":
      return { text: input.text, raw: input.text, type: "t" };
  }
}

function viewOfCell(c: Element, book: Book): CellView {
  const xf = book.xfs[Number(attr(c, "s") ?? 0)];
  const type = attr(c, "t") ?? "n";
  const v = kid(c, "v")?.textContent ?? null;
  const formula = kid(c, "f")?.textContent ?? "";
  let view: CellView;
  if (type === "s") view = viewOfInput({ kind: "string", text: book.shared[Number(v)] ?? "" }, xf, book.date1904);
  else if (type === "inlineStr") view = viewOfInput({ kind: "string", text: siText(kid(c, "is")) }, xf, book.date1904);
  else if (type === "str" || type === "d") view = viewOfInput({ kind: "string", text: v ?? "" }, xf, book.date1904);
  else if (type === "b") view = viewOfInput({ kind: "bool", value: v === "1" }, xf, book.date1904);
  else if (type === "e") view = { text: v ?? "", raw: v ?? "", type: "c" };
  else if (v === null || v === "" || !Number.isFinite(Number(v))) view = { text: v ?? "", raw: v ?? "", type: "t" };
  else view = viewOfInput({ kind: "number", value: Number(v) }, xf, book.date1904);
  if (formula) return v === null ? { text: `=${formula}`, raw: `=${formula}`, type: "f" } : { ...view, raw: `=${formula}` };
  return view;
}

/** 行里每个单元格的地址：没写 r 的按前一个往后排 */
function cellsOf(row: Element, rowNumber: number): { c: Element; col: number; ref: string }[] {
  let next = 1;
  return kids(row, "c").map((c) => {
    const at = parseRef(attr(c, "r") ?? "");
    const col = at?.col ?? next;
    next = col + 1;
    return { c, col, ref: `${colName(col)}${rowNumber}` };
  });
}

function rowsOf(sheet: Sheet): { row: Element; n: number }[] {
  let next = 1;
  return kids(find(sheet.doc.documentElement, "sheetData"), "row").map((row) => {
    const n = numAttr(row, "r") ?? next;
    next = n + 1;
    return { row, n };
  });
}

/**
 * 不能在这里改的单元格和原因：共享公式的主单元格、数组公式（别的单元格的公式靠它），
 * 「表格」（列表）的标题行（表格的定义里记着列名，要和标题行的文字一样）
 */
async function lockedCells(book: Book, sheet: Sheet): Promise<Map<string, string>> {
  const locked = new Map<string, string>();
  for (const { row, n } of rowsOf(sheet)) {
    for (const { c, ref } of cellsOf(row, n)) {
      const f = kid(c, "f");
      const t = attr(f, "t");
      if (t === "array") locked.set(ref, "数组公式的单元格不能在这里改");
      else if (t === "shared" && attr(f, "ref")) locked.set(ref, "别的单元格共用这个单元格的公式，不能在这里改");
    }
  }
  for (const rel of (await book.pkg.rels(sheet.path)).values()) {
    if (!rel.type.endsWith("/table")) continue;
    const table = (await book.pkg.xml(rel.target))?.documentElement ?? null;
    const range = parseRange(attr(table, "ref") ?? "");
    const headers = numAttr(table, "headerRowCount") ?? 1;
    if (!range) continue;
    for (let r = range.r1; r < range.r1 + headers; r++) for (let c = range.c1; c <= range.c2; c++) locked.set(`${colName(c)}${r}`, "表格的标题行不能在这里改");
  }
  return locked;
}

// ---------------------------------------------------------------------------
// 改动写进 XML

const WORKBOOK_ORDER = ["fileVersion", "fileSharing", "workbookPr", "workbookProtection", "bookViews", "sheets", "functionGroups", "externalReferences", "definedNames"];

async function applyEdits(book: Book, edits: Edits): Promise<boolean> {
  let changed = false;
  let formulaRemoved = false;
  const lockedBySheet = new Map<number, Map<string, string>>();
  for (const [key, segs] of Object.entries(edits)) {
    const m = /^c:(\d+):([A-Z]{1,3}\d+)$/.exec(key);
    const sheet = m ? book.sheets[Number(m[1])] : undefined;
    const at = m ? parseRef(m[2]!) : null;
    const raw = Array.isArray(segs) ? segs[0] : null;
    if (!m || !sheet || !at || typeof raw !== "string") continue;
    const index = Number(m[1]);
    if (!lockedBySheet.has(index)) lockedBySheet.set(index, await lockedCells(book, sheet));
    if (lockedBySheet.get(index)!.has(m[2]!)) continue;
    const doc = sheet.doc;
    const data = find(doc.documentElement, "sheetData");
    if (!data) continue;
    const make = (name: string) => doc.createElementNS(data.namespaceURI, data.prefix ? `${data.prefix}:${name}` : name);

    const rows = rowsOf(sheet);
    let row = rows.find((r) => r.n === at.row)?.row;
    if (!row) {
      row = make("row");
      row.setAttribute("r", String(at.row));
      data.insertBefore(row, rows.find((r) => r.n > at.row)?.row ?? null);
    }
    const cells = cellsOf(row, at.row);
    // 有的文件单元格不写地址（按顺序排），中间插新的之前先都写上
    for (const { c, ref } of cells) if (!c.hasAttribute("r")) c.setAttribute("r", ref);
    let cell = cells.find((c) => c.col === at.col)?.c;
    if (!cell) {
      cell = make("c");
      cell.setAttribute("r", m[2]!);
      row.insertBefore(cell, cells.find((c) => c.col > at.col)?.c ?? null);
    }
    const input = interpret(raw, isDateFormat(book.xfs[Number(attr(cell, "s") ?? 0)]?.format ?? ""), book.date1904);
    if (kid(cell, "f")) formulaRemoved = true;
    for (const name of ["f", "v", "is"]) kid(cell, name)?.remove();
    cell.removeAttribute("t");
    const child = (name: string, text: string) => {
      const el = make(name);
      el.textContent = text;
      cell.appendChild(el);
      return el;
    };
    if (input.kind === "formula") child("f", input.formula);
    else if (input.kind === "number") child("v", String(input.value));
    else if (input.kind === "bool") {
      cell.setAttribute("t", "b");
      child("v", input.value ? "1" : "0");
    } else if (input.kind === "string") {
      cell.setAttribute("t", "inlineStr");
      const t = make("t");
      setText(t, input.text);
      child("is", "").appendChild(t);
    }
    book.pkg.touch(sheet.path);
    changed = true;
  }
  if (!changed) return false;

  // 依赖这些单元格的公式：让 Excel 打开时全部重算
  const root = book.workbook.documentElement;
  let calc = kid(root, "calcPr");
  if (!calc) {
    calc = book.workbook.createElementNS(root.namespaceURI, root.prefix ? `${root.prefix}:calcPr` : "calcPr");
    const before = kids(root).filter((c) => WORKBOOK_ORDER.includes(c.localName)).pop();
    root.insertBefore(calc, before ? before.nextSibling : root.firstChild);
  }
  calc.setAttribute("fullCalcOnLoad", "1");
  book.pkg.touch(book.main);
  // 计算链记着哪些单元格有公式，删了公式以后对不上，Excel 会报文件有问题；整个删掉，Excel 会自己重建
  if (formulaRemoved) {
    const relsPath = `${book.main.slice(0, book.main.lastIndexOf("/") + 1)}_rels/${book.main.slice(book.main.lastIndexOf("/") + 1)}.rels`;
    const relsDoc = await book.pkg.xml(relsPath);
    for (const rel of (await book.pkg.rels(book.main)).values()) {
      if (!rel.type.endsWith("/calcChain")) continue;
      await book.pkg.remove(rel.target);
      for (const r of all(relsDoc, "Relationship")) if (r.getAttribute("Id") === rel.id) r.remove();
      book.pkg.touch(relsPath);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 渲染

const BORDER_CSS: Record<string, string> = {
  thin: "1px solid", hair: "1px dotted", dotted: "1px dotted", dashed: "1px dashed", dashDot: "1px dashed", dashDotDot: "1px dashed",
  medium: "2px solid", mediumDashed: "2px dashed", mediumDashDot: "2px dashed", mediumDashDotDot: "2px dashed", slantDashDot: "2px dashed",
  thick: "3px solid", double: "3px double",
};

function fontCss(f: Font | undefined): string {
  if (!f) return "";
  let css = "";
  if (f.bold) css += "font-weight:700;";
  if (f.italic) css += "font-style:italic;";
  if (f.underline || f.strike) css += `text-decoration:${[f.underline ? "underline" : "", f.strike ? "line-through" : ""].join(" ").trim()};`;
  if (f.color) css += `color:${f.color};`;
  if (f.size) css += `font-size:${f.size}pt;`;
  if (f.name) css += `font-family:${JSON.stringify(f.name)},sans-serif;`;
  return css;
}

function xfCss(xf: Xf): string {
  let css = fontCss(xf.font);
  if (xf.fill) css += `background:${xf.fill};`;
  for (const [side, b] of Object.entries(xf.borders)) css += `border-${side}:${BORDER_CSS[b.style] ?? "1px solid"} ${b.color ?? "#000"};`;
  if (xf.horizontal && xf.horizontal !== "general") css += `text-align:${xf.horizontal === "centerContinuous" ? "center" : xf.horizontal === "distributed" ? "justify" : xf.horizontal};`;
  if (xf.vertical) css += `vertical-align:${xf.vertical === "center" ? "middle" : xf.vertical === "top" ? "top" : "bottom"};`;
  if (xf.wrap) css += "white-space:pre-wrap;word-break:break-word;";
  return css;
}

/** 列宽（字符数）、行高（磅）换成像素 */
const colPx = (width: number) => Math.round(width * 7 + 5);
const rowPx = (pt: number) => Math.round((pt * 96) / 72);

export interface RenderedWorkbook extends RenderedDocument {
  /** 单元格改成 raw 以后显示成什么（改完马上更新那一格）；不能改时 null */
  cell(key: string, raw: string): { text: string; raw: string; type: string } | null;
  /** 单元格的位置，写给模型和用户看的 */
  label(key: string): string | null;
}

async function renderSheet(book: Book, sheet: Sheet, index: number, usedXfs: Set<number>, styleOf: Map<string, number>): Promise<string> {
  const root = sheet.doc.documentElement;
  const format = kid(root, "sheetFormatPr");
  const defaultWidth = colPx(numAttr(format, "defaultColWidth") ?? 8.43);
  const defaultHeight = rowPx(numAttr(format, "defaultRowHeight") ?? 15);
  const locked = await lockedCells(book, sheet);

  const rows = rowsOf(sheet);
  const cells = new Map<string, Element>();
  let maxRow = 0;
  let maxCol = 0;
  const heights = new Map<number, number>();
  const hiddenRows = new Set<number>();
  for (const { row, n } of rows) {
    const ht = numAttr(row, "ht");
    if (ht !== null) heights.set(n, rowPx(ht));
    if (attr(row, "hidden") === "1" || attr(row, "hidden") === "true") hiddenRows.add(n);
    for (const { c, col, ref } of cellsOf(row, n)) {
      cells.set(ref, c);
      const s = Number(attr(c, "s") ?? 0);
      if (s) styleOf.set(`c:${index}:${ref}`, s);
      if (c.firstElementChild || s) {
        maxRow = Math.max(maxRow, n);
        maxCol = Math.max(maxCol, col);
      }
    }
  }
  const merges = new Map<string, { rows: number; cols: number }>();
  const covered = new Set<string>();
  for (const mc of kids(kid(root, "mergeCells"), "mergeCell")) {
    const r = parseRange(attr(mc, "ref") ?? "");
    if (!r || r.r2 - r.r1 > 5000 || r.c2 - r.c1 > 500) continue;
    let visibleRows = 0;
    for (let y = r.r1; y <= r.r2; y++) {
      if (!hiddenRows.has(y)) visibleRows++;
      for (let x = r.c1; x <= r.c2; x++) if (y !== r.r1 || x !== r.c1) covered.add(`${colName(x)}${y}`);
    }
    merges.set(`${colName(r.c1)}${r.r1}`, { rows: Math.max(1, visibleRows), cols: r.c2 - r.c1 + 1 });
    maxRow = Math.max(maxRow, r.r2);
    maxCol = Math.max(maxCol, r.c2);
  }

  // 用到的范围外面多留一些空格子，可以往里填
  const colCount = Math.min(MAX_COLS, Math.max(maxCol + 3, 12));
  const rowCount = Math.min(MAX_ROWS, Math.floor(MAX_CELLS / colCount), Math.max(maxRow + 15, 40));
  const widths: number[] = Array.from({ length: colCount + 1 }, () => defaultWidth);
  const hiddenCols = new Set<number>();
  for (const col of kids(kid(root, "cols"), "col")) {
    const min = numAttr(col, "min") ?? 1;
    const max = Math.min(numAttr(col, "max") ?? min, colCount);
    const width = numAttr(col, "width");
    const hidden = attr(col, "hidden") === "1" || attr(col, "hidden") === "true";
    for (let c = min; c <= max; c++) {
      if (width !== null) widths[c] = colPx(width);
      if (hidden) hiddenCols.add(c);
    }
  }

  let html = `<table class="xl-grid" style="width:${46 + widths.slice(1).reduce((a, w, i) => a + (hiddenCols.has(i + 1) ? 0 : w), 0)}px"><colgroup><col style="width:46px">`;
  for (let c = 1; c <= colCount; c++) html += hiddenCols.has(c) ? '<col style="visibility:collapse">' : `<col style="width:${widths[c]}px">`;
  html += '</colgroup><thead><tr><th class="xl-corner"></th>';
  for (let c = 1; c <= colCount; c++) html += `<th>${colName(c)}</th>`;
  html += "</tr></thead><tbody>";
  for (let r = 1; r <= rowCount; r++) {
    if (hiddenRows.has(r)) continue;
    html += `<tr style="height:${heights.get(r) ?? defaultHeight}px"><th>${r}</th>`;
    for (let c = 1; c <= colCount; c++) {
      const ref = `${colName(c)}${r}`;
      if (covered.has(ref)) continue;
      const cell = cells.get(ref);
      const view = cell ? viewOfCell(cell, book) : null;
      const s = cell ? Number(attr(cell, "s") ?? 0) : 0;
      if (s && book.xfs[s]) usedXfs.add(s);
      const merge = merges.get(ref);
      const lock = locked.get(ref);
      const classes = [s && book.xfs[s] ? `s${s}` : "", view && view.type !== "t" ? view.type : ""].filter(Boolean).join(" ");
      html +=
        `<td${classes ? ` class="${classes}"` : ""}${merge ? ` rowspan="${merge.rows}" colspan="${merge.cols}"` : ""}` +
        (lock ? ` data-cell="c:${index}:${ref}" title="${escapeHtml(lock)}"` : ` data-edit="c:${index}:${ref}"`) +
        `${view && view.raw !== view.text ? ` data-raw="${escapeHtml(view.raw)}"` : ""}>${view ? escapeHtml(view.text) : ""}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  const clipped = maxRow > rowCount || maxCol > colCount;
  return (
    `<div class="xl-pane${index === 0 ? " on" : ""}" data-pane="${index}">${html}` +
    (clipped ? `<div class="xl-note">这张表用到了 ${maxRow} 行 ${maxCol} 列，这里只显示前 ${rowCount} 行 ${colCount} 列</div>` : "") +
    "</div>"
  );
}

export async function renderXlsx(bytes: ArrayBuffer, edits: Edits): Promise<RenderedWorkbook> {
  const book = await loadBook(bytes);
  await applyEdits(book, edits);
  if (!book.sheets.length) throw new Error("这个工作簿里没有能显示的工作表");
  const usedXfs = new Set<number>();
  const styleOf = new Map<string, number>();
  let panes = "";
  for (const [i, sheet] of book.sheets.entries()) panes += await renderSheet(book, sheet, i, usedXfs, styleOf);
  const tabs = book.sheets.map((s, i) => `<button class="xl-tab${i === 0 ? " on" : ""}" data-tab="${i}">${escapeHtml(s.name)}</button>`).join("");
  const css = `${XLSX_CSS}\n.xl-grid td{${fontCss(book.defaultFont)}}\n${[...usedXfs].map((s) => `.xl-grid td.s${s}{${xfCss(book.xfs[s]!)}}`).join("\n")}`;
  const parseKey = (key: string) => {
    const m = /^c:(\d+):([A-Z]{1,3}\d+)$/.exec(key);
    return m && book.sheets[Number(m[1])] ? { sheet: book.sheets[Number(m[1])]!, ref: m[2]! } : null;
  };
  return {
    body: `<div class="xl"><div class="xl-panes">${panes}</div><div class="xl-tabs">${tabs}</div></div>`,
    css,
    cell(key, raw) {
      if (!parseKey(key)) return null;
      const xf = book.xfs[styleOf.get(key) ?? 0];
      const view = viewOfInput(interpret(raw, isDateFormat(xf?.format ?? ""), book.date1904), xf, book.date1904);
      return { text: view.text, raw: view.raw, type: view.type };
    },
    label(key) {
      const at = parseKey(key);
      return at ? `工作表「${at.sheet.name}」的单元格 ${at.ref}` : null;
    },
  };
}

export async function saveXlsx(bytes: ArrayBuffer, edits: Edits): Promise<Uint8Array<ArrayBuffer> | null> {
  const book = await loadBook(bytes);
  return (await applyEdits(book, edits)) ? book.pkg.bytes() : null;
}

export const XLSX_PICK = "td[data-edit], td[data-cell]";

const XLSX_CSS = `
html, body { height: 100%; }
body { overflow: hidden; }
.xl { display: flex; flex-direction: column; height: 100%; }
.xl-panes { flex: 1; min-height: 0; position: relative; background: #fff; }
.xl-pane { position: absolute; inset: 0; overflow: auto; display: none; }
.xl-pane.on { display: block; }
.xl-grid { border-collapse: separate; border-spacing: 0; table-layout: fixed; font: 11pt Calibri, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; color: #000; }
.xl-grid td, .xl-grid th { box-sizing: border-box; border-right: 1px solid #e2e2e2; border-bottom: 1px solid #e2e2e2; padding: 0 3px; overflow: hidden; }
.xl-grid td { white-space: pre; vertical-align: bottom; background: #fff; }
.xl-grid td.n { text-align: right; }
.xl-grid td.c { text-align: center; }
.xl-grid td.f { color: #6b7280; font-style: italic; }
.xl-grid th { position: sticky; z-index: 1; background: #f3f4f6; color: #555; font: 12px system-ui, sans-serif; text-align: center; user-select: none; }
.xl-grid thead th { top: 0; height: 22px; }
.xl-grid tbody th { left: 0; }
.xl-grid th.xl-corner { left: 0; z-index: 2; }
.xl-grid td[contenteditable] { overflow: visible; position: relative; z-index: 1; white-space: pre; text-align: left; }
.xl-note { position: sticky; left: 0; padding: 8px 12px; font: 12px system-ui, sans-serif; color: #6b7280; }
.xl-tabs { display: flex; gap: 2px; padding: 4px 8px; overflow-x: auto; background: var(--chrome); border-top: 1px solid var(--line); flex: none; }
.xl-tab { flex: none; padding: 4px 12px; border: none; border-radius: 6px; background: transparent; color: var(--muted); font: 12.5px system-ui, sans-serif; cursor: pointer; }
.xl-tab:hover { background: var(--hover); }
.xl-tab.on { background: var(--hover); color: var(--fg); font-weight: 600; }
`;
