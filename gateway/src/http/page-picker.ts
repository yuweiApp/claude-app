import { ELEMENT_CONTEXT_FUNCTION } from "../shared/element-context.js";

/**
 * 网页预览（/files/page/）给 HTML 末尾加上的脚本：右侧面板在网页上点选元素写标注用。
 * 网页在沙箱里（单独的源），界面碰不到里面的 DOM，只能由网页里的脚本和界面互相 postMessage：
 *
 * 界面 → 网页（source: "claude-app"）
 * - { type: "state", annotating, marks: [{ id, n, selector }] }：开关标注模式；已有标注的编号贴在对应元素上
 * - { type: "show-pick", pickId }：界面截完图了，给这次选中的元素画上框（截图里不要框；已经又选了别的就不动）
 * - { type: "clear-pick", pickId }：写标注的框关了，去掉这次选中的元素的框（已经又选了别的就不动）
 *
 * 网页 → 界面（source: "claude-app-page"）
 * - { type: "ready", path }：加载好了（每次加载、跳到别的页面都发），path 是网页地址的路径
 * - { type: "pick", pickId, selector, element, rect }：标注模式下点了一个元素；element 是 shared/element-context.ts 的函数取的元素信息
 * - { type: "picked-rect", rect }：选中的元素滚动后的新位置
 * - { type: "edit", id, rect }：点了已有标注的编号
 * - { type: "escape" }：标注模式下按了 Esc
 *
 * 位置都是网页视口里的 CSS 像素。不在 iframe 里（直接打开预览地址）时什么都不做。
 * 写成字符串（不是函数再 toString）：tsx 编译时会往函数里加辅助调用，拿到网页里会报错。
 * 只用 ASCII，按原始字节接在网页后面，不管网页是什么编码
 */
export const PAGE_PICKER_SCRIPT = String.raw`(function () {
  if (window.parent === window) return;
  var elementContext = ${ELEMENT_CONTEXT_FUNCTION};
  var me = document.currentScript;
  if (me && me.parentNode) me.parentNode.removeChild(me);
  var annotating = false;
  var marks = [];
  var hoverEl = null;
  var pickedEl = null;
  var pending = null;
  var pickId = 0;
  var lastPickedRect = "";
  var host = null;
  var shadow = null;
  var hoverBox = null;
  var pickBox = null;
  var badgeLayer = null;
  var cursorStyle = null;
  var frame = 0;

  function post(msg) {
    msg.source = "claude-app-page";
    window.parent.postMessage(msg, "*");
  }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  function ensureHost() {
    if (host && host.isConnected) return;
    if (!host) {
      host = document.createElement("claude-app-overlay");
      host.setAttribute("style", "all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none");
      shadow = host.attachShadow({ mode: "closed" });
      var style = document.createElement("style");
      style.textContent =
        ".box{position:fixed;box-sizing:border-box;pointer-events:none;border-radius:3px;display:none}" +
        ".hover{border:2px solid #3b82f6;background:rgba(59,130,246,.08)}" +
        ".picked{border:2px solid #2563eb;background:rgba(37,99,235,.12)}" +
        ".badge{position:fixed;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border:none;border-radius:10px;" +
        "background:#2563eb;color:#fff;font:600 12px/20px system-ui,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;" +
        "box-shadow:0 1px 3px rgba(0,0,0,.3)}";
      shadow.appendChild(style);
      hoverBox = document.createElement("div");
      hoverBox.className = "box hover";
      pickBox = document.createElement("div");
      pickBox.className = "box picked";
      badgeLayer = document.createElement("div");
      shadow.appendChild(hoverBox);
      shadow.appendChild(pickBox);
      shadow.appendChild(badgeLayer);
    }
    document.documentElement.appendChild(host);
  }
  function place(box, el) {
    if (!el || !el.isConnected) {
      box.style.display = "none";
      return null;
    }
    var r = rectOf(el);
    box.style.display = "block";
    box.style.left = r.x + "px";
    box.style.top = r.y + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    return r;
  }
  function find(selector) {
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }
  function layout() {
    frame = 0;
    if (!host) return;
    ensureHost();
    place(hoverBox, annotating ? hoverEl : null);
    var pr = place(pickBox, pickedEl);
    if (pr) {
      var key = [pr.x, pr.y, pr.width, pr.height].map(Math.round).join(",");
      if (key !== lastPickedRect) {
        lastPickedRect = key;
        post({ type: "picked-rect", rect: pr });
      }
    }
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    for (var i = 0; i < badgeLayer.children.length; i++) {
      var b = badgeLayer.children[i];
      var el = find(b.getAttribute("data-selector"));
      if (!el) {
        b.style.display = "none";
        continue;
      }
      var r = el.getBoundingClientRect();
      var x = Math.min(Math.max(r.right - 10, 2), vw - 22);
      var y = Math.min(Math.max(r.top - 10, 2), vh - 22);
      var off = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
      b.style.display = off ? "none" : "block";
      b.style.left = x + "px";
      b.style.top = y + "px";
    }
    if (annotating || pickedEl || marks.length) frame = requestAnimationFrame(layout);
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(layout);
  }
  function renderBadges() {
    ensureHost();
    while (badgeLayer.firstChild) badgeLayer.removeChild(badgeLayer.firstChild);
    marks.forEach(function (m) {
      var b = document.createElement("button");
      b.className = "badge";
      b.textContent = String(m.n);
      b.setAttribute("data-selector", m.selector);
      b.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        post({ type: "edit", id: m.id, rect: rectOf(b) });
      });
      badgeLayer.appendChild(b);
    });
  }
  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
  function uniqueId(el) {
    if (!el.id) return null;
    var sel = "#" + cssEscape(el.id);
    return document.querySelectorAll(sel).length === 1 ? sel : null;
  }
  function selectorOf(el) {
    var parts = [];
    while (el && el.nodeType === 1) {
      var id = uniqueId(el);
      if (id) {
        parts.unshift(id);
        break;
      }
      var tag = el.tagName.toLowerCase();
      if (tag === "html" || tag === "body") {
        parts.unshift(tag);
        break;
      }
      var parent = el.parentElement;
      var part = tag;
      if (parent) {
        var same = 0;
        var index = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var c = parent.children[i];
          if (c.tagName === el.tagName) {
            same++;
            if (c === el) index = same;
          }
        }
        if (same > 1) part += ":nth-of-type(" + index + ")";
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(" > ");
  }
  function ours(e) {
    return e.target === host;
  }
  function onMove(e) {
    if (!annotating || ours(e)) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === document.documentElement) return;
    hoverEl = el;
    schedule();
  }
  function block(e) {
    if (!annotating || ours(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  function onClick(e) {
    if (!annotating || ours(e)) return;
    block(e);
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === document.documentElement) return;
    pickId++;
    pending = el;
    pickedEl = null;
    hoverEl = null;
    lastPickedRect = "";
    // the UI takes a screenshot first: hide the hover box now, draw the picked box on show-pick
    if (hoverBox) place(hoverBox, null);
    if (pickBox) place(pickBox, null);
    var element = null;
    try {
      element = elementContext.call(el);
    } catch (err) {}
    post({ type: "pick", pickId: pickId, selector: selectorOf(el), element: element, rect: rectOf(el) });
  }
  ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu", "submit"].forEach(function (t) {
    window.addEventListener(t, block, true);
  });
  window.addEventListener("click", onClick, true);
  window.addEventListener("mousemove", onMove, true);
  document.documentElement.addEventListener("mouseleave", function () {
    hoverEl = null;
    schedule();
  });
  window.addEventListener(
    "keydown",
    function (e) {
      if (annotating && e.key === "Escape") post({ type: "escape" });
    },
    true,
  );
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== window.parent || !d || d.source !== "claude-app") return;
    if (d.type === "state") {
      annotating = !!d.annotating;
      marks = Array.isArray(d.marks) ? d.marks : [];
      if (!annotating) hoverEl = null;
      if (annotating && !cursorStyle) {
        cursorStyle = document.createElement("style");
        cursorStyle.textContent = "*{cursor:crosshair!important}";
        document.documentElement.appendChild(cursorStyle);
      } else if (!annotating && cursorStyle) {
        cursorStyle.remove();
        cursorStyle = null;
      }
      renderBadges();
      schedule();
    } else if (d.type === "show-pick" && d.pickId === pickId) {
      pickedEl = pending;
      schedule();
    } else if (d.type === "clear-pick" && d.pickId === pickId) {
      pickedEl = null;
      pending = null;
      schedule();
    }
  });
  post({ type: "ready", path: location.pathname });
})();`;
