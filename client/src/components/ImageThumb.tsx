import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

const MIN_SCALE = 0.2;
const MAX_SCALE = 10;
const STEP = 1.25;
const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** scale=1 表示适应窗口；x、y 是图片中心相对窗口中心的平移 */
interface View {
  scale: number;
  x: number;
  y: number;
}
const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * 看大图：铺满窗口，挂在 body 上，不受所在位置的滚动、裁剪影响（同 codex-app-server 的 ImageViewer，去掉了编辑）。
 * 滚轮以鼠标处为中心缩放，双指捏合缩放，放大后拖动平移，双击在适应窗口和 2 倍之间切换；
 * 键盘 + / - 缩放、0 复位、Esc 关闭；点图片以外的地方关闭（拖动、捏合后松手不算）
 */
export function ImageViewer({ src, alt = "图片", onClose }: { src: string; alt?: string; onClose: () => void }) {
  const [view, setView] = useState<View>(FIT);
  const [dragging, setDragging] = useState(false);
  /** 适应窗口时的显示宽度 / 原图宽度，用来显示相对原图的百分比 */
  const [fitRatio, setFitRatio] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** 按下的指针：一个是拖动，两个是捏合 */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, pinch: null as number | null, startX: 0, startY: 0 });

  /** 以窗口里的 (px, py) 为中心缩放到 next，这个点下面的内容保持不动；不大于适应窗口时居中 */
  const zoomAt = (next: number, px?: number, py?: number) => {
    setView((v) => {
      const scale = Math.abs(next - 1) < 0.02 ? 1 : clamp(next);
      if (scale <= 1) return { scale, x: 0, y: 0 };
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const ax = (px ?? cx) - cx;
      const ay = (py ?? cy) - cy;
      const k = scale / v.scale;
      return { scale, x: ax - (ax - v.x) * k, y: ay - (ay - v.y) * k };
    });
  };

  // React 的 onWheel 是被动监听，不能 preventDefault，直接挂在舞台上
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(viewRef.current.scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") closeRef.current();
      else if (e.key === "+" || e.key === "=") zoomAt(viewRef.current.scale * STEP);
      else if (e.key === "-" || e.key === "_") zoomAt(viewRef.current.scale / STEP);
      else if (e.key === "0") setView(FIT);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const pinchDistance = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { moved: false, pinch: null, startX: e.clientX, startY: e.clientY };
    if (pointers.current.size === 2) gesture.current.pinch = pinchDistance();
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!dx && !dy) return;
    // 真的拖起来才捕获指针（移出图片也能继续拖）；普通点击不捕获，否则点图片会被当成点了外面
    const g = gesture.current;
    if (!g.moved && (pointers.current.size > 1 || Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 3)) {
      g.moved = true;
      const el = e.currentTarget as HTMLElement;
      for (const id of pointers.current.keys()) if (!el.hasPointerCapture(id)) el.setPointerCapture(id);
    }
    if (pointers.current.size >= 2) {
      // 捏合：按两指距离的变化缩放，以两指中点为中心
      const dist = pinchDistance();
      const last = g.pinch;
      if (dist && last) {
        const [a, b] = [...pointers.current.values()];
        zoomAt((viewRef.current.scale * dist) / last, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
      }
      g.pinch = dist;
      return;
    }
    // 拖动：只在放大后平移
    if (viewRef.current.scale > 1) {
      setDragging(true);
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.pinch = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  const onClick = (e: ReactMouseEvent) => {
    if (gesture.current.moved) return;
    const target = e.target as HTMLElement;
    if (target === imgRef.current || target.closest(".image-viewer-tools")) return;
    onClose();
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (e.target !== imgRef.current) return;
    if (viewRef.current.scale === 1) zoomAt(2, e.clientX, e.clientY);
    else setView(FIT);
  };

  const percent = Math.round(view.scale * (fitRatio ?? 1) * 100);

  return createPortal(
    <div
      ref={stageRef}
      className="image-viewer"
      role="dialog"
      aria-label={alt}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className={`image-viewer-frame${dragging ? " dragging" : ""}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          className={`${view.scale > 1 ? "zoomed" : ""}${dragging ? " dragging" : ""}`}
          onLoad={(e) => {
            const el = e.currentTarget;
            if (el.naturalWidth && el.clientWidth) setFitRatio(el.clientWidth / el.naturalWidth);
          }}
        />
      </div>
      <div className="image-viewer-tools">
        <button title="缩小（-）" aria-label="缩小" disabled={view.scale <= MIN_SCALE} onClick={() => zoomAt(view.scale / STEP)}>
          −
        </button>
        <button className="image-viewer-percent" title="适应窗口（0）" onClick={() => setView(FIT)}>
          {percent}%
        </button>
        <button title="放大（+）" aria-label="放大" disabled={view.scale >= MAX_SCALE} onClick={() => zoomAt(view.scale * STEP)}>
          ＋
        </button>
        <span className="image-viewer-sep" />
        <button title="关闭（Esc）" aria-label="关闭" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
          </svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** 图片缩略图，点开看大图 */
export function ImageThumb({ src, alt = "图片", className = "image-thumb" }: { src: string; alt?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} title="查看大图">
        <img src={src} alt={alt} loading="lazy" />
      </button>
      {open && <ImageViewer src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
