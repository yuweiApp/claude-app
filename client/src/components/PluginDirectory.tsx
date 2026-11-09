import { useEffect, useRef, useState } from "react";
import { api, type MarketPlugin, type MarketPluginPage } from "../api";
import { Avatar } from "./CapabilityPicker";
import { PAGE_SIZE, Pager } from "./Pager";
import { Select } from "./Select";

/** 安装次数：一万以上写成「18.4 万」 */
function formatCount(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1).replace(/\.0$/, "")} 万` : String(n);
}

/** 市场的显示名称；没列的显示市场名 */
const MARKET_LABELS: Record<string, string> = {
  "claude-plugins-official": "官方市场",
  "anthropic-plugin-directory": "Anthropic 目录",
};
const marketLabel = (name: string) => MARKET_LABELS[name] ?? name;

const REVIEW_LABELS = { anthropic: "Anthropic 审核", partner: "合作伙伴审核" } as const;

/**
 * 设置 → 插件 → 插件市场：网关配置的插件市场（默认官方的 claude-plugins-official 和 Claude Code 内置的 anthropic-plugin-directory）里的插件，
 * 同名的网关已经只留一个，按市场、安装次数排好。搜索、来源、分类由网关筛，每次只取当前这一页和总数。
 * 安装由网关交给 Claude Code，装好的在「个人插件」里，点「已安装」打开详情
 */
export function PluginDirectory({
  search,
  refresh,
  imported,
  onChanged,
  onOpen,
}: {
  search: string;
  /** 已经手动导入的插件名：同名的不能再从市场装 */
  imported: string[];
  /** 设置页点了「刷新」：网关先更新市场再列 */
  refresh: boolean;
  onChanged: () => void;
  onOpen: (name: string) => void;
}) {
  const [result, setResult] = useState<MarketPluginPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [market, setMarket] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [page, setPage] = useState(0);
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
  // 设置页点「刷新」会重新挂载这个组件：只有挂载后的第一次请求让网关先更新市场
  const refreshPending = useRef(refresh);

  // 网关按条件筛好只返回这一页，带总数；翻页、换条件时再取
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const wantRefresh = refreshPending.current;
    refreshPending.current = false;
    api
      .pluginMarket({ refresh: wantRefresh, search: keyword, marketplace: market, category, offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then(
        (next) => {
          if (cancelled) return;
          setResult(next);
          setError(null);
        },
        (e: Error) => !cancelled && setError(e.message),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [keyword, market, category, page]);

  const install = (plugin: MarketPlugin) => {
    setInstalling(plugin.id);
    setError(null);
    api
      .installPlugin(plugin.id)
      .then(
        () => {
          setResult((prev) => prev && { ...prev, plugins: prev.plugins.map((p) => (p.id === plugin.id ? { ...p, installed: true } : p)) });
          onChanged();
        },
        (e: Error) => setError(`安装 ${plugin.name} 失败：${e.message}`),
      )
      .finally(() => setInstalling(null));
  };

  return (
    <>
      {error && <div className="settings-error">{error}</div>}
      {result && result.marketplaces.length > 0 && (
        <div className="plugin-directory-bar">
          <span>{result.total} 个插件</span>
          {result.marketplaces.length > 1 && (
            <Select
              value={market}
              onChange={(value) => {
                setMarket(value);
                setCategory("");
                setPage(0);
              }}
              aria-label="来源"
              options={[{ value: "", label: "全部来源" }, ...result.marketplaces.map((m) => ({ value: m, label: marketLabel(m) }))]}
            />
          )}
          {result.categories.length > 0 && (
            <Select
              value={category}
              onChange={(value) => {
                setCategory(value);
                setPage(0);
              }}
              aria-label="分类"
              options={[{ value: "", label: "全部分类" }, ...result.categories.map((c) => ({ value: c, label: c }))]}
            />
          )}
        </div>
      )}
      {result && result.plugins.length > 0 ? (
        <div className="settings-list">
          {result.plugins.map((plugin) => {
            const meta = [
              marketLabel(plugin.marketplace),
              plugin.author,
              plugin.review && REVIEW_LABELS[plugin.review],
              plugin.installCount !== undefined && `安装 ${formatCount(plugin.installCount)} 次`,
              plugin.version && `版本 ${plugin.version}`,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <div key={plugin.id} className="settings-row">
                <Avatar name={plugin.name} />
                <div className="settings-row-main">
                  <div className="settings-row-name">
                    {plugin.title ?? plugin.name}
                    {plugin.category && <span className="settings-tag">{plugin.category}</span>}
                  </div>
                  {plugin.description && (
                    <div className="settings-row-sub wrap" title={plugin.description}>
                      {plugin.description}
                    </div>
                  )}
                  <div className="settings-row-status">
                    {meta}
                    {plugin.repository && (
                      <>
                        {" · "}
                        <a href={plugin.repository} target="_blank" rel="noreferrer" title={plugin.repository}>
                          代码仓库
                        </a>
                      </>
                    )}
                  </div>
                </div>
                <div className="settings-row-actions">
                  {plugin.installed || imported.includes(plugin.name) ? (
                    <button className="connector-added settings-link" title="打开插件详情" onClick={() => onOpen(plugin.name)}>
                      {plugin.installed ? "已安装" : "已导入"}
                    </button>
                  ) : (
                    <button className="primary" disabled={installing !== null} onClick={() => install(plugin)}>
                      {installing === plugin.id ? "安装中…" : "安装"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="settings-empty">{loading ? "加载中…（第一次要从网上取市场）" : !result ? "插件市场加载失败" : "没有匹配的插件"}</div>
      )}
      {result && <Pager page={page} total={result.total} loading={loading} onPage={setPage} />}
    </>
  );
}
