import { useEffect, useState, type FormEvent } from "react";
import { api, BROWSERS_CHANGED, type BrowserEntry, type BrowserSettingsView } from "../api";
import { BrowserIcon } from "./BrowserTab";
import { Select } from "./Select";

/**
 * 设置里的「浏览器」：让 AI 操作用户自己的浏览器（外部浏览器，经 Playwright 扩展连接）。
 * 列出网关那台电脑上检测到的 Chromium 内核浏览器和手动添加的，每个可以启停、选配置、填扩展 token；
 * 改动存在网关（gateway-browsers.json），对之后启动的会话生效。见 gateway/src/browser/browser-settings.ts
 */
export function BrowsersPage() {
  const [view, setView] = useState<BrowserSettingsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .browsers()
      .then(
        (v) => {
          setView(v);
          setError(null);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  /** 改完用返回的最新列表，并通知 App 重新取启用着的浏览器（引用、「浏览器」菜单用） */
  const apply = (action: Promise<BrowserSettingsView>) =>
    action.then(
      (v) => {
        setView(v);
        setError(null);
        window.dispatchEvent(new Event(BROWSERS_CHANGED));
      },
      (e: Error) => setError(e.message),
    );

  const enabled = view?.browsers.filter((b) => b.enabled).length ?? 0;

  return (
    <div className="appearance browsers-page">
      <header className="settings-head">
        <div className="settings-title">
          <h1>浏览器</h1>
          <p>
            让 AI 操作你自己的浏览器，带着里面的登录状态。列出的是网关这台电脑上检测到的 Chromium 内核浏览器，要先在浏览器里装{" "}
            {view ? (
              <a href={view.installUrl} target="_blank" rel="noreferrer">
                Playwright 扩展
              </a>
            ) : (
              "Playwright 扩展"
            )}
            （Edge 等也从 Chrome 应用商店装）。{view && `已启用 ${enabled} 个，`}改动对之后开始的对话生效。
          </p>
        </div>
        <button disabled={loading} onClick={load}>
          {loading ? "检测中…" : "重新检测"}
        </button>
        <button className="primary" onClick={() => setAdding(true)}>
          手动添加
        </button>
      </header>
      {error && <div className="settings-error">{error}</div>}
      {notice && <div className="browsers-notice">{notice}</div>}

      <section className="appearance-section">
        <h2>浏览器</h2>
        {!view ? (
          <div className="settings-empty">{loading ? "检测中…" : ""}</div>
        ) : view.browsers.length ? (
          <div className="settings-list">
            {view.browsers.map((b) => (
              <BrowserRow key={b.id} browser={b} installUrl={view.installUrl} apply={apply} />
            ))}
          </div>
        ) : (
          <div className="settings-empty">没检测到 Chromium 内核的浏览器，装在别处的可以点右上角手动添加</div>
        )}
      </section>

      <section className="appearance-section">
        <h2>选项</h2>
        <div className="appearance-card">
          <div className="appearance-row">
            <span className="appearance-row-text">
              <span className="appearance-row-label">连接时建标签页组</span>
              <span className="appearance-row-desc">
                扩展把交给 AI 的标签页放进「Playwright」组，可以把标签页拖进、拖出组来交给 AI 或收回。每连接一次建一个新组，Chrome 会把它们保存到书签栏
              </span>
            </span>
            <button
              className={`switch${view?.tabGroup ? " on" : ""}`}
              role="switch"
              aria-checked={!!view?.tabGroup}
              aria-label="连接时建标签页组"
              disabled={!view}
              onClick={() => view && void apply(api.setBrowserTabGroup(!view.tabGroup))}
            />
          </div>
        </div>
      </section>

      {adding && (
        <AddBrowserDialog
          onClose={() => setAdding(false)}
          onAdded={(v, chromium, name) => {
            setAdding(false);
            setView(v);
            setError(null);
            setNotice(chromium ? null : `「${name}」看着不像 Chromium 内核的浏览器，Playwright 扩展可能装不上、连不上`);
            window.dispatchEvent(new Event(BROWSERS_CHANGED));
          }}
        />
      )}
    </div>
  );
}

function BrowserRow({ browser: b, installUrl, apply }: { browser: BrowserEntry; installUrl: string; apply: (action: Promise<BrowserSettingsView>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const withExtension = b.profiles.filter((p) => p.extension);

  /** 扩展装在哪、用哪个配置 */
  const status = (() => {
    if (!b.installed) return <span className="mcp-status failed">找不到可执行文件</span>;
    if (!b.profiles.length)
      return b.custom && !b.userDataDir ? <span>没填用户数据目录，没法检查扩展，连接时用浏览器自己的配置</span> : <span>还没有配置，先打开浏览器用一次</span>;
    if (!withExtension.length)
      return (
        <span className="mcp-status needs-auth">
          没装 Playwright 扩展 ·{" "}
          <a className="settings-link" href={installUrl} target="_blank" rel="noreferrer">
            去安装
          </a>
        </span>
      );
    const chosen = b.profile !== undefined ? b.profiles.find((p) => p.dir === b.profile) : withExtension[0];
    return (
      <span className="mcp-status connected">
        已装扩展{chosen ? `（用配置「${chosen.name}」${chosen.extension ? "" : "，这个配置里没装扩展"}）` : ""}
      </span>
    );
  })();

  const profileOptions = [
    { value: "", label: "自动：装了扩展、最近用过的" },
    ...b.profiles.map((p) => ({ value: `=${p.dir}`, label: `${p.name}${p.dir && p.name !== p.dir ? `（${p.dir}）` : ""}${p.extension ? " · 已装扩展" : ""}` })),
  ];

  return (
    <div className="settings-row browsers-row">
      <span className="browsers-icon">
        <BrowserIcon logo={b.logo} name={b.name} />
      </span>
      <div className="settings-row-main">
        <div className="settings-row-name">
          {b.name}
          {b.custom && <span className="settings-tag">手动添加</span>}
          {b.custom && b.installed && !b.chromium && <span className="settings-tag">不像 Chromium 内核</span>}
        </div>
        <div className="settings-row-target" title={b.executablePath}>
          {b.executablePath}
        </div>
        <div className="settings-row-status">
          {status}
          {b.hasToken && " · 已填 token，自动连接"}
          {" · "}
          <button className="settings-link" onClick={() => setOpen((o) => !o)}>
            {open ? "收起" : "设置"}
          </button>
        </div>
        {open && (
          <div className="browsers-detail">
            {b.profiles.length > 0 && (
              <div className="browsers-field">
                <span className="browsers-field-label">配置</span>
                <Select
                  aria-label="配置"
                  value={b.profile === undefined ? "" : `=${b.profile}`}
                  options={profileOptions}
                  onChange={(v) => void apply(api.updateBrowser(b.id, { profile: v ? v.slice(1) : null }))}
                />
              </div>
            )}
            <form
              className="browsers-field"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void apply(api.updateBrowser(b.id, { token })).then(() => setToken(""));
              }}
            >
              <span className="browsers-field-label">扩展 token</span>
              <input
                type="password"
                autoComplete="off"
                value={token}
                placeholder={b.hasToken ? "已填写，输入新的可以替换" : "连接页上复制的 token，填了就免批准自动连接"}
                onChange={(e) => setToken(e.target.value)}
              />
              <button type="submit" disabled={!token.trim()}>
                保存
              </button>
              {b.hasToken && (
                <button type="button" onClick={() => void apply(api.updateBrowser(b.id, { token: null }))}>
                  清除
                </button>
              )}
            </form>
            <p className="browsers-hint">token 只给网关自己连接用，不会交给 AI。</p>
            {b.custom && (
              <div className="browsers-field">
                <span className="browsers-field-label">用户数据目录</span>
                <span className="browsers-path" title={b.userDataDir}>
                  {b.userDataDir ?? "没填"}
                </span>
                <button type="button" className="danger" onClick={() => void apply(api.removeBrowser(b.id))}>
                  删除这个浏览器
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="settings-row-actions">
        <button
          className={`switch${b.enabled ? " on" : ""}`}
          role="switch"
          aria-checked={b.enabled}
          aria-label={`启用 ${b.name}`}
          disabled={!b.installed}
          title={b.installed ? undefined : "找不到可执行文件"}
          onClick={() => void apply(api.updateBrowser(b.id, { enabled: !b.enabled }))}
        />
      </div>
    </div>
  );
}

/** 手动添加：名字、可执行文件（macOS 可以填 .app）、用户数据目录（可选，填了才能检查扩展、选配置）。路径都是网关那台电脑上的 */
function AddBrowserDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (view: BrowserSettingsView, chromium: boolean, name: string) => void }) {
  const [name, setName] = useState("");
  const [exe, setExe] = useState("");
  const [userDataDir, setUserDataDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    api
      .addBrowser({ name: name.trim(), executablePath: exe.trim(), ...(userDataDir.trim() ? { userDataDir: userDataDir.trim() } : {}) })
      .then(
        (r) => onAdded(r.view, r.chromium, name.trim()),
        (err: Error) => setError(err.message),
      )
      .finally(() => setSaving(false));
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog settings-form mcp-dialog" aria-label="添加浏览器" onSubmit={submit}>
        <h3>添加浏览器</h3>
        <label>
          名字
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 Brave Nightly" />
        </label>
        <label>
          可执行文件
          <input required className="mono" value={exe} onChange={(e) => setExe(e.target.value)} placeholder="C:\Program Files\…\browser.exe，macOS 可以填 .app" />
        </label>
        <label>
          用户数据目录（可选）
          <input className="mono" value={userDataDir} onChange={(e) => setUserDataDir(e.target.value)} placeholder="下面有 Default、Profile 1 这些文件夹的目录" />
        </label>
        <p className="mcp-hint">路径都是网关这台电脑上的。只支持 Chromium 内核、能从 Chrome 应用商店装扩展的浏览器；填了用户数据目录才能检查扩展装没装、选用哪个配置。</p>
        {error && <div className="settings-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "添加中…" : "添加"}
          </button>
        </div>
      </form>
    </div>
  );
}
