/**
 * 查找结果定位到消息后，把消息里匹配到的文字标出来：用 CSS Custom Highlight API（::highlight(session-search)），
 * 不改 DOM，React 重新渲染也不受影响。浏览器不支持时不标，只有消息外框闪一下
 */
const NAME = "session-search";

/** 在这些元素的文字里找 query（不分大小写，只找单个文字节点里的），返回各处的 Range，按文档顺序 */
export function findMatches(roots: HTMLElement[], query: string): Range[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue ?? "").toLowerCase();
      for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + needle.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

type HighlightRegistry = { set: (name: string, highlight: unknown) => void; delete: (name: string) => void };

/** 标出这些 Range（替换掉之前标的）；返回清除的函数 */
export function showHighlight(ranges: Range[]): () => void {
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Ctor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !Ctor || !ranges.length) return () => {};
  const highlight = new Ctor(...ranges);
  registry.set(NAME, highlight);
  return () => registry.delete(NAME);
}

/** 消息外框闪一下（.search-flash 的动画放完就去掉） */
export function flash(el: HTMLElement): void {
  el.classList.remove("search-flash");
  // 重新触发动画
  void el.offsetWidth;
  el.classList.add("search-flash");
  el.addEventListener("animationend", () => el.classList.remove("search-flash"), { once: true });
}
