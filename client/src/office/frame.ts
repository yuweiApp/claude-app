import { PAGE_PICKER_SCRIPT } from "@gateway/shared/page-picker";
import type { RenderedDocument } from "./docx";

/**
 * Office 文档渲染出来的 HTML 放进 iframe 的 srcdoc：sandbox 只给 allow-scripts（单独的源，碰不到界面的存储和接口），
 * CSP 不许访问网络（图片、字体都是 data: 地址），所以文档里带着什么都跑不出这个框。
 * 末尾接两段脚本：下面的 OFFICE_FRAME_SCRIPT（改内容、切换工作表、按面板宽度缩放）和网页预览共用的标注脚本（shared/page-picker.ts）。
 *
 * 和界面之间的消息（在标注脚本那几种之外）：
 * 界面 → 文档（source: "claude-app"）
 * - { type: "office-cell", key, text, raw, cellType }：单元格改完后显示成什么（数字按格式、日期按日期）
 * - { type: "office-theme", dark }：界面换了深浅色
 * 文档 → 界面（source: "claude-app-page"）
 * - { type: "office-edit", key, segs }：改了一个元素的文字。segs 是各段文字改成什么（见 pkg.ts 的 Edits），这次没碰到的段是 null
 * - { type: "office-save" }：按了 Ctrl/⌘+S
 *
 * 改内容：双击带 data-edit 的元素（段落、单元格）进入编辑（contenteditable="plaintext-only"），
 * 回车、Tab、点别处是改完，Esc 是不改了。元素里的文字段是 <span data-seg="i">，改完按段收集文字：
 * 打在段外面的字算进前一段（开头的算进第一段）；data-noedit 的（项目符号、制表符、页码）不算。
 * 没有文字段的元素（单元格、空段落，data-segs 是 0 或者没有）整个算一段；单元格有 data-raw 时编辑的是它（公式、没按格式显示的值）
 */
const OFFICE_FRAME_SCRIPT = String.raw`(function () {
  if (window.parent === window) return;
  var me = document.currentScript;
  if (me && me.parentNode) me.parentNode.removeChild(me);
  var root = document.documentElement;
  var editing = null;
  var picking = false;

  function post(msg) {
    msg.source = "claude-app-page";
    window.parent.postMessage(msg, "*");
  }

  function fit() {
    var list = document.querySelectorAll("[data-fit]");
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var max = +el.getAttribute("data-fit-max") || 1;
      var width = +el.getAttribute("data-fit") || 0;
      if (!width) {
        el.style.zoom = "";
        for (var j = 0; j < el.children.length; j++) width = Math.max(width, el.children[j].offsetWidth);
      }
      if (!width) continue;
      var room = root.clientWidth - (+el.getAttribute("data-fit-margin") || 0);
      el.style.zoom = String(Math.max(0.2, Math.min(max, room / width)));
    }
  }

  function owner(node, el) {
    // which text segment a text node belongs to: -1 none, -2 not editable
    var seg = -1;
    for (var p = node.parentNode; p && p !== el; p = p.parentNode) {
      if (p.nodeType !== 1) continue;
      if (p.hasAttribute("data-noedit") || p.hasAttribute("data-edit")) return -2;
      if (seg < 0 && p.hasAttribute("data-seg")) seg = +p.getAttribute("data-seg");
    }
    return seg;
  }
  function collect(el, present) {
    var count = +el.getAttribute("data-segs") || 0;
    var out = [];
    var i;
    for (i = 0; i < count; i++) out.push(null);
    for (i = 0; i < present.length; i++) out[present[i]] = "";
    var whole = "";
    var lead = "";
    var cur = -1;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var seg = owner(node, el);
      if (seg === -2) continue;
      var text = node.nodeValue.replace(/[\r\n]+/g, " ");
      whole += text;
      if (seg >= 0 && seg < count) cur = seg;
      if (cur < 0) lead += text;
      else out[cur] = (out[cur] || "") + text;
    }
    if (!count) return [whole];
    if (lead) {
      var first = present.length ? present[0] : 0;
      out[first] = lead + (out[first] || "");
    }
    return out;
  }

  function start(el) {
    finish(true);
    var present = [];
    var segs = el.querySelectorAll("[data-seg]");
    for (var i = 0; i < segs.length; i++) {
      var n = +segs[i].getAttribute("data-seg");
      if (segs[i].parentNode.closest("[data-edit]") === el && present.indexOf(n) < 0) present.push(n);
    }
    var inner = el.querySelectorAll("[data-edit]");
    for (var k = 0; k < inner.length; k++) inner[k].setAttribute("contenteditable", "false");
    var raw = el.getAttribute("data-raw");
    editing = { el: el, html: el.innerHTML, present: present, before: null };
    if (raw !== null) el.textContent = raw;
    editing.before = collect(el, present);
    el.setAttribute("contenteditable", "plaintext-only");
    if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
    el.focus();
    var sel = window.getSelection();
    if (sel && (raw !== null || !sel.rangeCount || !el.contains(sel.anchorNode))) {
      var range = document.createRange();
      range.selectNodeContents(el);
      if (raw === null) range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  function finish(commit) {
    var e = editing;
    if (!e) return;
    editing = null;
    var el = e.el;
    var after = commit ? collect(el, e.present) : null;
    el.removeAttribute("contenteditable");
    var inner = el.querySelectorAll('[data-edit][contenteditable="false"]');
    for (var k = 0; k < inner.length; k++) inner[k].removeAttribute("contenteditable");
    if (!after || JSON.stringify(after) === JSON.stringify(e.before)) {
      el.innerHTML = e.html;
      return;
    }
    if (after.length === 1 && !(+el.getAttribute("data-segs") > 0)) el.textContent = after[0];
    post({ type: "office-edit", key: el.getAttribute("data-edit"), segs: after });
  }

  document.addEventListener("dblclick", function (e) {
    if (picking) return;
    var t = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentNode;
    var el = t && t.closest ? t.closest("[data-edit]") : null;
    if (!el || (editing && editing.el === el)) return;
    e.preventDefault();
    start(el);
  });
  document.addEventListener(
    "keydown",
    function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        finish(true);
        post({ type: "office-save" });
        return;
      }
      if (!editing || e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        finish(true);
      }
    },
    true
  );
  document.addEventListener("focusout", function (e) {
    if (editing && e.target === editing.el) finish(true);
  });
  document.addEventListener("paste", function (e) {
    if (!editing) return;
    e.preventDefault();
    var text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
    document.execCommand("insertText", false, text.replace(/[\r\n]+/g, " "));
  });
  document.addEventListener("drop", function (e) {
    if (editing) e.preventDefault();
  });
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var tab = t.closest("[data-tab]");
    if (tab) {
      finish(true);
      var id = tab.getAttribute("data-tab");
      var all = document.querySelectorAll("[data-tab], [data-pane]");
      for (var i = 0; i < all.length; i++) {
        var on = (all[i].getAttribute("data-tab") || all[i].getAttribute("data-pane")) === id;
        all[i].classList.toggle("on", on);
      }
      return;
    }
    // links inside the document must not navigate this frame away
    var a = t.closest("a[href]");
    if (a && (a.getAttribute("href") || "").charAt(0) !== "#") e.preventDefault();
  });

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== window.parent || !d || d.source !== "claude-app") return;
    if (d.type === "state") {
      picking = !!d.annotating;
      root.classList.toggle("picking", picking);
      if (picking) finish(true);
    } else if (d.type === "office-cell" && typeof d.key === "string") {
      var cells = document.querySelectorAll("[data-edit]");
      for (var i = 0; i < cells.length; i++) {
        var el = cells[i];
        if (el.getAttribute("data-edit") !== d.key || (editing && editing.el === el)) continue;
        el.textContent = String(d.text);
        if (d.raw !== d.text) el.setAttribute("data-raw", String(d.raw));
        else el.removeAttribute("data-raw");
        el.classList.remove("n", "c", "f");
        if (d.cellType === "n" || d.cellType === "c" || d.cellType === "f") el.classList.add(d.cellType);
      }
    } else if (d.type === "office-theme") {
      root.classList.toggle("dark", !!d.dark);
      root.style.colorScheme = d.dark ? "dark" : "light";
    }
  });
  window.addEventListener("resize", fit);
  fit();
})();`;

const BASE_CSS = `
:root { --fg: #1f1e1c; --muted: #77736b; --line: rgba(0, 0, 0, .12); --chrome: rgba(0, 0, 0, .03); --hover: rgba(0, 0, 0, .07); }
:root.dark { --fg: #ecebe7; --muted: #9a968d; --line: rgba(255, 255, 255, .12); --chrome: rgba(255, 255, 255, .04); --hover: rgba(255, 255, 255, .1); }
html, body { margin: 0; background: transparent; }
body { font-family: system-ui, sans-serif; }
[data-edit] { cursor: text; }
[data-edit]:hover { outline: 1px dashed rgba(37, 99, 235, .55); outline-offset: 1px; }
[data-edit][contenteditable] { outline: 2px solid #2563eb; outline-offset: 1px; background-color: rgba(37, 99, 235, .06); }
.picking [data-edit]:hover { outline: none; }
`;

/** iframe 的 srcdoc。pick：标注时能选的元素（CSS 选择器） */
export function officeFrameHtml(doc: RenderedDocument, pick: string, dark: boolean): string {
  const css = (BASE_CSS + doc.css).replace(/<\/style/gi, "<\\/style");
  return (
    `<!doctype html><html class="${dark ? "dark" : ""}" style="color-scheme:${dark ? "dark" : "light"}" data-pick-snap="${pick.replaceAll('"', "&quot;")}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">` +
    `<style>${css}</style></head><body>${doc.body}` +
    `<script>${OFFICE_FRAME_SCRIPT}</script><script>${PAGE_PICKER_SCRIPT}</script></body></html>`
  );
}
