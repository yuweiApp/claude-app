import { useRef } from "react";

/** 目录列表每页的条数 */
export const PAGE_SIZE = 20;

/** 第 page 页（从 0 开始）的条目 */
export const pageOf = <T,>(items: T[], page: number) => items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

/**
 * 列表底部的分页：上一页、第几页、下一页。翻页后滚回设置页顶部。
 * hasMore：服务端还有没取回来的（连接器搜索结果），最后一页的「下一页」照样能点，由 onPage 去取；只有一页且没有更多时不显示
 */
export function Pager({ page, total, hasMore = false, loading = false, onPage }: { page: number; total: number; hasMore?: boolean; loading?: boolean; onPage: (page: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1 && !hasMore) return null;
  const go = (next: number) => {
    onPage(next);
    ref.current?.closest(".settings-main")?.scrollTo({ top: 0 });
  };
  return (
    <div ref={ref} className="pager">
      <button disabled={page === 0 || loading} onClick={() => go(page - 1)}>
        上一页
      </button>
      <span>
        第 {page + 1} / {pages}
        {hasMore ? "+" : ""} 页
      </span>
      <button disabled={(page >= pages - 1 && !hasMore) || loading} onClick={() => go(page + 1)}>
        {loading ? "加载中…" : "下一页"}
      </button>
    </div>
  );
}
