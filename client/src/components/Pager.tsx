import { useRef } from "react";

/** 目录（插件市场、连接器市场）每页的条数 */
export const PAGE_SIZE = 10;

/** 第 page 页（从 0 开始）的条目 */
export const pageOf = <T,>(items: T[], page: number) => items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
 * hasMore：服务端还有没取回来的（连接器搜索结果），最后一页后面多一个省略号，向右的箭头照样能点，由 onPage 去取；只有一页且没有更多时不显示
 */
export function Pager({
  page,
  total,
  hasMore = false,
  loading = false,
  onPage,
}: {
  page: number;
  total: number;
  hasMore?: boolean;
  loading?: boolean;
  onPage: (page: number) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
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
