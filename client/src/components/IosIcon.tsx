import type { ReactNode } from "react";

/** iOS 设置里那种图标：彩色圆角方块（上浅下深的渐变），里面一个白色图形；颜色见 styles.css 的 .ios-icon-* */
export function IosIcon({ tone, size = 26, children }: { tone: "gray" | "orange" | "blue" | "purple" | "pink" | "green"; size?: number; children: ReactNode }) {
  return (
    <span className={`ios-icon ios-icon-${tone}`} style={{ width: size, height: size }} aria-hidden="true">
      {children}
    </span>
  );
}

/** 实心房子（门镂空），放在橙色的 IosIcon 里当首页按钮 */
export function HomeGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M12.7 2.6a1.1 1.1 0 0 0-1.4 0L2.9 9.7a1 1 0 0 0 .6 1.8H5v8.3c0 .9.7 1.6 1.6 1.6h10.8c.9 0 1.6-.7 1.6-1.6v-8.3h1.5a1 1 0 0 0 .6-1.8zM10 15.2c0-.6.4-1 1-1h2c.6 0 1 .4 1 1v6.2h-4z"
      />
    </svg>
  );
}

/** 实心齿轮（中间镂空），放在灰色的 IosIcon 里当设置按钮 */
export function GearGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M10.3 1.8h3.4l.7 2.7c.8.3 1.5.7 2.1 1.2l2.7-.8 1.7 2.9-2 2c.1.8.1 1.6 0 2.4l2 2-1.7 2.9-2.7-.8c-.6.5-1.3.9-2.1 1.2l-.7 2.7h-3.4l-.7-2.7c-.8-.3-1.5-.7-2.1-1.2l-2.7.8-1.7-2.9 2-2a8 8 0 0 1 0-2.4l-2-2 1.7-2.9 2.7.8c.6-.5 1.3-.9 2.1-1.2zM12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z"
      />
    </svg>
  );
}
