import { useEffect, useState, type FormEvent } from "react";
import { desktop } from "../desktop";
import { api, type ProxyMode, type ProxySettingsInput, type ProxySettingsView, type ProxyTestResult } from "../api";
import { Select } from "./Select";

const MODES: { value: ProxyMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "off", label: "不使用" },
  { value: "manual", label: "手动设置" },
];

interface Draft {
  mode: ProxyMode;
  url: string;
  username: string;
  /** 新填的密码；空是不改 */
  password: string;
  /** 点了「清除」，保存时清掉已存的密码 */
  clearPassword: boolean;
  /** 不走代理的地址，一行一个 */
  noProxy: string;
}

const draftOf = (v: ProxySettingsView): Draft => ({ mode: v.mode, url: v.url, username: v.username, password: "", clearPassword: false, noProxy: v.noProxy.join("\n") });

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

function inputOf(d: Draft): ProxySettingsInput {
  return {
    mode: d.mode,
    url: d.url,
    username: d.username,
    ...(d.clearPassword || !d.username.trim() ? { password: "" } : d.password ? { password: d.password } : {}),
    noProxy: lines(d.noProxy),
  };
}

function dirtyOf(d: Draft, v: ProxySettingsView): boolean {
  const saved = draftOf(v);
  return (
    d.mode !== saved.mode ||
    d.url.trim() !== saved.url ||
    d.username.trim() !== saved.username ||
    Boolean(d.password) ||
    d.clearPassword ||
    lines(d.noProxy).join("\n") !== lines(saved.noProxy).join("\n")
  );
}

/**
 * 设置里的「网络代理」：模型请求、网关自己的请求、claude 子进程里的命令（Bash、MCP、git）走哪个代理。
 * 存在网关（gateway-proxy.json），见 gateway/src/net/proxy.ts 和 docs/proxy.md
 */
export function ProxyPage() {
  const [view, setView] = useState<ProxySettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProxyTestResult | null>(null);

  useEffect(() => {
    api.proxySettings().then(
      (v) => {
        setView(v);
        setDraft(draftOf(v));
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setSaved(false);
    setResult(null);
    setError(null);
  };

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft) return;
    setSaving(true);
    api
      .saveProxySettings(inputOf(draft))
      .then(
        (v) => {
          setView(v);
          setDraft(draftOf(v));
          setError(null);
          setSaved(true);
        },
        (err: Error) => setError(err.message),
      )
      .finally(() => setSaving(false));
  };

  const test = () => {
    if (!draft) return;
    setTesting(true);
    setResult(null);
    api
      .testProxy(inputOf(draft))
      .then(setResult, (err: Error) => setResult({ ok: false, target: "", via: null, error: err.message }))
      .finally(() => setTesting(false));
  };

  const dirty = view && draft ? dirtyOf(draft, view) : false;

  return (
    <div className="appearance proxy-page">
      <header className="settings-head">
        <div className="settings-title">
          <h1>网络代理</h1>
          <p>
            模型请求、网关自己的请求（模型列表、生成标题、连接器市场）、AI 运行的命令（Bash、MCP、git）、终端{desktop ? "，以及内置浏览器" : ""}走哪个代理。支持 HTTP、HTTPS、SOCKS5 代理；改了以后已经开着的终端不变，新开的才用新设置。
          </p>
        </div>
      </header>
      {error && <div className="settings-error">{error}</div>}

      {view && draft && (
        <form onSubmit={save}>
          <section className="appearance-section">
            <h2>代理</h2>
            <div className="appearance-card">
              <div className="appearance-row">
                <span className="appearance-row-text">
                  <span className="appearance-row-label">模式</span>
                  <span className="appearance-row-desc">{modeDesc(draft.mode, view)}</span>
                </span>
                <Select aria-label="代理模式" value={draft.mode} options={MODES} onChange={(v) => update({ mode: v as ProxyMode })} />
              </div>
              {draft.mode === "manual" && (
                <>
                  <div className="appearance-row proxy-field-row">
                    <label className="proxy-field">
                      <span className="appearance-row-label">代理地址</span>
                      <input
                        className="mono"
                        required
                        value={draft.url}
                        placeholder="http://127.0.0.1:7890"
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => update({ url: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="appearance-row proxy-field-row">
                    <label className="proxy-field">
                      <span className="appearance-row-label">用户名</span>
                      <input value={draft.username} placeholder="代理不需要认证就不填" autoComplete="off" spellCheck={false} onChange={(e) => update({ username: e.target.value })} />
                    </label>
                    <label className="proxy-field">
                      <span className="appearance-row-label">密码</span>
                      <span className="proxy-password">
                        <input
                          type="password"
                          value={draft.password}
                          disabled={!draft.username.trim()}
                          placeholder={draft.clearPassword ? "保存后清除" : view.hasPassword ? "已填写，输入新的可以替换" : ""}
                          autoComplete="new-password"
                          onChange={(e) => update({ password: e.target.value, clearPassword: false })}
                        />
                        {view.hasPassword && !draft.clearPassword && (
                          <button type="button" className="btn-small" onClick={() => update({ password: "", clearPassword: true })}>
                            清除
                          </button>
                        )}
                      </span>
                    </label>
                  </div>
                  <div className="appearance-row proxy-field-row">
                    <label className="proxy-field">
                      <span className="appearance-row-label">不走代理的地址</span>
                      <span className="appearance-row-desc">
                        一行一个域名或 IP，可以带端口；example.com 也包括它的子域名。本机地址 {view.fixedNoProxy.join("、")} 总是不走代理
                      </span>
                      <textarea className="mono" rows={3} value={draft.noProxy} spellCheck={false} placeholder={"*.corp.example.com\n10.0.0.5"} onChange={(e) => update({ noProxy: e.target.value })} />
                    </label>
                  </div>
                </>
              )}
              <div className="appearance-row">
                <span className="appearance-row-text">
                  <span className="appearance-row-label">{dirty ? "保存后生效" : "当前"}</span>
                  <span className="appearance-row-desc">
                    {dirty ? "正在运行的对话在这一轮结束后切换，其他的下一条消息就用新设置" : view.effective ? `经 ${view.effective}` : "直连"}
                  </span>
                </span>
                <span className="appearance-row-actions">
                  <button type="button" className="btn-small" disabled={testing} onClick={test}>
                    {testing ? "测试中…" : "测试连接"}
                  </button>
                  <button type="submit" className="primary" disabled={!dirty || saving}>
                    {saving ? "保存中…" : saved && !dirty ? "已保存" : "保存"}
                  </button>
                </span>
              </div>
              {result && (
                <div className="appearance-row">
                  <span className={`proxy-result ${result.ok ? "ok" : "failed"}`}>{resultText(result)}</span>
                </div>
              )}
            </div>
          </section>
        </form>
      )}
    </div>
  );
}

function modeDesc(mode: ProxyMode, view: ProxySettingsView): string {
  if (mode === "off") return "一律直连，环境变量里设的代理也不用";
  if (mode === "manual") return "用下面填的代理：http://、https:// 或 socks5:// 开头";
  const env = view.inherited ? `沿用网关启动时环境变量里的代理：${view.inherited}` : "网关启动时的环境变量（HTTPS_PROXY 等）里没有代理，现在是直连";
  const fallback = view.inherited ? `沿用网关启动时环境变量里的代理 ${view.inherited}` : "直连";
  const sys = view.system;
  // 桌面版没报过操作系统的代理（网页版、桌面版还没连上）：网关只能按环境变量
  if (!sys) return desktop ? `用操作系统的代理设置。桌面版还没报过来，暂时${fallback}` : `${env}。在桌面版里会用操作系统的代理设置`;
  if (sys.proxy) return `用操作系统的代理：${sys.proxy}`;
  if (sys.unusable) return `操作系统的代理是 ${sys.unusable}，只有内置浏览器能用（网关和 Claude Code 支持 HTTP、HTTPS、SOCKS5），它们${fallback}`;
  return view.inherited ? `操作系统没有设代理；${env}` : "操作系统和网关启动时的环境变量里都没有代理，现在是直连";
}

function resultText(r: ProxyTestResult): string {
  const how = r.via ? `经 ${r.via}` : "直连";
  // 测试请求不带模型接口的令牌，401、403 也说明网络是通的
  if (r.ok) return `连上了（${how}）：${r.target} 有响应（HTTP ${r.status}${r.status === 401 || r.status === 403 ? "，测试不带令牌" : ""}），用时 ${r.ms} ms`;
  // 代理本身的问题（连不上代理、407）说明里已经带着代理地址
  return r.via && r.error.includes(r.via) ? `测试失败：${r.error}` : `测试失败（${how}）：${r.error}`;
}
