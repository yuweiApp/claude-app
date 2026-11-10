import type { MouseEvent, ReactNode, Ref } from "react";

/** 设置页的卡片网格（插件市场、连接器市场、技能）：卡片从左往右排，放不下换行；loading 时旧卡片变淡（换页、搜索的请求还没回来） */
export function CardGrid({ gridRef, loading = false, children }: { gridRef?: Ref<HTMLDivElement>; loading?: boolean; children: ReactNode }) {
  return (
    <div ref={gridRef} className={`market-grid${loading ? " loading" : ""}`} aria-busy={loading}>
      {children}
    </div>
  );
}

const stop = (e: MouseEvent) => e.stopPropagation();

/**
 * 一张卡片：头部是图标、标题（太长截断）、badge（标签）和 menu（右上角的菜单），下面是最多 3 行的描述、信息行和底部一行（foot）。
 * 传了 onOpen 的整张卡片可以点开详情，标题是按钮（键盘能选中）；点到卡片里的其他按钮、链接不算。
 * menu 里的点击（包括它弹出的菜单、确认框）不冒泡到卡片上。dimmed：停用的，图标和描述变淡
 */
export function Card({
  icon,
  title,
  badge,
  menu,
  description,
  meta,
  foot,
  dimmed = false,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  menu?: ReactNode;
  description?: string;
  meta?: ReactNode;
  foot?: ReactNode;
  dimmed?: boolean;
  onOpen?: () => void;
}) {
  return (
    <div
      className={`market-card${onOpen ? " openable" : ""}${dimmed ? " dimmed" : ""}`}
      onClick={onOpen && ((e) => !(e.target as HTMLElement).closest("a, button") && onOpen())}
    >
      <div className="market-card-head">
        {icon}
        {onOpen ? (
          <button className="market-card-title market-card-open" title={title} onClick={onOpen}>
            {title}
          </button>
        ) : (
          <div className="market-card-title" title={title}>
            {title}
          </div>
        )}
        {badge}
        {menu && (
          <span className="market-card-menu" onClick={stop}>
            {menu}
          </span>
        )}
      </div>
      {description && (
        <div className="market-card-desc" title={description}>
          {description}
        </div>
      )}
      {meta && <div className="market-card-meta">{meta}</div>}
      {foot && <div className="market-card-foot">{foot}</div>}
    </div>
  );
}
