import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import type { ExternalBrowserId } from "../api";
import type { BrowserSuggestion, BrowserTabInfo, DesktopBrowserApi } from "../desktop";

interface Props {
  api: DesktopBrowserApi;
  id: string;
  info: BrowserTabInfo | undefined;
  active: boolean;
}

/**
 * 右侧面板里的一个浏览器标签页（只有桌面版有）：上面是地址栏，下面的画面区域只是个空的 div，
 * 网页是外壳的原生网页视图，按这个 div 的位置叠放在窗口上（见 desktop/src/browser/views.ts）。
 * 原生视图总在界面之上：界面的对话框、菜单盖住画面区域时先把视图收起来，不然会挡住它们
 */
export function BrowserTab({ api, id, info, active }: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 地址栏显示的网址：正在打开的优先，新建标签页加载期间 url 还是 about:blank */
  const url = displayUrl(info?.pendingUrl || info?.url);
  const [address, setAddress] = useState(url);
  const [editing, setEditing] = useState(false);
  const [covered, setCovered] = useState(false);
  /** 被盖住时贴在原位的网页快照 */
  const [snapshot, setSnapshot] = useState<string | null>(null);
  /** 没加载出来：收起原生视图（它总在界面之上），画面区域显示错误提示 */
  const failed = info?.error;
  const failedRef = useRef(false);
  failedRef.current = !!failed;

  // 没在编辑时，地址栏跟着网页的网址走
  useEffect(() => {
    if (!editing) setAddress(url);
  }, [url, editing]);

  // 空白页：直接把焦点放到地址栏
  useEffect(() => {
    if (active && url === "") inputRef.current?.focus();
  }, [active, url]);

  // 每一帧对一次位置（拖动面板、侧边栏、缩放窗口都会变），变了才告诉外壳。
  // 被界面的菜单、对话框盖住时：先拍一张快照贴在原位，再收起视图（视图总在界面之上，不收会挡住它们）。
  // 没加载出来时也收起，不拍快照（失败的网页是一片白），露出下面的错误提示
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let last = "";
    let wasCovered = false;
    let shown = false;
    let seq = 0;
    const tick = () => {
      const el = areaRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const empty = r.width < 1 || r.height < 1;
        const blocked = failedRef.current;
        const hidden = empty || blocked || isCovered(el, r);
        if (hidden !== wasCovered) {
          wasCovered = hidden;
          const mine = ++seq;
          if (hidden) {
            last = "hidden";
            const hide = () => {
              setCovered(true);
              api.hide();
              shown = false;
            };
            if (shown && !empty && !blocked) {
              void api.snapshot(id).then((url) => {
                // 拍快照期间又露出来了：不用收
                if (mine !== seq) return;
                setSnapshot(url);
                hide();
              });
            } else hide();
          } else {
            setCovered(false);
          }
        }
        if (!hidden) {
          const key = `${r.left},${r.top},${r.width},${r.height}`;
          if (key !== last) {
            last = key;
            api.show(id, { x: r.left, y: r.top, width: r.width, height: r.height });
            shown = true;
            setSnapshot(null);
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      seq++;
      api.hide();
    };
  }, [api, id, active]);

  return (
    <div className="browser-tab">
      <BrowserToolbar
        info={info}
        inputRef={inputRef}
        address={address}
        onAddress={(value) => {
          setEditing(true);
          setAddress(value);
        }}
        onReset={() => {
          setEditing(false);
          setAddress(url);
        }}
        onSubmit={(url) => {
          api.navigate(id, url);
          setEditing(false);
        }}
        onGo={(action) => api.go(id, action)}
        suggest={api.suggest}
      />
      <div ref={areaRef} className="browser-area">
        {failed ? (
          <div className="browser-error" role="alert">
            <div className="browser-error-title">无法访问此网站</div>
            <div className="browser-error-url">{failed.url}</div>
            <div className="browser-error-reason">{loadErrorText(failed.code)}</div>
            <div className="browser-error-code">{failed.description || `错误码 ${failed.code}`}</div>
            <button className="btn-small browser-error-retry" onClick={() => api.go(id, "reload")}>
              重试
            </button>
          </div>
        ) : (
          covered && (
            <div className="browser-covered">
              {snapshot ? <img src={snapshot} alt="" draggable={false} /> : <span>{info?.title || url}</span>}
            </div>
          )
        )}
      </div>
    </div>
  );
}

interface ToolbarProps {
  info?: BrowserTabInfo;
  inputRef?: RefObject<HTMLInputElement | null>;
  address: string;
  onAddress: (value: string) => void;
  onReset: () => void;
  /** 回车：已经补好协议或换成搜索的网址 */
  onSubmit: (url: string) => void;
  /** 没有网页时（新标签页）不传，后退、前进、刷新都是灰的 */
  onGo?: (action: "back" | "forward" | "reload" | "stop") => void;
  /** 地址栏的建议（浏览历史） */
  suggest?: (query: string) => Promise<BrowserSuggestion[]>;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * 浏览器的地址栏一行：后退、前进、刷新（加载中是停止）、地址。新标签页顶部也用它，在那里输入网址就把这个标签页变成浏览器。
 * 输入时下面弹出浏览历史里的建议，上下键选、回车打开
 */
export function BrowserToolbar({ info, inputRef, address, onAddress, onReset, onSubmit, onGo, suggest, disabled, placeholder }: ToolbarProps) {
  const [items, setItems] = useState<BrowserSuggestion[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const [open, setOpen] = useState(false);
  const query = useRef("");
  const close = () => {
    setOpen(false);
    setHighlight(-1);
  };
  const type = (value: string) => {
    onAddress(value);
    query.current = value;
    setHighlight(-1);
    if (!suggest || !value.trim()) {
      setItems([]);
      return;
    }
    void suggest(value).then((list) => {
      if (query.current !== value) return;
      setItems(list);
      setOpen(list.length > 0);
    });
  };
  const submit = (url: string) => {
    close();
    onSubmit(url);
    inputRef?.current?.blur();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const showing = open && items.length > 0;
    if (e.key === "ArrowDown" && showing) {
      e.preventDefault();
      setHighlight((h) => (h + 1) % items.length);
    } else if (e.key === "ArrowUp" && showing) {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? items.length - 1 : h - 1));
    } else if (e.key === "Enter") {
      const picked = showing && highlight >= 0 ? items[highlight]?.url : normalizeUrl(address);
      if (picked) submit(picked);
    } else if (e.key === "Escape") {
      if (showing) close();
      else {
        onReset();
        e.currentTarget.blur();
      }
    }
  };
  return (
    <div className="browser-toolbar">
      <LoadingBar loading={!!info?.loading} />
      <div className="browser-nav">
        <button className="icon-btn browser-btn" title="后退（Alt+←）" aria-label="后退" disabled={!onGo || !info?.canGoBack} onClick={() => onGo?.("back")}>
          <ArrowIcon dir="left" />
        </button>
        <button className="icon-btn browser-btn" title="前进（Alt+→）" aria-label="前进" disabled={!onGo || !info?.canGoForward} onClick={() => onGo?.("forward")}>
          <ArrowIcon dir="right" />
        </button>
        <span className="browser-nav-sep" />
        {info?.loading ? (
          <button className="icon-btn browser-btn" title="停止" aria-label="停止" onClick={() => onGo?.("stop")}>
            <StopIcon />
          </button>
        ) : (
          <button className="icon-btn browser-btn" title="刷新（Ctrl+R）" aria-label="刷新" disabled={!onGo} onClick={() => onGo?.("reload")}>
            <ReloadIcon />
          </button>
        )}
      </div>
      <div className="browser-address-wrap">
        <input
          ref={inputRef}
          className="browser-address"
          value={address}
          placeholder={placeholder ?? "搜索或输入网址"}
          spellCheck={false}
          disabled={disabled}
          role="combobox"
          aria-expanded={open && items.length > 0}
          onChange={(e) => type(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            close();
            onReset();
          }}
          onKeyDown={onKeyDown}
        />
        {open && items.length > 0 && (
          <div className="menu browser-suggest" role="listbox">
            {items.map((item, i) => (
              <button
                key={item.url}
                role="option"
                aria-selected={i === highlight}
                className={`browser-suggest-item${i === highlight ? " active" : ""}`}
                // 不让地址栏失焦
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== highlight && setHighlight(i)}
                onClick={() => submit(item.url)}
              >
                <span className="browser-suggest-title">{item.title || item.url}</span>
                <span className="browser-suggest-url">{item.url}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 地址栏下边的加载进度条。拿不到网页加载的真实进度，按时间走：开始时走得快、越往后越慢，停在九成左右；
 * 加载完（成功或失败）补满再淡出。重新开始加载时换个 key 从头走
 */
function LoadingBar({ loading }: { loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "done">(loading ? "loading" : "idle");
  const [run, setRun] = useState(0);
  /** 加载完时走到的宽度，补满的动画从这里开始（撤掉动画时过渡不会从动画中途的宽度开始） */
  const [from, setFrom] = useState("0px");
  useEffect(() => {
    if (loading) {
      setRun((n) => n + 1);
      setPhase("loading");
    } else if (ref.current) {
      setFrom(getComputedStyle(ref.current).width);
      setPhase("done");
    }
  }, [loading]);
  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(() => setPhase("idle"), 450);
    return () => clearTimeout(t);
  }, [phase]);
  if (phase === "idle") return null;
  return (
    <div
      ref={ref}
      key={run}
      className={`browser-progress${phase === "done" ? " done" : ""}`}
      style={{ "--from": from } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/** 画面区域上取 5×5 个点（四边各取一排），最上面的元素不是它自己（或里面的东西），就是被对话框、菜单、地址栏建议盖住了 */
function isCovered(el: HTMLElement, r: DOMRect): boolean {
  // 离边 6px：面板左边缘拖动调宽度的那条（.side-panel-resizer）伸进面板 3px，不算盖住
  const xs = [r.left + 6, r.left + r.width / 4, r.left + r.width / 2, r.left + (r.width * 3) / 4, r.right - 6];
  const ys = [r.top + 6, r.top + r.height / 4, r.top + r.height / 2, r.top + (r.height * 3) / 4, r.bottom - 6];
  return ys.some((y) =>
    xs.some((x) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && !el.contains(hit);
    }),
  );
}

/** Chromium 的网络错误码（net_error_list.h）说成人话；没列到的只显示错误名 */
function loadErrorText(code: number): string {
  if (code <= -200 && code > -300) return "网站的安全证书有问题，连接不安全。";
  switch (code) {
    case -105:
    case -137:
      return "找不到服务器：域名解析失败。可能是网址拼错了，或者这是只能在内网、VPN 里访问的地址。";
    case -106:
      return "没有网络连接。";
    case -102:
      return "服务器拒绝了连接：对应端口上没有服务在运行，或者被防火墙拦下了。";
    case -7:
    case -118:
      return "连接超时：服务器长时间没有响应。";
    case -101:
    case -100:
      return "连接被服务器重置或关闭了。";
    case -109:
    case -104:
      return "无法连到服务器的地址。";
    case -130:
    case -111:
    case -115:
      return "代理服务器连接失败。";
    case -21:
      return "网络环境变了（如切换了 Wi-Fi、VPN），请重试。";
    case -300:
      return "网址格式不对。";
    case -301:
    case -302:
      return "不支持打开这种地址。";
    case -324:
      return "服务器没有返回任何数据就断开了。";
    case -310:
      return "重定向次数太多，网页无法打开。";
    default:
      return "网页没有加载出来。";
  }
}

/** 空白页不显示 about:blank */
function displayUrl(url: string | undefined): string {
  return !url || url === "about:blank" ? "" : url;
}

/** 地址栏的输入：像网址的补上协议，否则用必应搜索 */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/]+:\d+/.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text)) return `https://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

function ArrowIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === "left" ? <path d="M13 8H3M7 4 3 8l4 4" /> : <path d="M3 8h10M9 4l4 4-4 4" />}
    </svg>
  );
}

function ReloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** 网页的图标（favicon）：没有、或者加载失败时用地球 */
export function SiteIcon({ src }: { src?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <GlobeIcon />;
  return <img className="site-icon" src={src} width={16} height={16} alt="" referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
}

/**
 * 引用整个浏览器（@内置浏览器、@Chrome、@Edge）的图标，「浏览器」菜单、输入框、消息里都用这一个。
 * 内置浏览器（不传 source）：品牌色圆角方块里白色的「左边对话、右边面板」窗口（就是这个应用的样子，见 .inapp-logo）；
 * Chrome、Edge：各自的彩色标志（见 .chrome-logo、.edge-logo）
 */
export function BrowserIcon({ source }: { source?: ExternalBrowserId }) {
  if (source) return <span className={`${source}-logo`} aria-hidden="true" />;
  return (
    <span className="inapp-logo" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 2.5h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3z" fill="currentColor" fillOpacity="0.35" stroke="none" />
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="M9.5 2.5v11M4 6h3M4 8.5h2" />
      </svg>
    </span>
  );
}

export function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13M8 1.5c1.8 1.9 2.6 4 2.6 6.5S9.8 12.6 8 14.5C6.2 12.6 5.4 10.5 5.4 8S6.2 3.4 8 1.5z" />
    </svg>
  );
}
