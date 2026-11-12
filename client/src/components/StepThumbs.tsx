import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ImageViewer } from "./ImageThumb";

/** 过程里一步返回的一张图：label 是这一步的名字（预览卡下面显示） */
export interface StepImage {
  src: string;
  label: string;
}

/** 一排里一次显示几张小图，更多的用箭头翻页 */
const MAX_THUMBS = 3;

/**
 * 结果小图，参照 codex-app-server 的 StepThumbs（client/src/components/ItemView.tsx）：放在工具行、
 * 折叠的组标题行和「用时 …」行的最右边。鼠标移上去在上方（放不下时在下方）弹出预览卡（大一点的图、
 * 这一步的名字、第几张），点击看大图。一次显示 3 张，多于 3 张时两边是「‹」「›」翻页；读不出来的图不显示
 */
export function StepThumbs({ images }: { images: StepImage[] }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [hover, setHover] = useState<{ index: number; rect: DOMRect } | null>(null);
  const [viewing, setViewing] = useState<StepImage | null>(null);
  const [page, setPage] = useState(0);
  // 预览卡按小图当时的位置固定在窗口上，一滚动就对不上了：滚动（包括会话的内部滚动）时收起
  const hovering = hover !== null;
  useEffect(() => {
    if (!hovering) return;
    const hide = () => setHover(null);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", hide, { capture: true });
  }, [hovering]);
  const ok = images.filter((img) => !failed.has(img.src));
  if (ok.length === 0) return null;
  // 图少了（有的读不出来）时不停在空页上
  const pages = Math.ceil(ok.length / MAX_THUMBS);
  const current = Math.min(page, pages - 1);
  const start = current * MAX_THUMBS;
  const shown = ok.slice(start, start + MAX_THUMBS);
  const preview = hover && ok[hover.index];
  const turn = (to: number) => () => {
    setHover(null);
    setPage(to);
  };
  return (
    <span className="step-thumbs">
      {pages > 1 && (
        <button type="button" className="step-thumbs-nav" aria-label="上一组图片" disabled={current === 0} onClick={turn(current - 1)}>
          ‹
        </button>
      )}
      {shown.map((img, i) => {
        const index = start + i;
        const enter = (e: { currentTarget: HTMLElement }) => setHover({ index, rect: e.currentTarget.getBoundingClientRect() });
        return (
          <button
            key={`${index}-${img.src.slice(-40)}`}
            type="button"
            className="step-thumb"
            aria-label={`查看大图：${img.label}`}
            onMouseEnter={enter}
            onMouseLeave={() => setHover(null)}
            onFocus={enter}
            onBlur={() => setHover(null)}
            onClick={(e) => {
              // 先让小图失去焦点：大图关掉后焦点回到小图会再弹出预览卡
              e.currentTarget.blur();
              setHover(null);
              setViewing(img);
            }}
          >
            <img src={img.src} alt="" loading="lazy" onError={() => setFailed((s) => new Set(s).add(img.src))} />
          </button>
        );
      })}
      {pages > 1 && (
        <button
          type="button"
          className="step-thumbs-nav"
          title={current < pages - 1 ? `后面还有 ${ok.length - start - shown.length} 张` : undefined}
          aria-label="下一组图片"
          disabled={current === pages - 1}
          onClick={turn(current + 1)}
        >
          ›
        </button>
      )}
      {preview && createPortal(<ThumbPreview img={preview} index={hover.index} total={ok.length} anchor={hover.rect} />, document.body)}
      {viewing && <ImageViewer src={viewing.src} alt={viewing.label} onClose={() => setViewing(null)} />}
    </span>
  );
}

/** 预览卡的宽度、和小图的间距、离窗口边缘至少留的距离 */
const PREVIEW_W = 320;
const PREVIEW_GAP = 8;
const PREVIEW_MARGIN = 8;
/** 小图上方放得下这么高才往上弹，否则往下 */
const PREVIEW_MIN_ABOVE = 240;

function ThumbPreview({ img, index, total, anchor }: { img: StepImage; index: number; total: number; anchor: DOMRect }) {
  const left = Math.max(PREVIEW_MARGIN, Math.min(anchor.right - PREVIEW_W, window.innerWidth - PREVIEW_W - PREVIEW_MARGIN));
  const above = anchor.top >= PREVIEW_MIN_ABOVE;
  const style = above ? { left, bottom: window.innerHeight - anchor.top + PREVIEW_GAP } : { left, top: anchor.bottom + PREVIEW_GAP };
  return (
    <div className="thumb-preview" style={{ ...style, width: PREVIEW_W }} aria-hidden>
      <div className="thumb-preview-img">
        <img src={img.src} alt="" />
      </div>
      <div className="thumb-preview-foot">
        <span className="thumb-preview-label">{img.label}</span>
        {total > 1 && (
          <span className="thumb-preview-count">
            {index + 1} / {total}
          </span>
        )}
      </div>
    </div>
  );
}
