import { useEffect, useState, type FormEvent } from "react";
import { api, type ConnectorEntry, type McpServerInfo } from "../api";
import { Avatar } from "./CapabilityPicker";
import { McpAuthDialog } from "./McpAuthDialog";
import { PAGE_SIZE, Pager, pageOf } from "./Pager";
import { Select } from "./Select";

/**
 * 设置 → 连接器 → 连接器市场：MCP 官方注册表里有远程地址的服务器。不搜索时是网关配置里推荐的，搜索时查整个注册表。
 * 添加后直接进入登录（不用登录的连上就关掉）；要填请求头、地址变量的先填表。
 * 卡片网格，每页 PAGE_SIZE 个；搜索结果网关一次给 100 条，翻到取回来的最后一页再往后时取下一批
 */
export function ConnectorDirectory({ search, servers, onChanged }: { search: string; servers: McpServerInfo[]; onChanged: () => void }) {
  const [entries, setEntries] = useState<ConnectorEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filling, setFilling] = useState<ConnectorEntry | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(0);

  // 搜索词停下来 400ms 再查
  const keyword = search.trim();
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(
      () =>
        api
          .connectors(keyword || undefined)
          .then(
            (page) => {
              if (cancelled) return;
              setEntries(page.connectors);
              setNextCursor(page.nextCursor);
              setPage(0);
              setError(null);
            },
            (e: Error) => !cancelled && setError(e.message),
          )
          .finally(() => !cancelled && setLoading(false)),
      keyword ? 400 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [keyword, reload]);

  const more = () => {
    if (!nextCursor) return Promise.resolve();
    setLoading(true);
    return api
      .connectors(keyword, nextCursor)
      .then(
        (page) => {
          setEntries((prev) => [...(prev ?? []), ...page.connectors.filter((c) => !prev?.some((p) => p.id === c.id))]);
          setNextCursor(page.nextCursor);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setLoading(false));
  };

  const turn = (next: number) => {
    if (entries && next * PAGE_SIZE >= entries.length && nextCursor) void more().then(() => setPage(next));
    else setPage(next);
  };

  const added = (name: string) => {
    setFilling(null);
    setSigningIn(name);
  };

  const add = (entry: ConnectorEntry) => {
    if (entry.headers.length || entry.variables.length) return setFilling(entry);
    setAdding(entry.id);
    api
      .addConnector({ id: entry.id })
      .then(added, (e: Error) => setError(e.message))
      .finally(() => setAdding(null));
  };

  const status = (name: string) => servers.find((s) => s.name === name)?.status;
  /** 已经有的服务器：从连接器市场添加的，或者地址相同的（插件带来的、手动添加的），免得重复添加 */
  const existing = (entry: ConnectorEntry) => entry.added ?? servers.find((s) => s.target === entry.url)?.name;

  return (
    <>
      {error && <div className="settings-error">{error}</div>}
      {entries && entries.length > 0 ? (
        <div className={`market-grid${loading ? " loading" : ""}`} aria-busy={loading}>
          {pageOf(entries, page).map((entry) => {
            const name = existing(entry);
            return (
              <div key={entry.id} className="market-card">
                <div className="market-card-head">
                  <ConnectorIcon name={entry.title} icon={entry.icon} />
                  <div className="market-card-title" title={entry.title}>
                    {entry.title}
                  </div>
                </div>
                <div className="market-card-desc" title={entry.description}>
                  {entry.description}
                </div>
                <div className="market-card-meta market-card-target">
                  <div title={entry.id}>{entry.id}</div>
                  <div title={entry.url}>{entry.url}</div>
                </div>
                <div className="market-card-foot">
                  {entry.type === "sse" ? <span className="settings-tag">SSE</span> : <span />}
                  {name ? (
                    status(name) === "needs-auth" ? (
                      <button className="primary" title={`已添加为 ${name}，需要登录`} onClick={() => setSigningIn(name)}>
                        登录
                      </button>
                    ) : (
                      <span className="connector-added" title={`已添加为 ${name}`}>
                        已添加
                      </span>
                    )
                  ) : (
                    <button className="primary" disabled={adding === entry.id} onClick={() => add(entry)}>
                      {adding === entry.id ? "添加中…" : "添加"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="settings-empty">{loading || !entries ? "加载中…" : keyword ? "注册表里没有匹配的连接器" : "没有推荐的连接器，搜索试试"}</div>
      )}
      {entries && entries.length > 0 && <Pager page={page} total={entries.length} hasMore={nextCursor !== undefined} loading={loading} onPage={turn} />}
      {filling && <ConnectorForm entry={filling} onAdded={added} onCancel={() => setFilling(null)} />}
      {signingIn && (
        <McpAuthDialog
          name={signingIn}
          onClose={() => {
            setSigningIn(null);
            setReload((n) => n + 1);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/** 注册表里的图标（只有一部分有），没有或加载不了时用首字母 */
export function ConnectorIcon({ name, icon }: { name: string; icon?: string }) {
  const [broken, setBroken] = useState(false);
  if (!icon || broken) return <Avatar name={name} />;
  return <img className="capability-avatar connector-icon" src={icon} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

/** 要填请求头（API 密钥等）或地址变量的连接器：先填表再添加 */
function ConnectorForm({ entry, onAdded, onCancel }: { entry: ConnectorEntry; onAdded: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(entry.suggestedName);
  const [variables, setVariables] = useState<Record<string, string>>(() => Object.fromEntries(entry.variables.map((v) => [v.name, v.default ?? ""])));
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    api
      .addConnector({ id: entry.id, name: name.trim(), variables, headers })
      .then(onAdded, (err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog settings-form mcp-dialog" aria-label={`添加 ${entry.title}`} onSubmit={submit}>
        <h3>添加 {entry.title}</h3>
        <label>
          名称
          <input required value={name} onChange={(e) => setName(e.target.value)} pattern="[\w\-]+" title="字母、数字、下划线和连字符" />
        </label>
        {entry.variables.map((v) => (
          <label key={v.name}>
            {v.name}
            {v.required ? "" : "（可选）"}
            {v.choices ? (
              <Select
                value={variables[v.name] ?? ""}
                aria-label={v.name}
                onChange={(value) => setVariables((prev) => ({ ...prev, [v.name]: value }))}
                options={[...(v.required ? [] : [{ value: "", label: "不填" }]), ...v.choices.map((c) => ({ value: c, label: c }))]}
              />
            ) : (
              <input
                required={v.required}
                value={variables[v.name] ?? ""}
                onChange={(e) =>
                  setVariables((prev) => ({
                    ...prev,
                    [v.name]: e.target.value,
                  }))
                }
              />
            )}
            {v.description && <span className="mcp-hint">{v.description}</span>}
          </label>
        ))}
        {entry.headers.map((h) => (
          <label key={h.name}>
            请求头 {h.name}
            {h.required ? "" : "（可选）"}
            <input
              className="mono"
              type={h.secret ? "password" : "text"}
              autoComplete="off"
              required={h.required}
              value={headers[h.name] ?? ""}
              placeholder={h.default ?? (h.name.toLowerCase() === "authorization" ? "Bearer …" : undefined)}
              onChange={(e) => setHeaders((prev) => ({ ...prev, [h.name]: e.target.value }))}
            />
            {h.description && <span className="mcp-hint">{h.description}</span>}
          </label>
        ))}
        {entry.headers.some((h) => !h.required) && <p className="mcp-hint">可选的请求头不填时，添加后会尝试用 OAuth 登录。</p>}
        {error && <div className="settings-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
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
