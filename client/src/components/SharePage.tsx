import { useEffect, useState, type FormEvent } from "react";
import { api, type ShareFixResult, type ShareSettingsInput, type ShareSettingsView, type ShareTestResult } from "../api";
import { refreshShares } from "../state/shares";
import { refreshSshConnections, useSshConnections } from "../state/sshConnections";
import { Select } from "./Select";

interface Draft {
  /** 设置「SSH 连接」里的连接；空是不用公网分享 */
  connectionId: string;
  /** 新填的密码；空是不改 */
  password: string;
  /** 点了「清除」，保存时清掉已存的密码 */
  clearPassword: boolean;
  remotePort: string;
  publicHost: string;
}

const draftOf = (v: ShareSettingsView): Draft => ({
  connectionId: v.server.connectionId,
  password: "",
  clearPassword: false,
  remotePort: String(v.server.remotePort),
  publicHost: v.server.publicHost,
});

function inputOf(d: Draft): ShareSettingsInput {
  return {
    connectionId: d.connectionId,
    ...(d.clearPassword ? { password: "" } : d.password ? { password: d.password } : {}),
    remotePort: Number(d.remotePort),
    publicHost: d.publicHost.trim(),
  };
}

function dirtyOf(d: Draft, v: ShareSettingsView): boolean {
  const saved = draftOf(v);
  return (
    d.connectionId !== saved.connectionId ||
    Boolean(d.password) ||
    d.clearPassword ||
    d.remotePort.trim() !== saved.remotePort ||
    d.publicHost.trim() !== saved.publicHost
  );
}

/**
 * 设置里的「公网分享」：会话菜单「分享到公网」经哪台服务器出去（SSH 反向转发）。没配置时菜单里没有「分享到公网」。
 * 存在网关（gateway-share.json），见 gateway/src/share/share-settings.ts 和 docs/lan-share.md「公网分享」
 */
export function SharePage() {
  const [view, setView] = useState<ShareSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ShareTestResult | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<ShareFixResult | null>(null);

  useEffect(() => {
    api.shareSettings().then(
      (v) => {
        setView(v);
        setDraft(draftOf(v));
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  // 有公网分享、正在连的时候跟着刷新隧道状态
  const status = view?.tunnel.status;
  useEffect(() => {
    if (status !== "starting") return;
    const timer = setInterval(() => {
      api.shareSettings().then((v) => setView((prev) => (prev ? { ...prev, tunnel: v.tunnel } : v)), () => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [status]);

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setSaved(false);
    setResult(null);
    setFixResult(null);
    setError(null);
  };

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft) return;
    setSaving(true);
    api
      .saveShareSettings(inputOf(draft))
      .then(
        (v) => {
          setView(v);
          setDraft(draftOf(v));
          setError(null);
          setSaved(true);
          // 侧栏的公网链接跟着新的隧道地址
          void refreshShares();
        },
        (err: Error) => setError(err.message),
      )
      .finally(() => setSaving(false));
  };

  const test = (keepFix = false) => {
    if (!draft) return;
    setTesting(true);
    setResult(null);
    if (!keepFix) setFixResult(null);
    api
      .testShareServer(inputOf(draft))
      .then(
        (r) => {
          setResult(r);
          // 测的是公网分享在用的服务器时，下面「当前」的状态也跟着变了
          void api.shareSettings().then((v) => setView((prev) => (prev ? { ...prev, tunnel: v.tunnel } : v)), () => undefined);
        },
        (err: Error) => setResult({ ok: false, error: err.message }),
      )
      .finally(() => setTesting(false));
  };

  /** 在服务器上开启 GatewayPorts，成功后接着测一次 */
  const fixGatewayPorts = () => {
    if (!draft) return;
    setFixing(true);
    setFixResult(null);
    api
      .fixShareGatewayPorts(inputOf(draft))
      .then(
        (r) => {
          setFixResult(r);
          if (r.ok) test(true);
          // 有公网分享时网关已经按新配置重新连了
          void api.shareSettings().then((v) => setView((prev) => (prev ? { ...prev, tunnel: v.tunnel } : v)), () => undefined);
        },
        (err: Error) => setFixResult({ ok: false, error: err.message }),
      )
      .finally(() => setFixing(false));
  };

  const dirty = view && draft ? dirtyOf(draft, view) : false;
  // 测试连接、或者公网分享的转发报了「端口只开在服务器的 127.0.0.1 上」：给一键开启的按钮
  const canFix = result ? !result.ok && result.fix === "gatewayPorts" : !dirty && view?.tunnel.status === "error" && view.tunnel.fix === "gatewayPorts";
  const connections = useSshConnections();
  useEffect(() => {
    void refreshSshConnections();
  }, []);
  const filled = Boolean(draft?.connectionId);
  const picked = connections.find((c) => c.id === draft?.connectionId);
  const passwordInput = draft && view && (
    <span className="proxy-password">
      <input
        type="password"
        value={draft.password}
        placeholder={draft.clearPassword ? "保存后清除" : view.server.hasPassword ? "已填写，输入新的可以替换" : "用私钥登录就不填"}
        autoComplete="new-password"
        onChange={(e) => update({ password: e.target.value, clearPassword: false })}
      />
      {view.server.hasPassword && !draft.clearPassword && (
        <button type="button" className="btn-small" onClick={() => update({ password: "", clearPassword: true })}>
          清除
        </button>
      )}
    </span>
  );
  const connectionOptions = [
    { value: "", label: "不用公网分享" },
    ...connections.map((c) => ({ value: c.id, label: c.name })),
    // 选的连接被删了：留着这一项，免得显示成不用公网分享
    ...(draft?.connectionId && !picked ? [{ value: draft.connectionId, label: "（已删除的连接）" }] : []),
  ];

  return (
    <div className="appearance proxy-page">
      <header className="settings-head">
        <div className="settings-title">
          <h1>公网分享</h1>
          <p>
            选一台有公网地址的服务器（在「SSH 连接」里添加）后，会话菜单里才有「分享到公网」。分享时网关 SSH 登录服务器，在服务器上开一个端口转到本机（同 ssh -R），访客打开 http://&lt;服务器&gt;:&lt;公网端口&gt;/share/… 进来。选「不用公网分享」后保存，就停掉所有公网分享。
          </p>
        </div>
      </header>
      {error && <div className="settings-error">{error}</div>}

      {view && draft && (
        <form onSubmit={save}>
          <section className="appearance-section">
            <h2>服务器</h2>
            <div className="appearance-card">
              <div className="appearance-row">
                <span className="appearance-row-text">
                  <span className="appearance-row-label">SSH 连接</span>
                  <span className="appearance-row-desc">
                    {draft.connectionId
                      ? picked
                        ? `${picked.address ?? picked.host}：地址、账号、密钥、跳板都按这个连接的配置；主机密钥要在「SSH 连接」里信任过`
                        : "这个连接已经在「SSH 连接」里删掉了，重新选一个"
                      : "用设置「SSH 连接」里的哪个连接；服务器要先在那里添加、连上一次确认主机密钥"}
                  </span>
                </span>
                <Select aria-label="用哪个 SSH 连接" value={draft.connectionId} options={connectionOptions} onChange={(v) => update({ connectionId: v })} />
              </div>
              {filled && (
                <div className="appearance-row proxy-field-row">
                  <label className="proxy-field">
                    <span className="appearance-row-label">密码</span>
                    <span className="appearance-row-desc">选填：这个连接用密钥、ssh-agent 登录不了时填；不填时用这次在「SSH 连接」里输入过的密码</span>
                    {passwordInput}
                  </label>
                </div>
              )}
              <div className="appearance-row proxy-field-row">
                <label className="proxy-field share-port-field">
                  <span className="appearance-row-label">公网端口</span>
                  <span className="appearance-row-desc">服务器上对外开的端口</span>
                  <input className="mono" required inputMode="numeric" value={draft.remotePort} onChange={(e) => update({ remotePort: e.target.value })} />
                </label>
                <label className="proxy-field">
                  <span className="appearance-row-label">链接里的地址</span>
                  <span className="appearance-row-desc">选填，有域名时填；不填用服务器地址</span>
                  <input className="mono" value={draft.publicHost} placeholder={picked?.address?.replace(/^.*@/, "").replace(/:\d+$/, "") || "share.example.com"} spellCheck={false} autoComplete="off" onChange={(e) => update({ publicHost: e.target.value })} />
                </label>
              </div>
              <div className="appearance-row">
                <span className="appearance-row-text">
                  <span className="appearance-row-desc">
                    服务器的 sshd 默认只把转发的端口开在服务器自己的 127.0.0.1 上，外网打不开：要在 /etc/ssh/sshd_config 里加 <code>GatewayPorts clientspecified</code>（或 yes）并重启 sshd，防火墙、云服务器的安全组也要放行公网端口。
                  </span>
                </span>
              </div>
            </div>
          </section>

          <section className="appearance-section">
            <div className="appearance-card">
              <div className="appearance-row">
                <span className="appearance-row-text">
                  <span className="appearance-row-label">{dirty ? "保存后生效" : "当前"}</span>
                  <span className={`appearance-row-desc ${dirty ? "" : view.tunnel.status === "error" ? "proxy-failed" : view.tunnel.status === "ready" ? "proxy-ok" : ""}`}>{dirty ? (filled ? "正在公网分享的会话会按新设置重新连，公网地址变了的话之前发出去的链接打不开" : "保存后停掉所有公网分享，会话菜单里不再显示「分享到公网」") : tunnelText(view)}</span>
                </span>
                <span className="appearance-row-actions">
                  {filled && (
                    <button type="button" className="btn-small" disabled={testing || fixing} onClick={() => test()}>
                      {testing ? "测试中…" : "测试连接"}
                    </button>
                  )}
                  <button type="submit" className="primary" disabled={!dirty || saving}>
                    {saving ? "保存中…" : saved && !dirty ? "已保存" : "保存"}
                  </button>
                </span>
              </div>
              {fixResult && (
                <div className="appearance-row">
                  <span className="appearance-row-text">
                    <span className={`proxy-result ${fixResult.ok ? "ok" : "failed"}`}>{fixResult.ok ? `${fixResult.message}${testing ? "，正在重新测试…" : ""}` : fixResult.error}</span>
                    {!fixResult.ok && fixResult.manual && <pre className="share-manual">{fixResult.manual}</pre>}
                  </span>
                </div>
              )}
              {result && (
                <div className="appearance-row">
                  <span className={`proxy-result ${result.ok ? "ok" : "failed"}`}>{result.ok ? `连通了：访客打开 ${result.url}/share/… 就能进来` : result.error}</span>
                </div>
              )}
              {canFix && !(fixResult && !fixResult.ok) && (
                <div className="appearance-row">
                  <span className="appearance-row-text">
                    <span className="appearance-row-label">在服务器上开启 GatewayPorts</span>
                    <span className="appearance-row-desc">
                      用这个账号的 sudo（要免密）在服务器上新建 /etc/ssh/sshd_config.d/99-claude-app.conf，写入 GatewayPorts clientspecified，sshd -t 检查通过后重启 sshd（已经连着的 SSH 不会断）。安全组要在云服务器的控制台里放行，这里改不了
                    </span>
                  </span>
                  <button type="button" className="primary" disabled={fixing || testing} onClick={fixGatewayPorts}>
                    {fixing ? "开启中…" : "开启"}
                  </button>
                </div>
              )}
            </div>
          </section>
        </form>
      )}
    </div>
  );
}

function tunnelText(v: ShareSettingsView): string {
  const t = v.tunnel;
  if (t.status === "ready") return `公网地址 ${t.url}`;
  if (t.status === "starting") return "正在连服务器…";
  if (t.status === "error") return t.error ?? "没连上";
  return v.configured ? "没有公网分享" : "没配置，会话菜单里不显示「分享到公网」";
}
