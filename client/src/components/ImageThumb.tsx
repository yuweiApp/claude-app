import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** 看大图：铺满窗口，Esc 或点旁边关闭。挂在 body 上，不受所在位置的滚动、裁剪影响 */
export function ImageViewer({ src, alt = "图片", onClose }: { src: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="image-viewer" onClick={onClose} role="dialog" aria-label={alt}>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
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
