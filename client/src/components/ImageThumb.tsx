import { useEffect, useState } from "react";

/** 图片缩略图，点开看大图（Esc 或点旁边关闭） */
export function ImageThumb({ src, alt = "图片", className = "image-thumb" }: { src: string; alt?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} title="查看大图">
        <img src={src} alt={alt} loading="lazy" />
      </button>
      {open && (
        <div className="image-viewer" onClick={() => setOpen(false)} role="dialog" aria-label={alt}>
          <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}
