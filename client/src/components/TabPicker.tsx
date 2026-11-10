import { useEffect, useRef, useState } from "react";
import { api, type BrowserLogo, type ExternalBrowserInfo, type ExternalBrowserTabs } from "../api";
import { desktop } from "../desktop";
import { BrowserIcon, GlobeIcon, SiteIcon } from "./BrowserTab";
import { useDismiss } from "./ComposerPickers";

interface Tab {
  title: string;
  url: string;
  /** 网页的图标：内置浏览器的由桌面版给；外部浏览器的拿不到，用网站根目录的 /favicon.ico 试，加载失败时显示地球 */
  favicon?: string;
}

/** 网站根目录的 /favicon.ico（大多数网站都有） */
function rootFavicon(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}/favicon.ico` : undefined;
  } catch {
    return undefined;
  }
}

/** 折叠起来的组（"inapp" 和外部浏览器的 id），存在 localStorage，下次打开还是折叠的 */
const COLLAPSED_KEY = "tab-picker-collapsed";

function readCollapsed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveCollapsed(groups: string[]) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(groups));
  } catch {
    // 存不了（隐私模式等）就只在这次有效
  }
}

interface Props {
  /** 桌面版内置浏览器里这个会话的标签页；网页版是空的 */
  inapp: Tab[];
  /** 选中一个标签页：source 是外部浏览器的 id，内置浏览器的不传 */
  onPick: (tab: Tab, source?: string) => void;
  /** 选中浏览器本身（每组第一行）：外部浏览器传它，内置浏览器不传 */
  onPickBrowser: (browser?: ExternalBrowserInfo) => void;
  /** 启用着的外部浏览器（App 里取的，设置页改了会再取）；打开菜单时再取一次带上标签页 */
  external: ExternalBrowserInfo[];
}

/**
 * 输入框上面的「浏览器」：和「技能」「插件」一样点开搜索、选择，选中后插在输入框的光标处。
 * 分组：内置浏览器（只有桌面版），再是每个启用着的外部浏览器（设置页「浏览器」里开着的 Chrome、Edge、Brave…；
 * 还没连上时是空的，不会为了列标签页去连）。一组都没有就不显示按钮。
 * 每组第一行是浏览器本身（写成 @内置浏览器、@Chrome，指定用哪个浏览器），下面是它的标签页（@[标题](网址)、@chrome[标题](网址)）。
 * 标签页可能很多，每组可以折叠（第一行右边的箭头），折叠状态记在 localStorage；搜索时不管折没折叠，都列出匹配的
 */
export function TabPicker({ inapp, onPick, onPickBrowser, external: enabled }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  /** 打开菜单时取的外部浏览器和最新的标签页；还没取到时用 App 给的列表（没有标签页） */
  const [fetched, setFetched] = useState<ExternalBrowserTabs[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  // 每次打开时取一次外部浏览器的标签页（AI 可能刚开了新的）
  useEffect(() => {
    if (!open) {
      setSearch("");
      setLoaded(false);
      setFetched(null);
      return;
    }
    inputRef.current?.focus();
    let stale = false;
    api.externalTabs().then(
      (browsers) => {
        if (stale) return;
        setFetched(browsers);
        setLoaded(true);
      },
      () => !stale && setLoaded(true),
    );
    return () => {
      stale = true;
    };
  }, [open]);

  const external: ExternalBrowserTabs[] = fetched ?? enabled.map((b) => ({ ...b, tabs: [] }));
  const hasInapp = !!desktop?.browser;
  if (!hasInapp && !external.length) return null;

  const keyword = search.trim().toLowerCase();
  const filter = (tabs: Tab[]) =>
    tabs.filter((t) => t.url && t.url !== "about:blank" && (!keyword || `${t.title} ${t.url}`.toLowerCase().includes(keyword)));
  const pick = (tab: Tab, source?: string) => {
    setOpen(false);
    onPick(tab, source);
  };
  const pickBrowser = (browser?: ExternalBrowserInfo) => {
    setOpen(false);
    onPickBrowser(browser);
  };
  const toggle = (group: string) =>
    setCollapsed((prev) => {
      const next = prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group];
      saveCollapsed(next);
      return next;
    });
  const groupState = (group: string) => ({ collapsed: !keyword && collapsed.includes(group), onToggle: () => toggle(group) });

  return (
    <div className="capability-picker" ref={ref}>
      <button className="new-chat-chip" title="浏览器" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <GlobeIcon className="ic ic-tab" />
        <span className="new-chat-chip-label">浏览器</span>
      </button>
      {open && (
        <div className="menu capability-menu tab-picker-menu" role="menu">
          <input ref={inputRef} className="capability-search" value={search} placeholder="搜索标题或网址…" onChange={(e) => setSearch(e.target.value)} />
          <div className="capability-list">
            {hasInapp && (
              <Group
                label="内置浏览器"
                tabs={filter(inapp)}
                empty={inapp.length ? "没有匹配的标签页" : "这个会话还没有标签页"}
                onPick={(t) => pick(t)}
                onPickBrowser={() => pickBrowser()}
                {...groupState("inapp")}
              />
            )}
            {external.map((b) => (
              <Group
                key={b.id}
                label={b.name}
                logo={b.logo}
                onPickBrowser={() => pickBrowser(b)}
                tabs={loaded ? filter(b.tabs) : []}
                empty={!loaded ? "加载中…" : b.tabs.length ? "没有匹配的标签页" : "还没连上，或者没有交给 AI 的标签页"}
                onPick={(t) => pick(t, b.id)}
                guessIcon
                {...groupState(b.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface GroupProps {
  label: string;
  /** 外部浏览器的图标；内置浏览器不传 */
  logo?: BrowserLogo;
  tabs: Tab[];
  empty: string;
  onPick: (tab: Tab) => void;
  onPickBrowser: () => void;
  guessIcon?: boolean;
  /** 折叠着：只留浏览器那一行（搜索时传 false，照样列出匹配的） */
  collapsed: boolean;
  onToggle: () => void;
}

function Group({ label, logo, tabs, empty, onPick, onPickBrowser, guessIcon, collapsed, onToggle }: GroupProps) {
  return (
    <div className="tab-picker-group">
      <div className="tab-picker-head">
        <button className="capability-item tab-picker-browser" role="menuitem" title={`引用${label}`} onClick={onPickBrowser}>
          <span className="tab-picker-badge">
            <BrowserIcon logo={logo} name={label} />
          </span>
          <span className="capability-name">{label}</span>
        </button>
        {/* 折叠、展开：折叠时箭头朝右，旁边是标签页数 */}
        <button className="tab-picker-toggle" title={collapsed ? "展开" : "折叠"} aria-expanded={!collapsed} onClick={onToggle}>
          {collapsed && tabs.length > 0 && <span className="tab-picker-count">{tabs.length}</span>}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3.5 2 6.5 5l-3 3" />
          </svg>
        </button>
      </div>
      {!collapsed && tabs.map((tab) => (
        <button key={tab.url} className="capability-item tab-picker-tab" role="menuitem" title={tab.url} onClick={() => onPick(tab)}>
          <span className="tab-picker-icon">
            <SiteIcon src={tab.favicon ?? (guessIcon ? rootFavicon(tab.url) : undefined)} />
          </span>
          {/* 像浏览器的标签栏一样只显示标题，网址悬停时看（title），没有标题的才显示网址 */}
          <span className="capability-name">{tab.title || tab.url.replace(/^https?:\/\//, "")}</span>
        </button>
      ))}
      {!collapsed && tabs.length === 0 && <div className="capability-empty tab-picker-empty">{empty}</div>}
    </div>
  );
}
