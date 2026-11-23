import { setPetEnabled, usePetEnabled } from "../pet";

/** 设置里的「灵宠」（桌面版）：主窗口最小化时，屏幕角落的小精灵告诉你会话完成了。开关存在这个浏览器里（见 pet.ts） */
export function PetPage() {
  const enabled = usePetEnabled();
  return (
    <div className="appearance">
      <header className="settings-head">
        <div className="settings-title">
          <h1>灵宠</h1>
          <p>窗口最小化后，屏幕右下角会出现一只小灵宠：没事时它在那儿待着，有会话在跑时它陪着干活，会话完成时跳起来告诉你。点它回到完成的会话，按住可以拖到别处，右键可以暂时隐藏或关掉它。</p>
        </div>
      </header>

      <section className="appearance-section">
        <div className="appearance-card">
          <div className="appearance-row">
            <span className="appearance-row-text">
              <span className="appearance-row-label">最小化时显示灵宠</span>
              <span className="appearance-row-desc">窗口最小化时出现，回到窗口时自动收起</span>
            </span>
            <button className={`switch${enabled ? " on" : ""}`} role="switch" aria-checked={enabled} aria-label="最小化时显示灵宠" onClick={() => setPetEnabled(!enabled)} />
          </div>
        </div>
      </section>
    </div>
  );
}
