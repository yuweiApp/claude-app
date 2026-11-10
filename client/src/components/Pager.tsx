import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** 目录（插件市场、连接器市场）每页的条数：量不出来时（不在设置页里）用这个 */
export const PAGE_SIZE = 10;

/** 量每页条数时先渲染的卡片数，也是每页条数的上限 */
export const PROBE_SIZE = 60;

/** 分页栏占的高度：.pager 的 padding-top 16px + 按钮 30px */
const PAGER_SPACE = 46;

/** 第 page 页（从 0 开始）的条目 */
export const pageOf = <T,>(items: T[], page: number, size = PAGE_SIZE) => items.slice(page * size, (page + 1) * size);

/**
 * 第一次显示时按设置页的可见区域算每页条数：网格的列数 × 不出滚动条能放下的行数（至少一行）。
 * 还没算出来时返回 null，这时目录先渲染最多 PROBE_SIZE 张卡片（ready：已经渲染出卡片），绘制之前量出列数和最高的卡片，
 * 算好后只显示这么多，所以不会先闪一下。算好就固定下来，之后窗口大小变了也不变，免得翻到一半页码对不上
 */
export function useFitPageSize(gridRef: RefObject<HTMLElement | null>, ready: boolean): number | null {
  const [size, setSize] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (size !== null || !ready) return;
    const grid = gridRef.current;
    const main = grid?.closest<HTMLElement>(".settings-main");
    const cards = grid ? ([...grid.children] as HTMLElement[]) : [];
    if (!grid || !main) return setSize(PAGE_SIZE);
    if (!cards.length) return;
    // 一页放得下时没有滚动条：量的时候先去掉，列数和宽度按没有滚动条时的算
    const overflow = main.style.overflowY;
    main.style.overflowY = "hidden";
    try {
      // 计算后的 grid-template-columns 是展开后的各列宽度，auto-fill 实际排了几列就有几项
      const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length);
      const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
      // 同一行的卡片一样高（拉伸到这一行最高的），取最高的一张当每行的高度
      const cardHeight = Math.max(...cards.map((c) => c.getBoundingClientRect().height));
      const top = grid.getBoundingClientRect().top;
      const bottom = main.getBoundingClientRect().top + main.clientHeight - parseFloat(getComputedStyle(main).paddingBottom);
      const rows = Math.max(1, Math.floor((bottom - PAGER_SPACE - top + gap) / (cardHeight + gap)));
      setSize(Math.min(PROBE_SIZE, cols * rows));
    } finally {
      main.style.overflowY = overflow;
    }
  }, [gridRef, ready, size]);
  return size;
}

/**
 * 要显示的页码（从 0 开始）：页数不多时全列；多时留第一页、最后一页和当前页附近的，中间用省略号（gap）。
 * 靠近开头时列前 5 页（1 2 3 4 5 … 20），靠近结尾时列后 5 页，中间时列当前页和前后各一页
 */
function pageItems(page: number, pages: number): (number | "gap")[] {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  if (pages <= 7) return range(0, pages - 1);
  if (page < 4) return [...range(0, 4), "gap", pages - 1];
  if (page > pages - 5) return [0, "gap", ...range(pages - 5, pages - 1)];
  return [0, "gap", page - 1, page, page + 1, "gap", pages - 1];
}

const Arrow = ({ left }: { left?: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d={left ? "M7 1.5 3 5l4 3.5" : "M3 1.5 7 5 3 8.5"} fill="currentColor" />
  </svg>
);

/**
 * 列表底部的分页：左右箭头和页码按钮，当前页高亮，页数多时中间省略。翻页后滚回设置页顶部。
 * hasMore：服务端还有没取回来的（连接器搜索结果），最后一页后面多一个省略号，向右的箭头照样能点，由 onPage 去取；只有一页且没有更多时不显示。
 * pageSize：每页条数，默认 PAGE_SIZE
 */
export function Pager({
  page,
  total,
  pageSize = PAGE_SIZE,
  hasMore = false,
  loading = false,
  onPage,
}: {
  page: number;
  total: number;
  pageSize?: number;
  hasMore?: boolean;
  loading?: boolean;
  onPage: (page: number) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1 && !hasMore) return null;
  const go = (next: number) => {
    if (next === page) return;
    onPage(next);
    ref.current?.closest(".settings-main")?.scrollTo({ top: 0 });
  };
  const items = pageItems(page, pages);
  return (
    <nav ref={ref} className="pager" aria-label="分页">
      <button className="pager-btn" aria-label="上一页" title="上一页" disabled={page === 0 || loading} onClick={() => go(page - 1)}>
        <Arrow left />
      </button>
      {items.map((item, i) =>
        item === "gap" ? (
          <span key={`gap${i}`} className="pager-gap">
            …
          </span>
        ) : (
          <button
            key={item}
            className={`pager-btn${item === page ? " current" : ""}`}
            aria-current={item === page ? "page" : undefined}
            disabled={loading && item !== page}
            onClick={() => go(item)}
          >
            {item + 1}
          </button>
        ),
      )}
      {hasMore && <span className="pager-gap">…</span>}
      <button className="pager-btn" aria-label="下一页" title={loading ? "加载中…" : "下一页"} disabled={(page >= pages - 1 && !hasMore) || loading} onClick={() => go(page + 1)}>
        <Arrow />
      </button>
    </nav>
  );
}
