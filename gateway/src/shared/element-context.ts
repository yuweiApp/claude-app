// 网关和网页都会 import 这个文件（网页经 vite 的 @gateway 别名），所以这里不能引用 Node 的模块

/**
 * 在网页里取元素信息的函数（this 是元素），返回 SelectedElement。
 * 写成字符串：内置浏览器经 CDP 的 Runtime.callFunctionOn 执行，HTML 预览的脚本（page-picker.ts）原样嵌进去；
 * tsx、vite 编译函数时可能插入辅助调用，拿到网页里会报错。只用 ES5，不用模板字符串
 */
export const ELEMENT_CONTEXT_FUNCTION = String.raw`function () {
  var el = this;
  var ATTRS = ["data-testid", "data-test-id", "aria-label", "name", "type", "href", "role", "placeholder", "title", "alt", "onclick", "value", "src"];
  var STYLES = ["display", "position", "flex-direction", "justify-content", "align-items", "width", "height", "padding", "margin", "background-color", "color", "font-size", "font-weight", "border-radius", "border-width", "border-style", "border-color"];
  var attributes = {};
  ATTRS.forEach(function (name) {
    var v = el.getAttribute(name);
    if (v) attributes[name] = v;
  });
  var computedStyles = {};
  try {
    var cs = getComputedStyle(el);
    STYLES.forEach(function (name) {
      var v = cs.getPropertyValue(name);
      if (v) computedStyles[name] = v;
    });
  } catch (e) {}
  var cls = el.getAttribute("class") || "";
  var text = typeof el.innerText === "string" ? el.innerText : el.textContent || "";
  var parts = [];
  var p = el.parentElement;
  for (var i = 0; i < 4 && p && p !== document.body && p !== document.documentElement; i++) {
    var s = p.tagName.toLowerCase();
    if (p.id) s += "#" + p.id;
    else if (p.getAttribute("class")) s += "." + p.getAttribute("class").split(" ")[0];
    parts.unshift(s);
    p = p.parentElement;
  }
  var outer = el.outerHTML || "";
  if (outer.length > 2000) outer = outer.substring(0, 2000) + "...";
  var sibling = "";
  if (el.parentElement) {
    sibling = Array.prototype.map
      .call(el.parentElement.children, function (child) {
        if (child === el) return "<!-- SELECTED -->" + child.outerHTML;
        var tag = child.tagName.toLowerCase();
        var raw = child.getAttribute("class") || "";
        var c = raw ? ' class="' + raw.split(" ").slice(0, 3).join(" ") + '"' : "";
        var id = child.id ? ' id="' + child.id + '"' : "";
        return "<" + tag + id + c + " />";
      })
      .join("\n");
    if (sibling.length > 2000) sibling = sibling.substring(0, 2000) + "...";
  }
  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: cls ? cls.split(/\s+/).filter(Boolean) : [],
    attributes: attributes,
    computedStyles: computedStyles,
    innerText: text.substring(0, 200) || undefined,
    parentPath: parts.join(" > ") || undefined,
    outerHTML: outer || undefined,
    siblingHTML: sibling || undefined
  };
}`;
