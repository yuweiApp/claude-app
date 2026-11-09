import { useEffect, useState } from "react";
import { api, type MarketPlugin } from "../api";
import { Avatar } from "./CapabilityPicker";
import { Pager, pageOf } from "./Pager";

/** 安装次数：一万以上写成「18.4 万」 */
function formatCount(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1).replace(/\.0$/, "")} 万` : String(n);
}

/**
 * 设置 → 插件 → 插件市场：网关配置的插件市场（默认 Anthropic 官方的 claude-plugins-official）里的插件，按安装次数排序。
 * 一次全部取回来，搜索和分类在网页里筛。安装由网关交给 Claude Code，装好的在「个人插件」里，点「已安装」打开详情
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
  const [plugins, setPlugins] = useState<MarketPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.pluginMarket(refresh).then(
      (list) => {
        if (cancelled) return;
        setPlugins(list);
        setError(null);
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const install = (plugin: MarketPlugin) => {
    setInstalling(plugin.id);
    setError(null);
    api
      .installPlugin(plugin.id)
      .then(
        () => {
          setPlugins((prev) => prev?.map((p) => (p.id === plugin.id ? { ...p, installed: true } : p)) ?? null);
          onChanged();
        },
        (e: Error) => setError(`安装 ${plugin.name} 失败：${e.message}`),
      )
      .finally(() => setInstalling(null));
  };

  const keyword = search.trim().toLowerCase();
  // 换了搜索词、分类回到第一页
  useEffect(() => setPage(0), [keyword, category]);
  const categories = [...new Set((plugins ?? []).flatMap((p) => p.category ?? []))].sort();
  const shown = (plugins ?? []).filter(
    (p) => (!category || p.category === category) && [p.name, p.title, p.description, p.category, p.author].join(" ").toLowerCase().includes(keyword),
  );

  return (
    <>
      {error && <div className="settings-error">{error}</div>}
      {plugins && plugins.length > 0 && (
        <div className="plugin-directory-bar">
          <span>
            {shown.length} 个插件 · 来自 {[...new Set(plugins.map((p) => p.marketplace))].join("、")}
          </span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="分类">
            <option value="">全部分类</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      )}
      {shown.length > 0 ? (
        <div className="settings-list">
          {pageOf(shown, page).map((plugin) => {
            const meta = [plugin.author, plugin.installCount !== undefined && `安装 ${formatCount(plugin.installCount)} 次`, plugin.version && `版本 ${plugin.version}`]
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
                  {meta && <div className="settings-row-status">{meta}</div>}
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
        <div className="settings-empty">{!plugins ? (error ? "插件市场加载失败" : "加载中…（第一次要从 GitHub 克隆市场）") : "没有匹配的插件"}</div>
      )}
      <Pager page={page} total={shown.length} onPage={setPage} />
    </>
  );
}
