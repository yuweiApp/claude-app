import type { CSSProperties, ReactNode } from "react";
import { SKIN_PRESETS, setSkin, skinVars, useSkin } from "../skin";
import { setTheme, useTheme, type Theme } from "../theme";
import { Select } from "./Select";

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/** 皮肤预览里的迷你界面：侧边栏、输入框、强调色圆点 */
const MINI_UI = (
  <>
    <span className="skin-preview-side" />
    <span className="skin-preview-box" />
    <span className="skin-preview-dot" />
  </>
);

/**
 * 设置里的「外观」（同 codex-app-server 的 AppearancePage）：颜色模式和皮肤，存在这个浏览器里（见 theme.ts、skin.ts）。
 * 预览卡片用和页面一样的变量，按当前深浅色显示
 */
export function AppearancePage() {
  const theme = useTheme();
  const skin = useSkin();

  return (
    <div className="appearance">
      <header className="settings-head">
        <div className="settings-title">
          <h1>外观</h1>
          <p>设置界面的颜色模式和皮肤，皮肤在浅色和深色下都能使用。</p>
        </div>
      </header>

      <section className="appearance-section">
        <h2>主题</h2>
        <div className="appearance-card">
          <div className="appearance-row">
            <span className="appearance-row-text">
              <span className="appearance-row-label">颜色模式</span>
              <span className="appearance-row-desc">选择浅色、深色，或跟随系统设置</span>
            </span>
            <Select aria-label="颜色模式" value={theme} options={THEMES} onChange={(v) => setTheme(v as Theme)} />
          </div>
        </div>
      </section>

      <section className="appearance-section">
        <h2>皮肤</h2>
        <div className="skin-grid">
          <SkinCard name="无" desc="原来的外观" active={!skin} onSelect={() => setSkin(null)} preview={<div className="skin-preview skin-preview-none">{MINI_UI}</div>} />
          {SKIN_PRESETS.map((p) => (
            <SkinCard
              key={p.id}
              name={p.name}
              desc={p.desc}
              active={skin?.id === p.id}
              onSelect={() => setSkin(p)}
              preview={
                <div className={`skin-preview skin-preview-${p.id}`} style={skinVars(p) as CSSProperties}>
                  {MINI_UI}
                </div>
              }
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function SkinCard(props: { name: string; desc: string; active: boolean; preview: ReactNode; onSelect: () => void }) {
  return (
    <button type="button" className={`skin-card${props.active ? " active" : ""}`} aria-pressed={props.active} onClick={props.onSelect}>
      {props.preview}
      <span className="skin-card-name">
        {props.name}
        {props.active && (
          <svg className="skin-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m3.5 8.5 3 3 6-7" />
          </svg>
        )}
      </span>
      <span className="skin-card-desc">{props.desc}</span>
    </button>
  );
}
