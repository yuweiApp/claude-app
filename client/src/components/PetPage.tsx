import { setPetEnabled, usePetEnabled } from "../pet";

/** 设置里的「灵宠」（桌面版）：屏幕角落的小精灵，告诉你会话完成了。开关存在这个浏览器里（见 pet.ts） */
export function PetPage() {
  const enabled = usePetEnabled();
  return (
    <div className="appearance">
      <header className="settings-head">
        <div className="settings-title">
          <h1>灵宠</h1>
          <p>屏幕右下角会一直待着一只小灵宠：没事时它在那儿待着，有会话在跑时它陪着干活，你不在这个窗口时会话完成了它会跳起来告诉你。双击它或点气泡回到完成的会话，按住可以拖到别处，右键可以暂时隐藏或关掉它。</p>
        </div>
      </header>

      <section className="appearance-section">
        <div className="appearance-card">
          <div className="appearance-row">
            <span className="appearance-row-text">
              <span className="appearance-row-label">显示灵宠</span>
              <span className="appearance-row-desc">打开后一直显示在屏幕角落，窗口开着、最小化都在</span>
            </span>
            <button className={`switch${enabled ? " on" : ""}`} role="switch" aria-checked={enabled} aria-label="显示灵宠" onClick={() => setPetEnabled(!enabled)} />
          </div>
        </div>
      </section>
    </div>
  );
}
