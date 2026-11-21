import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type ConnectorEntry, type ConnectorSource, type McpServerInfo } from "../api";
import { Avatar } from "./CapabilityPicker";
import { Card, CardGrid } from "./CardGrid";
import { DirectoryLoading } from "./DirectoryLoading";
import { McpAuthDialog } from "./McpAuthDialog";
import { Pager, pageOf, PROBE_SIZE, useFitPageSize } from "./Pager";
import { Select } from "./Select";

/** Claude 目录的分类（目录里是英文标识）；没列的显示原样 */
const CATEGORY_LABELS: Record<string, string> = {
  productivity: "效率",
  "business-productivity": "商务效率",
  "data-analytics": "数据分析",
  data: "数据",
  "financial-services": "金融服务",
  "sales-and-marketing": "销售与营销",
  "developer-tools": "开发工具",
  code: "代码",
  communication: "沟通协作",
  legal: "法律",
  creative: "创意",
  design: "设计",
  "commerce-shopping": "购物",
  "e-commerce": "电商",
  education: "教育",
  "media-entertainment": "媒体娱乐",
  travel: "旅行",
  "health-life-sciences": "医疗与生命科学",
  "life-sciences": "生命科学",
  health: "健康",
  healthcare: "医疗",
  "consumer-health": "个人健康",
  nonprofit: "非营利",
  technology: "技术",
  other: "其他",
};
const categoryLabel = (c: string) => CATEGORY_LABELS[c] ?? c;

const SOURCE_OPTIONS: { value: ConnectorSource; label: string }[] = [
  { value: "directory", label: "Claude 目录" },
  { value: "registry", label: "MCP 注册表" },
];

const REVIEW_LABELS = { anthropic: "Anthropic", partner: "合作伙伴" } as const;

/**
 * 设置 → 连接器 → 连接器市场，布局同插件市场（顶部总数、来源、分类，卡片网格，底部页码）。两个来源：
 * - Claude 目录（默认）：claude.ai 上的连接器目录，搜索、分类、分页由网关做，每次只取当前这一页和总数。
 * - MCP 注册表：不搜索时是网关配置里推荐的，搜索时查整个注册表；网关一次给 100 条，翻到取回来的最后一页再往后时取下一批。
 * 添加后直接进入登录（不用登录的连上就关掉）；要选地址、填地址、填请求头、地址变量的先填表。
 * 每页的个数第一次显示时按可见区域算（useFitPageSize）
 */
export function ConnectorDirectory({ search, servers, onChanged }: { search: string; servers: McpServerInfo[]; onChanged: () => void }) {
  const [source, setSource] = useState<ConnectorSource>("directory");
  const [category, setCategory] = useState("");
  const [entries, setEntries] = useState<ConnectorEntry[] | null>(null);
  /** Claude 目录：筛过之后的总数和所有分类 */
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  /** MCP 注册表：下一批的游标 */
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filling, setFilling] = useState<ConnectorEntry | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(0);
  // 每页条数：第一次显示时按可见区域算（见 useFitPageSize），算出来之前先显示 PROBE_SIZE 条用来量。
  // Claude 目录的请求里用 ref 读，算出来时不重新取：第一页已经取回来的够了，只是少显示一些
  const gridRef = useRef<HTMLDivElement>(null);
  const size = useFitPageSize(gridRef, (entries?.length ?? 0) > 0) ?? PROBE_SIZE;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  // 搜索词停下来 300ms 再查，回到第一页
  const [keyword, setKeyword] = useState(search.trim());
  useEffect(() => {
    const next = search.trim();
    const timer = setTimeout(() => {
      setKeyword(next);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Claude 目录：网关筛好只返回这一页，翻页、换条件时再取
  useEffect(() => {
    if (source !== "directory") return;
    let cancelled = false;
    setLoading(true);
    api
      .connectors({ source, search: keyword, category, offset: page * sizeRef.current, limit: sizeRef.current })
      .then(
        (result) => {
          if (cancelled) return;
          setEntries(result.connectors);
          setTotal(result.total ?? result.connectors.length);
          setCategories(result.categories ?? []);
          setError(null);
        },
        (e: Error) => !cancelled && setError(e.message),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [source, keyword, category, page, reload]);

  // MCP 注册表：搜索词变了从第一批取起，翻页在取回来的里面翻
  useEffect(() => {
    if (source !== "registry") return;
    let cancelled = false;
    setLoading(true);
    api
      .connectors({ source, search: keyword })
      .then(
        (result) => {
          if (cancelled) return;
          setEntries(result.connectors);
          setNextCursor(result.nextCursor);
          setPage(0);
          setError(null);
        },
        (e: Error) => !cancelled && setError(e.message),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [source, keyword, reload]);

  const more = () => {
    if (!nextCursor) return Promise.resolve();
    setLoading(true);
    return api
      .connectors({ source: "registry", search: keyword, cursor: nextCursor })
      .then(
        (result) => {
          setEntries((prev) => [...(prev ?? []), ...result.connectors.filter((c) => !prev?.some((p) => p.id === c.id))]);
          setNextCursor(result.nextCursor);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setLoading(false));
  };

  const turn = (next: number) => {
    if (source === "registry" && entries && next * size >= entries.length && nextCursor) void more().then(() => setPage(next));
    else setPage(next);
  };

  const switchSource = (next: string) => {
    setSource(next as ConnectorSource);
    setEntries(null);
    setCategory("");
    setNextCursor(undefined);
    setPage(0);
  };

  const added = (name: string) => {
    setFilling(null);
    setSigningIn(name);
  };

  const add = (entry: ConnectorEntry) => {
    if (entry.headers.length || entry.variables.length || entry.urlOptions || entry.urlPattern) return setFilling(entry);
    setAdding(entry.id);
    api
      .addConnector({ id: entry.id, source: entry.source })
      .then(added, (e: Error) => setError(e.message))
      .finally(() => setAdding(null));
  };

  const status = (name: string) => servers.find((s) => s.name === name)?.status;
  /** 已经有的服务器：从连接器市场添加的，或者地址相同的（插件带来的、手动添加的），免得重复添加 */
  const existing = (entry: ConnectorEntry) => {
    const urls = entry.urlOptions?.map((o) => o.url) ?? (entry.url ? [entry.url] : []);
    return entry.added ?? servers.find((s) => s.target && urls.includes(s.target))?.name;
  };

  const shown = source === "directory" ? (entries ?? []).slice(0, size) : pageOf(entries ?? [], page, size);
  const count =
    source === "directory"
      ? `${total} 个连接器`
      : keyword
        ? `${entries?.length ?? 0}${nextCursor ? "+" : ""} 个连接器`
        : `推荐的 ${entries?.length ?? 0} 个连接器，搜索时查整个注册表`;

  return (
    <>
      {error && <div className="settings-error">{error}</div>}
      <div className="plugin-directory-bar">
        <span>
          {entries ? count : ""}
          {loading && entries && <span className="plugin-directory-loading"> · 加载中…</span>}
        </span>
        <Select value={source} onChange={switchSource} aria-label="来源" options={SOURCE_OPTIONS} />
        {source === "directory" && categories.length > 0 && (
          <Select
            value={category}
            onChange={(value) => {
              setCategory(value);
              setPage(0);
            }}
            aria-label="分类"
            options={[{ value: "", label: "全部分类" }, ...categories.map((c) => ({ value: c, label: categoryLabel(c) }))]}
          />
        )}
      </div>
      {entries && entries.length > 0 ? (
        <CardGrid gridRef={gridRef} loading={loading}>
          {shown.map((entry) => (
            <ConnectorCard
              key={entry.id}
              entry={entry}
              category={category}
              existing={existing(entry)}
              status={status}
              adding={adding === entry.id}
              onAdd={() => add(entry)}
              onSignIn={setSigningIn}
            />
          ))}
        </CardGrid>
      ) : loading ? (
        <DirectoryLoading
          label="正在加载连接器市场"
          hint={source === "directory" ? "正在读取 Claude 目录" : keyword ? "正在 MCP 注册表中查找连接器" : "正在读取推荐连接器"}
        />
      ) : (
        <div className="settings-empty">
          {!entries ? "连接器市场加载失败" : keyword || category ? "没有匹配的连接器" : source === "registry" ? "没有推荐的连接器，搜索试试" : "目录里没有连接器"}
        </div>
      )}
      {entries && entries.length > 0 && (
        <Pager
          page={page}
          total={source === "directory" ? total : entries.length}
          pageSize={size}
          hasMore={source === "registry" && nextCursor !== undefined}
          loading={loading}
          onPage={turn}
        />
      )}
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

/** 一张连接器卡片。Claude 目录的：信息行是作者、审核、工具数、地址，底部是分类；注册表的：标题下面是注册表名称，底部是地址 */
function ConnectorCard({
  entry,
  category,
  existing,
  status,
  adding,
  onAdd,
  onSignIn,
}: {
  entry: ConnectorEntry;
  /** 正在按哪个分类筛：底部显示这个分类，没筛时显示它的第一个 */
  category: string;
  existing?: string;
  status: (name: string) => string | undefined;
  adding: boolean;
  onAdd: () => void;
  onSignIn: (name: string) => void;
}) {
  const directory = entry.source === "directory";
  const tag = category && entry.categories?.includes(category) ? category : entry.categories?.[0];
  const where = entry.urlOptions ? `${entry.urlOptions.length} 个地区可选` : entry.urlPattern ? "地址自己填" : hostOf(entry.url);
  const meta = directory
    ? [
        entry.author,
        entry.review && `${REVIEW_LABELS[entry.review]}审核`,
        entry.toolCount ? `${entry.toolCount} 个工具` : undefined,
        entry.authless && "不用登录",
        where,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const action = existing ? (
    status(existing) === "needs-auth" ? (
      <button className="market-card-action" title={`已添加为 ${existing}，需要登录`} onClick={() => onSignIn(existing)}>
        登录
      </button>
    ) : (
      <span className="connector-added" title={`已添加为 ${existing}`}>
        <CheckIcon />
        已添加
      </span>
    )
  ) : entry.unsupported ? (
    <button className="market-card-action" disabled title={entry.unsupported}>
      不支持
    </button>
  ) : (
    <button className="market-card-action" disabled={adding} onClick={onAdd}>
      {adding ? "添加中…" : "+ 添加"}
    </button>
  );
  return (
    <Card
      icon={<ConnectorIcon name={entry.title} icon={entry.icon} />}
      title={entry.title}
      subtitle={directory ? undefined : entry.id}
      description={entry.description}
      meta={
        directory ? (
          <>
            <span className="market-card-meta-text" title={entry.url ? `${meta}\n${entry.url}` : meta}>
              {meta}
            </span>
            {entry.directoryUrl && (
              <span className="market-card-meta-link">
                {" · "}
                <a href={entry.directoryUrl} target="_blank" rel="noreferrer" title={entry.directoryUrl}>
                  目录页
                </a>
              </span>
            )}
          </>
        ) : undefined
      }
      foot={
        <>
          {directory ? (
            <span className="connector-tags">
              {tag && <span className="settings-tag">{categoryLabel(tag)}</span>}
              {entry.claudeCode === false && (
                <span className="settings-tag" title="Claude 目录列出的支持客户端里没有 Claude Code，登录时可能因为服务商不允许注册客户端而失败">
                  未列出 Claude Code
                </span>
              )}
            </span>
          ) : (
            <span className="market-card-host" title={entry.url}>
              <LinkIcon />
              <span>{hostOf(entry.url)}</span>
              {entry.type === "sse" && <span className="settings-tag">SSE</span>}
            </span>
          )}
          {action}
        </>
      }
    />
  );
}

/** 卡片底部显示的主机名，完整地址在悬停提示里；解析不了的原样显示 */
function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
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
  const [url, setUrl] = useState(entry.urlOptions?.[0]?.url ?? entry.url);
  const [variables, setVariables] = useState<Record<string, string>>(() => Object.fromEntries(entry.variables.map((v) => [v.name, v.default ?? ""])));
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    api
      .addConnector({ id: entry.id, source: entry.source, name: name.trim(), ...(entry.urlOptions || entry.urlPattern ? { url } : {}), variables, headers })
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
        {entry.urlOptions && (
          <label>
            地址
            <Select
              value={url}
              aria-label="地址"
              onChange={setUrl}
              options={entry.urlOptions.map((o) => ({ value: o.url, label: o.description ? `${o.label}（${o.description}）` : o.label }))}
            />
            <span className="mcp-hint mono">{url}</span>
          </label>
        )}
        {entry.urlPattern && (
          <label>
            地址
            <input className="mono" type="url" required value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
            <span className="mcp-hint" title={entry.urlPattern}>
              填你自己的实例或工作区的地址{entry.url ? "，上面是示例" : ""}，要符合格式：<span className="mono">{entry.urlPattern}</span>
            </span>
          </label>
        )}
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
