/**
 * 正在拖动的分割线（侧边栏、右侧面板的）：拖动期间内置浏览器的原生视图换成快照（见 BrowserTab.tsx）。
 * 视图由外壳按界面报的位置叠放，总比界面晚几帧，拖动时跟不上分割线
 */
let dragging = 0;

/** 开始拖动，返回结束拖动的函数（多次调用只算一次） */
export function beginLayoutDrag(): () => void {
  dragging++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    dragging--;
  };
}

export function isLayoutDragging(): boolean {
  return dragging > 0;
}
