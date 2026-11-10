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

/** 用 canvas 画成 PNG：剪贴板只认 PNG；SVG 没有固定像素，按 2 倍画，放大看也清楚 */
async function toPng(src: string, svg: boolean): Promise<Blob> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = svg ? 2 : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片生成失败"))), "image/png"));
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/avif": "avif" };

/** 下载：位图原样保存，SVG 转成 PNG */
async function downloadImage(src: string, alt: string) {
  const blob = await fetch(src).then((r) => r.blob());
  const isSvg = blob.type.startsWith("image/svg");
  const out = isSvg || !EXT[blob.type] ? await toPng(src, isSvg) : blob;
  const name = alt.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || "image";
  const url = URL.createObjectURL(out);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.${EXT[out.type] ?? "png"}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copyImage(src: string) {
  const blob = await fetch(src).then((r) => r.blob());
  const png = blob.type === "image/png" ? blob : await toPng(src, blob.type.startsWith("image/svg"));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

const ICON = { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/**
 * 看大图：铺满窗口，挂在 body 上，不受所在位置的滚动、裁剪影响（同 codex-app-server 的 ImageViewer，去掉了编辑）。
 * 滚轮以鼠标处为中心缩放，双指捏合缩放，放大后拖动平移，双击在适应窗口和 2 倍之间切换；
 * 键盘 + / - 缩放、0 复位、Esc 关闭，Ctrl/⌘+C 复制、Ctrl/⌘+S 下载；点图片以外的地方关闭（拖动、捏合后松手不算）
 */
export function ImageViewer({ src, alt = "图片", onClose }: { src: string; alt?: string; onClose: () => void }) {
  const [view, setView] = useState<View>(FIT);
  /** 复制、下载的结果，按钮上短暂显示勾或叉 */
  const [copyState, setCopyState] = useState<"idle" | "done" | "error">("idle");
  const [saveState, setSaveState] = useState<"idle" | "error">("idle");
  useEffect(() => {
    if (copyState === "idle" && saveState === "idle") return;
    const t = setTimeout(() => (setCopyState("idle"), setSaveState("idle")), 1500);
    return () => clearTimeout(t);
  }, [copyState, saveState]);
  const copy = () => copyImage(src).then(() => setCopyState("done"), () => setCopyState("error"));
  const save = () => downloadImage(src, alt).catch(() => setSaveState("error"));
  const actionsRef = useRef({ copy, save });
  actionsRef.current = { copy, save };
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
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const key = e.key.toLowerCase();
        // 选中了文字时 Ctrl+C 照常复制文字
        if (key === "c" && !window.getSelection()?.toString()) void actionsRef.current.copy();
        else if (key === "s") void actionsRef.current.save();
        else return;
        e.preventDefault();
        return;
      }
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
        <button
          title={copyState === "done" ? "已复制" : copyState === "error" ? "复制失败" : "复制图片（Ctrl/⌘+C）"}
          aria-label="复制图片"
          onClick={() => void copy()}
        >
          {copyState === "done" ? (
            <svg {...ICON}>
              <path d="M3 8.5l3 3 7-7" />
            </svg>
          ) : copyState === "error" ? (
            <svg {...ICON}>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          ) : (
            <svg {...ICON}>
              <path d="M5.5 5.5V3a1 1 0 0 1 1-1H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-2.5M3 5.5h6.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z" />
            </svg>
          )}
        </button>
        <button title={saveState === "error" ? "下载失败" : "下载图片（Ctrl/⌘+S）"} aria-label="下载图片" onClick={() => void save()}>
          {saveState === "error" ? (
            <svg {...ICON}>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          ) : (
            <svg {...ICON}>
              <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
            </svg>
          )}
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
