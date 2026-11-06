import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { desktop } from "../desktop";
import { BrowserIcon, GlobeIcon, SiteIcon } from "./BrowserTab";
import { useDismiss } from "./ComposerPickers";

interface Tab {
  title: string;
  url: string;
  /** 网页的图标：内置浏览器的由桌面版给；Chrome 的拿不到，用网站根目录的 /favicon.ico 试，加载失败时显示地球 */
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

interface Props {
  /** 桌面版内置浏览器里这个会话的标签页；网页版是空的 */
  inapp: Tab[];
  /** 选中一个标签页：chrome 时是外部浏览器（用户的 Chrome）的 */
  onPick: (tab: Tab, chrome: boolean) => void;
  /** 选中浏览器本身（每组第一行）：chrome 时是外部浏览器 */
  onPickBrowser: (chrome: boolean) => void;
}

/**
 * 输入框上面的「标签页」：和「技能」「插件」一样点开搜索、选择，选中后插在输入框的光标处。
 * 分两组：内置浏览器（只有桌面版）、Chrome（网关开了外部浏览器时；还没连上时是空的，不会为了列标签页去连）。两组都没有就不显示按钮。
 * 每组第一行是浏览器本身（写成 @内置浏览器、@Chrome，指定用哪个浏览器），下面是它的标签页（@[标题](网址)、@chrome[标题](网址)）
 */
export function TabPicker({ inapp, onPick, onPickBrowser }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [chromeOn, setChromeOn] = useState(false);
  const [chromeTabs, setChromeTabs] = useState<Tab[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  // 网关开没开外部浏览器（config.yml 的 externalBrowser.enabled），启动时问一次
  useEffect(() => {
    api.chromeTabs().then((r) => setChromeOn(r.enabled), () => undefined);
  }, []);
  // 每次打开时取一次 Chrome 的标签页（AI 可能刚开了新的）
  useEffect(() => {
    if (!open) {
      setSearch("");
      setChromeTabs(null);
      return;
    }
    inputRef.current?.focus();
    if (!chromeOn) return;
    let stale = false;
    api.chromeTabs().then(
      (r) => !stale && setChromeTabs(r.tabs),
      () => !stale && setChromeTabs([]),
    );
    return () => {
      stale = true;
    };
  }, [open, chromeOn]);

  const hasInapp = !!desktop?.browser;
  if (!hasInapp && !chromeOn) return null;

  const keyword = search.trim().toLowerCase();
  const filter = (tabs: Tab[]) =>
    tabs.filter((t) => t.url && t.url !== "about:blank" && (!keyword || `${t.title} ${t.url}`.toLowerCase().includes(keyword)));
  const pick = (tab: Tab, chrome: boolean) => {
    setOpen(false);
    onPick(tab, chrome);
  };
  const pickBrowser = (chrome: boolean) => {
    setOpen(false);
    onPickBrowser(chrome);
  };

  return (
    <div className="capability-picker" ref={ref}>
      <button className="new-chat-chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <GlobeIcon />
        <span className="new-chat-chip-label">标签页</span>
      </button>
      {open && (
        <div className="menu capability-menu tab-picker-menu" role="menu">
          <input ref={inputRef} className="capability-search" value={search} placeholder="搜索标题或网址…" onChange={(e) => setSearch(e.target.value)} />
          <div className="capability-list">
            {hasInapp && (
              <Group
                label="内置浏览器"
                chrome={false}
                hint="右侧面板"
                tabs={filter(inapp)}
                empty={inapp.length ? "没有匹配的标签页" : "这个会话还没有标签页"}
                onPick={(t) => pick(t, false)}
                onPickBrowser={() => pickBrowser(false)}
              />
            )}
            {chromeOn && (
              <Group
                label="Chrome"
                chrome
                hint="你自己的 Chrome"
                onPickBrowser={() => pickBrowser(true)}
                tabs={chromeTabs ? filter(chromeTabs) : []}
                empty={chromeTabs === null ? "加载中…" : chromeTabs.length ? "没有匹配的标签页" : "还没连上，或者没有交给 AI 的标签页"}
                onPick={(t) => pick(t, true)}
                guessIcon
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface GroupProps {
  label: string;
  chrome: boolean;
  /** 浏览器那一行右边的小字 */
  hint: string;
  tabs: Tab[];
  empty: string;
  onPick: (tab: Tab) => void;
  onPickBrowser: () => void;
  guessIcon?: boolean;
}

function Group({ label, chrome, hint, tabs, empty, onPick, onPickBrowser, guessIcon }: GroupProps) {
  return (
    <div className="tab-picker-group">
      <button className="capability-item tab-picker-browser" role="menuitem" title={`引用${label}`} onClick={onPickBrowser}>
        <span className={chrome ? "tab-picker-badge chrome" : "tab-picker-badge"}>
          <BrowserIcon chrome={chrome} />
        </span>
        <span className="capability-name">{label}</span>
        <span className="tab-picker-hint">{hint}</span>
      </button>
      {tabs.map((tab) => (
        <button key={tab.url} className="capability-item tab-picker-tab" role="menuitem" title={tab.url} onClick={() => onPick(tab)}>
          <span className="tab-picker-icon">
            <SiteIcon src={tab.favicon ?? (guessIcon ? rootFavicon(tab.url) : undefined)} />
          </span>
          {/* 像浏览器的标签栏一样只显示标题，网址悬停时看（title），没有标题的才显示网址 */}
          <span className="capability-name">{tab.title || tab.url.replace(/^https?:\/\//, "")}</span>
        </button>
      ))}
      {tabs.length === 0 && <div className="capability-empty tab-picker-empty">{empty}</div>}
    </div>
  );
}
