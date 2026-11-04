import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
/** 拖到最小宽度后再往左这么多就收起，免得刚好拖到最小时误收 */
const COLLAPSE_MARGIN = 30;

const clamp = (width: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));

interface Props {
  width: number;
  /** 拖动过程中的宽度 */
  onResize: (width: number) => void;
  /** 拖完、键盘调整、双击恢复后的宽度，要记住的 */
  onCommit: (width: number) => void;
  /** 拖过最小宽度时收起侧边栏 */
  onCollapse: () => void;
}

/** 侧边栏和对话区之间的分割线：拖动调整侧边栏宽度，拖过最小宽度时收起，双击恢复默认，也可以用左右方向键 */
export function SidebarResizer({ width, onResize, onCommit, onCollapse }: Props) {
  const drag = useRef<{ x: number; width: number; latest: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width, latest: width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = drag.current.width + e.clientX - drag.current.x;
    if (next < MIN_WIDTH - COLLAPSE_MARGIN) {
      // 宽度回到拖动之前，下次展开还是原来的样子
      onResize(drag.current.width);
      drag.current = null;
      onCollapse();
      return;
    }
    drag.current.latest = clamp(next);
    onResize(drag.current.latest);
  };
  const onPointerUp = () => {
    if (drag.current) onCommit(drag.current.latest);
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onCommit(clamp(width + (e.key === "ArrowLeft" ? -20 : 20)));
  };

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onCommit(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={onKeyDown}
    />
  );
}
