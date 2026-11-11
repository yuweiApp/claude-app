import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CHAT_SIZE, CUSTOM_FONT, MONO_FONTS, UI_FONTS, localFontFamilies, updateFont, useFont, type FontPreset } from "../font";
import { CUSTOM_SKIN, SKIN_PRESETS, loadSkinImage, removeSkinImage, setSkin, setSkinImage, skinVars, updateSkin, useSkin, veilRange } from "../skin";
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
 * 设置里的「外观」（同 codex-app-server 的 AppearancePage）：颜色模式、皮肤（含自定义背景图），调整强调色和背景遮罩，字体。
 * 设置存在这个浏览器里（见 theme.ts、skin.ts、font.ts）。预览卡片用和页面一样的变量，按当前深浅色显示
 */
export function AppearancePage() {
  const theme = useTheme();
  const skin = useSkin();
  const fileRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const { dataUrl, accent } = await loadSkinImage(file);
      setSkinImage(dataUrl, accent);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const chooseImage = () => fileRef.current?.click();

  return (
    <div className="appearance">
      <header className="settings-head">
        <div className="settings-title">
          <h1>外观</h1>
          <p>设置界面的颜色模式、皮肤、配色和字体，皮肤在浅色和深色下都能使用。</p>
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
          <SkinCard name="无" desc="原来的外观" active={!skin.id} onSelect={() => setSkin(null)} preview={<div className="skin-preview skin-preview-none">{MINI_UI}</div>} />
          {SKIN_PRESETS.map((p) => (
            <SkinCard
              key={p.id}
              name={p.name}
              desc={p.desc}
              active={skin.id === p.id}
              onSelect={() => setSkin(p.id)}
              preview={
                <div className={`skin-preview skin-preview-${p.id}`} style={skinVars(p) as CSSProperties}>
                  {MINI_UI}
                </div>
              }
            />
          ))}
          <SkinCard
            name="自定义背景"
            desc={skin.image ? "用你上传的图片当背景" : "上传一张喜欢的图片当背景"}
            active={skin.id === CUSTOM_SKIN}
            onSelect={() => (skin.image ? setSkin(CUSTOM_SKIN) : chooseImage())}
            preview={
              <div className="skin-preview skin-preview-custom" style={skin.image ? { backgroundImage: `url("${skin.image}")` } : undefined}>
                {skin.image ? MINI_UI : loading ? "正在读取…" : "＋ 选择图片"}
              </div>
            }
          />
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void pickImage(e.target.files?.[0])} />
      </section>

      <section className="appearance-section">
        <h2>调整</h2>
        <div className="appearance-card">
          <div className="appearance-row">
            <span className="appearance-row-text">
              <span className="appearance-row-label">背景图片</span>
              {error ? (
                <span className="appearance-row-desc appearance-error">{error}</span>
              ) : (
                <span className="appearance-row-desc">{skin.image ? "已上传，长边缩到 1920 像素以内，只存在这个浏览器里" : "支持常见图片格式，会自动取一个强调色"}</span>
              )}
            </span>
            <span className="appearance-row-actions">
              <button className="btn-small" disabled={loading} onClick={chooseImage}>
                {loading ? "正在读取…" : skin.image ? "更换图片" : "选择图片"}
              </button>
              {skin.image && (
                <button className="btn-small" onClick={removeSkinImage}>
                  移除
                </button>
              )}
            </span>
          </div>
          {skin.id && (
            <div className="appearance-row">
              <span className="appearance-row-text">
                <span className="appearance-row-label">强调色</span>
                <span className="appearance-row-desc">按钮、选中项和链接的颜色</span>
              </span>
              <span className="appearance-row-actions">
                {skin.accentChanged && (
                  <button className="btn-small" onClick={() => updateSkin({ accent: null })}>
                    恢复
                  </button>
                )}
                <input type="color" className="appearance-color" value={skin.accent} aria-label="强调色" onChange={(e) => updateSkin({ accent: e.target.value })} />
              </span>
            </div>
          )}
          {skin.veil !== null && (
            <div className="appearance-row">
              <span className="appearance-row-text">
                <span className="appearance-row-label">背景遮罩 {skin.veil}%</span>
                <span className="appearance-row-desc">
                  {skin.hasImage ? "盖在图片上的底色浓度，越高图片越淡、文字越清楚" : "盖在背景光晕上的底色浓度，越高背景越淡"}
                </span>
              </span>
              <input
                type="range"
                className="appearance-range"
                {...veilRange(skin.hasImage)}
                step={5}
                value={skin.veil}
                aria-label="背景遮罩"
                onChange={(e) => updateSkin({ veil: Number(e.target.value) })}
              />
            </div>
          )}
        </div>
      </section>

      <FontSection />
    </div>
  );
}

const fontOptions = (presets: FontPreset[]) => [...presets.map((p) => ({ value: p.id, label: p.label })), { value: CUSTOM_FONT, label: "自定义…" }];

/** 「字体」一节：界面字体、代码字体（预设或自定义字体名），对话字号；上面一块预览按当前设置显示 */
function FontSection() {
  const font = useFont();
  const [localFonts, setLocalFonts] = useState<string[] | null>(null);
  // 本机字体列表要在用户操作里取（会请求权限），第一次点进自定义输入框时取一次
  const loadLocalFonts = () => {
    if (localFonts) return;
    setLocalFonts([]);
    void localFontFamilies().then(setLocalFonts);
  };

  return (
    <section className="appearance-section">
      <h2>字体</h2>
      <div className="appearance-card">
        <div className="font-preview" aria-hidden="true">
          <p style={{ fontSize: font.size }}>天地玄黄，宇宙洪荒。The quick brown fox jumps over the lazy dog.</p>
          <code>const answer = items.filter((x) =&gt; x.ok).length; // 0O 1lI</code>
        </div>
        <div className="appearance-row">
          <span className="appearance-row-text">
            <span className="appearance-row-label">界面字体</span>
            <span className="appearance-row-desc">菜单、按钮和对话正文的字体</span>
          </span>
          <Select aria-label="界面字体" value={font.ui} options={fontOptions(UI_FONTS)} onChange={(v) => updateFont({ ui: v })} />
        </div>
        {font.ui === CUSTOM_FONT && (
          <FontNameRow label="界面字体名称" value={font.uiCustom} fonts={localFonts} onFocus={loadLocalFonts} onChange={(v) => updateFont({ uiCustom: v })} />
        )}
        <div className="appearance-row">
          <span className="appearance-row-text">
            <span className="appearance-row-label">代码字体</span>
            <span className="appearance-row-desc">代码块、终端、文件编辑器的等宽字体</span>
          </span>
          <Select aria-label="代码字体" value={font.mono} options={fontOptions(MONO_FONTS)} onChange={(v) => updateFont({ mono: v })} />
        </div>
        {font.mono === CUSTOM_FONT && (
          <FontNameRow label="代码字体名称" value={font.monoCustom} fonts={localFonts} onFocus={loadLocalFonts} onChange={(v) => updateFont({ monoCustom: v })} />
        )}
        <div className="appearance-row">
          <span className="appearance-row-text">
            <span className="appearance-row-label">对话字号 {font.size}px</span>
            <span className="appearance-row-desc">消息和输入框正文的字号，默认 {CHAT_SIZE.default}px</span>
          </span>
          <span className="appearance-row-actions">
            {font.size !== CHAT_SIZE.default && (
              <button className="btn-small" onClick={() => updateFont({ size: CHAT_SIZE.default })}>
                恢复
              </button>
            )}
            <input
              type="range"
              className="appearance-range"
              min={CHAT_SIZE.min}
              max={CHAT_SIZE.max}
              step={1}
              value={font.size}
              aria-label="对话字号"
              onChange={(e) => updateFont({ size: Number(e.target.value) })}
            />
          </span>
        </div>
      </div>
    </section>
  );
}

/** 自定义字体名：手填，或从本机装的字体里选（浏览器支持时出候选） */
function FontNameRow(props: { label: string; value: string; fonts: string[] | null; onFocus: () => void; onChange: (v: string) => void }) {
  const listId = `font-list-${props.label}`;
  return (
    <div className="appearance-row">
      <span className="appearance-row-text">
        <span className="appearance-row-label">{props.label}</span>
        <span className="appearance-row-desc">本机装的字体名，多个用逗号分开，前面的没有就用后面的</span>
      </span>
      <input
        className="appearance-input"
        value={props.value}
        placeholder="如 LXGW WenKai, 霞鹜文楷"
        aria-label={props.label}
        list={props.fonts?.length ? listId : undefined}
        spellCheck={false}
        onFocus={props.onFocus}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {!!props.fonts?.length && (
        <datalist id={listId}>
          {props.fonts.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      )}
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
