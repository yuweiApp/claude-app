import { useEffect, useRef, useState, type FormEvent } from "react";
import { desktop } from "../desktop";
import { api, type ProxyMode, type ProxyNodes, type ProxySettingsInput, type ProxySettingsView, type ProxyTestResult } from "../api";
import { Select } from "./Select";

const MODES: { value: ProxyMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "off", label: "不使用" },
  { value: "manual", label: "手动设置" },
  { value: "subscription", label: "订阅" },
];

/** 自动更新订阅的间隔（小时） */
const INTERVALS = [6, 12, 24];

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
  /** 新填的订阅地址；空是不改（已存的地址网关不回给网页） */
  subscriptionUrl: string;
  /** 点了「清除」，保存时清掉已存的订阅地址 */
  clearSubscription: boolean;
  /** 自动更新订阅的间隔（小时） */
  interval: number;
}

const draftOf = (v: ProxySettingsView): Draft => ({
  mode: v.mode,
  url: v.url,
  username: v.username,
  password: "",
  clearPassword: false,
  noProxy: v.noProxy.join("\n"),
  subscriptionUrl: "",
  clearSubscription: false,
  interval: v.subscription.intervalHours,
});

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
    ...(d.subscriptionUrl.trim() ? { subscriptionUrl: d.subscriptionUrl.trim() } : d.clearSubscription ? { subscriptionUrl: "" } : {}),
    ...(d.mode === "subscription" ? { subscriptionInterval: d.interval } : {}),
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
    lines(d.noProxy).join("\n") !== lines(saved.noProxy).join("\n") ||
    Boolean(d.subscriptionUrl.trim()) ||
    d.clearSubscription ||
    (d.mode === "subscription" && d.interval !== saved.interval)
  );
}

/**
 * 设置里的「网络代理」：模型请求、网关自己的请求、claude 子进程里的命令（Bash、MCP、git）走哪个代理。
 * 存在网关（gateway-proxy.json），见 gateway/src/net/proxy.ts 和 docs/proxy.md。
 * 订阅模式（docs/proxy-subscription.md）：只填订阅链接，网关拉起代理内核连订阅里的节点；
 * 存好以后下面多一节「订阅」：订阅信息、节点列表（选中马上生效，不经「保存」）、测延迟、立即更新
 */
export function ProxyPage() {
  const [view, setView] = useState<ProxySettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProxyTestResult | null>(null);
  /** 订阅的节点和信息；代理内核没在跑时是 null */
  const [nodes, setNodes] = useState<ProxyNodes | null>(null);
  /** 正在做的节点操作：选节点、测延迟、更新订阅 */
  const [busy, setBusy] = useState<"select" | "delay" | "update" | null>(null);
  const [nodesError, setNodesError] = useState<string | null>(null);
  /** 保存、节点操作开始和有结果时各加一：在这之前发出的轮询结果是旧的，不用 */
  const epoch = useRef(0);

  useEffect(() => {
    api.proxySettings().then(
      (v) => {
        setView(v);
        setDraft(draftOf(v));
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  // 存的是订阅模式时轮询内核状态和节点：启动中、出错时 2 秒一次，跑起来以后 10 秒一次（延迟、订阅信息会自己变）
  const live = view?.mode === "subscription" && view.subscription.hasUrl;
  const coreState = view?.subscription.core.state;
  useEffect(() => {
    if (!live) {
      setNodes(null);
      setNodesError(null);
      return;
    }
    let stopped = false;
    const poll = async () => {
      const at = epoch.current;
      try {
        const v = await api.proxySettings();
        const n = v.subscription.core.state === "running" ? await api.proxyNodes().catch(() => null) : null;
        if (stopped || at !== epoch.current) return;
        setView(v);
        setNodes(n);
      } catch {
        // 网关暂时连不上（正在重启）：下一次再试
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), coreState === "running" ? 10_000 : 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [live, coreState]);

  /** 节点操作：返回的是操作之后的节点列表 */
  const nodeAction = (kind: "select" | "delay" | "update", run: () => Promise<ProxyNodes>) => {
    epoch.current++;
    setBusy(kind);
    setNodesError(null);
    run()
      .then(
        (n) => {
          epoch.current++;
          setNodes(n);
        },
        (err: Error) => setNodesError(err.message),
      )
      .finally(() => setBusy(null));
  };

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setSaved(false);
    setResult(null);
    setError(null);
  };

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft) return;
    epoch.current++;
    setSaving(true);
    api
      .saveProxySettings(inputOf(draft))
      .then(
        (v) => {
          epoch.current++;
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
            模型请求、网关自己的请求（模型列表、生成标题、连接器市场）、AI 运行的命令（Bash、MCP、git）、终端{desktop ? "，以及内置浏览器" : ""}走哪个代理。支持 HTTP、HTTPS、SOCKS5 代理，也可以只填订阅链接；改了以后已经开着的终端不变，新开的才用新设置。
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
                </>
              )}
              {draft.mode === "subscription" && (
                <>
                  <div className="appearance-row proxy-field-row">
                    <label className="proxy-field">
                      <span className="appearance-row-label">订阅地址</span>
                      <span className="appearance-row-desc">订阅地址就是凭证，拿到的人都能用你的节点；只存在网关这台电脑上，保存后这里不再显示</span>
                      <span className="proxy-password">
                        <input
                          className="mono"
                          type="password"
                          required={!view.subscription.hasUrl || draft.clearSubscription}
                          value={draft.subscriptionUrl}
                          placeholder={draft.clearSubscription ? "保存后清除；要继续用订阅就填新的地址" : view.subscription.hasUrl ? "已填写，输入新的可以替换" : "https://…"}
                          spellCheck={false}
                          autoComplete="new-password"
                          onChange={(e) => update({ subscriptionUrl: e.target.value, clearSubscription: false })}
                        />
                        {view.subscription.hasUrl && !draft.clearSubscription && (
                          <button type="button" className="btn-small" onClick={() => update({ subscriptionUrl: "", clearSubscription: true })}>
                            清除
                          </button>
                        )}
                      </span>
                    </label>
                  </div>
                  <div className="appearance-row">
                    <span className="appearance-row-text">
                      <span className="appearance-row-label">自动更新</span>
                      <span className="appearance-row-desc">每隔多久重新拉一次订阅</span>
                    </span>
                    <Select
                      aria-label="自动更新订阅的间隔"
                      value={String(draft.interval)}
                      options={[...new Set([...INTERVALS, draft.interval, view.subscription.intervalHours])].sort((a, b) => a - b).map((h) => ({ value: String(h), label: `${h} 小时` }))}
                      onChange={(v) => update({ interval: Number(v) })}
                    />
                  </div>
                  <div className="appearance-row">
                    <span className="appearance-row-text">
                      <span className="appearance-row-label">代理内核</span>
                      <span className={`appearance-row-desc ${coreTone(view)}`}>{coreText(view)}</span>
                    </span>
                  </div>
                </>
              )}
              {(draft.mode === "manual" || draft.mode === "subscription") && (
                <div className="appearance-row proxy-field-row">
                  <label className="proxy-field">
                    <span className="appearance-row-label">不走代理的地址</span>
                    <span className="appearance-row-desc">
                      一行一个域名或 IP，可以带端口；example.com 也包括它的子域名。本机地址 {view.fixedNoProxy.join("、")} 总是不走代理
                    </span>
                    <textarea className="mono" rows={3} value={draft.noProxy} spellCheck={false} placeholder={"*.corp.example.com\n10.0.0.5"} onChange={(e) => update({ noProxy: e.target.value })} />
                  </label>
                </div>
              )}
              <div className="appearance-row">
                <span className="appearance-row-text">
                  <span className="appearance-row-label">{dirty ? "保存后生效" : "当前"}</span>
                  <span className="appearance-row-desc">
                    {dirty ? "正在运行的对话在这一轮结束后切换，其他的下一条消息就用新设置" : view.effective ? `经 ${effectiveText(view, nodes)}` : "直连"}
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

      {view && draft?.mode === "subscription" && live && (
        <section className="appearance-section">
          <h2>订阅</h2>
          {nodesError && <div className="settings-error">{nodesError}</div>}
          <div className="appearance-card">
            <div className="appearance-row">
              <span className="appearance-row-text">
                <span className="appearance-row-label">订阅信息</span>
                <span className="appearance-row-desc">{nodes ? subscriptionText(nodes) : "代理内核运行起来以后显示"}</span>
              </span>
              <button type="button" className="btn-small" disabled={!nodes || busy !== null} onClick={() => nodeAction("update", api.updateProxySubscription)}>
                {busy === "update" ? "更新中…" : "立即更新"}
              </button>
            </div>
            <div className="appearance-row">
              <span className="appearance-row-text">
                <span className="appearance-row-label">节点</span>
                <span className="appearance-row-desc">选中马上生效，不用点保存；正在进行的请求会断开重连</span>
              </span>
              <button type="button" className="btn-small" disabled={!nodes?.nodes.length || busy !== null} onClick={() => nodeAction("delay", api.testProxyNodes)}>
                {busy === "delay" ? "测试中…" : "测延迟"}
              </button>
            </div>
            {nodes && (
              <div className="proxy-nodes" role="radiogroup" aria-label="节点">
                <NodeRow name="自动" hint="选延迟最低的" checked={nodes.selected === null} disabled={busy !== null} onSelect={() => nodeAction("select", () => api.selectProxyNode(null))} />
                {nodes.nodes.map((n) => (
                  <NodeRow
                    key={n.name}
                    name={n.name}
                    hint={n.type}
                    delay={n.delay !== null ? `${n.delay} ms` : n.alive ? "没测过" : "超时"}
                    tone={n.delay !== null ? "ok" : n.alive ? "" : "failed"}
                    checked={nodes.selected === n.name}
                    disabled={busy !== null}
                    onSelect={() => nodeAction("select", () => api.selectProxyNode(n.name))}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** 节点列表的一行：单选 */
function NodeRow({ name, hint, delay, tone, checked, disabled, onSelect }: { name: string; hint: string; delay?: string; tone?: string; checked: boolean; disabled: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className={`proxy-node${checked ? " checked" : ""}`} disabled={disabled} onClick={() => !checked && onSelect()}>
      <span className="proxy-node-dot" />
      <span className="proxy-node-name">{name}</span>
      <span className="proxy-node-hint">{hint}</span>
      {delay && <span className={`proxy-node-delay ${tone ?? ""}`}>{delay}</span>}
    </button>
  );
}

/** 「当前」一行：订阅模式带上现在用的节点 */
function effectiveText(view: ProxySettingsView, nodes: ProxyNodes | null): string {
  if (view.mode !== "subscription" || !nodes) return view.effective ?? "";
  return `${view.effective}（${nodes.selected ?? "自动选节点"}）`;
}

/** 代理内核的状态；存的还不是订阅模式时内核不跑，只在没找到内核时提示（这时保存不了） */
function coreText(view: ProxySettingsView): string {
  const core = view.subscription.core;
  if (core.state === "missing") return core.error ?? "没有找到代理内核";
  if (view.mode !== "subscription") return "保存后启动：网关在本机拉起代理内核 mihomo，由它连订阅里的节点";
  if (core.state === "running") return `运行中（mihomo ${core.version ?? ""}）${core.error ? `。${core.error}` : ""}`;
  if (core.state === "starting") return "启动中…";
  if (core.state === "error") return `出错了，正在自动重试：${core.error ?? "原因不明"}`;
  return "没有运行";
}

function coreTone(view: ProxySettingsView): string {
  const core = view.subscription.core;
  if (core.state === "missing" || core.state === "error") return "proxy-failed";
  if (view.mode === "subscription" && core.state === "running") return core.error ? "proxy-warn" : "proxy-ok";
  return "";
}

/** 节点数、流量、到期时间、上次更新时间；流量和到期时间订阅没给就不写 */
function subscriptionText(nodes: ProxyNodes): string {
  const s = nodes.subscription;
  const parts = [nodes.nodes.length ? `${nodes.nodes.length} 个节点` : "没有节点"];
  if (s.upload !== undefined || s.download !== undefined) parts.push(`已用 ${bytes((s.upload ?? 0) + (s.download ?? 0))} / ${s.total ? bytes(s.total) : "不限"}`);
  if (s.expire !== undefined) parts.push(s.expire ? `${dateText(s.expire).slice(0, 10)} 到期` : "不过期");
  parts.push(s.updatedAt ? `上次更新 ${dateText(s.updatedAt)}` : "还没有拉到过订阅");
  return parts.join(" · ");
}

/** 2026-11-14 23:45（本地时间） */
function dateText(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(n >= 10 ? 1 : 2)} ${units[i]}`;
}

function modeDesc(mode: ProxyMode, view: ProxySettingsView): string {
  if (mode === "off") return "一律直连，环境变量里设的代理也不用";
  if (mode === "manual") return "用下面填的代理：http://、https:// 或 socks5:// 开头";
  if (mode === "subscription") return "只填订阅链接：网关在本机拉起代理内核，连订阅里的节点（VLESS、VMess、Trojan、Shadowsocks 等），所有请求都经它出去";
  const env = view.inherited ? `沿用网关启动时环境变量里的代理：${view.inherited}` : "网关启动时的环境变量（HTTPS_PROXY 等）里没有代理，现在是直连";
  const fallback = view.inherited ? `沿用网关启动时环境变量里的代理 ${view.inherited}` : "直连";
  const sys = view.system;
  // 桌面版没连着网关（网页版单独用、桌面版关了）、还没报过操作系统的代理：网关只能按环境变量
  if (!sys) return desktop ? `用操作系统的代理设置。桌面版还没报过来，暂时${fallback}` : `${env}。桌面版开着时会用操作系统的代理设置`;
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
