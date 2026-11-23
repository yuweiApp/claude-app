import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type SessionListItem, type SessionSearchHit, type SessionSearchResult } from "../api";
import { folderName, sessionTitle } from "./Sidebar";

/** 每个项目最后查的内容：关掉再打开对话框时还在 */
const lastQuery = new Map<string, string>();

/**
 * 侧边栏项目菜单里的「查找…」：在这个项目（工作目录 cwd）的所有会话记录里查找，停止输入一会儿就查。
 * 结果按会话分组（会话按最近回复排），每条是匹配的那段文字（匹配处标出来）和时间；点一条（或上下键选中后回车）打开会话并定位到那条消息
 */
export function SessionSearchDialog({
  cwd,
  sessions,
  onOpen,
  onClose,
}: {
  cwd: string;
  /** 这个项目的会话，结果里显示会话标题用 */
  sessions: SessionListItem[];
  onOpen: (hit: SessionSearchHit, query: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(() => lastQuery.get(cwd) ?? "");
  const [result, setResult] = useState<{ query: string; data: SessionSearchResult } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const query = input.trim();
  useEffect(() => {
    lastQuery.set(cwd, input);
    if (!query) {
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      api.searchSessions(cwd, query, controller.signal).then(
        (data) => {
          setResult({ query, data });
          setActive(0);
          setError(null);
          setLoading(false);
        },
        (e: Error) => {
          if (controller.signal.aborted) return;
          setError(e.message);
          setLoading(false);
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cwd, query]);

  const titles = useMemo(() => new Map(sessions.map((s) => [s.sessionId, sessionTitle(s)])), [sessions]);
  const hits = result?.data.hits ?? [];
  // 按会话分组，组的顺序和组里的顺序都是网关给的
  const groups = useMemo(() => {
    const out: { sessionId: string; hits: { hit: SessionSearchHit; index: number }[] }[] = [];
    hits.forEach((hit, index) => {
      const last = out.at(-1);
      if (last?.sessionId === hit.sessionId) last.hits.push({ hit, index });
      else out.push({ sessionId: hit.sessionId, hits: [{ hit, index }] });
    });
    return out;
  }, [hits]);

  useEffect(() => {
    listRef.current?.querySelector(".search-hit.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (hit: SessionSearchHit | undefined) => hit && result && onOpen(hit, result.query);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog search-dialog" role="dialog" aria-label={`在 ${folderName(cwd)} 中查找`}>
        <h3>在「{folderName(cwd)}」的会话中查找</h3>
        <input
          ref={inputRef}
          className="search-input"
          value={input}
          placeholder="输入要查找的文字"
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (hits.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              open(hits[active]);
            }
          }}
        />
        <div className="search-status">
          {error ? (
            <span className="search-error">{error}</span>
          ) : !query ? (
            `查找 ${sessions.length} 个会话里你和 Claude 写的文字（不含工具调用和结果）`
          ) : loading && !result ? (
            "正在查找…"
          ) : result ? (
            <>
              {hits.length ? `${groups.length} 个会话中 ${hits.length}${result.data.truncated ? "+" : ""} 条消息` : `${result.data.sessions} 个会话里没有找到`}
              {loading && "，正在更新…"}
            </>
          ) : null}
        </div>
        <div className={`search-results${loading ? " loading" : ""}`} ref={listRef}>
          {groups.map((g) => (
            <Fragment key={g.sessionId}>
              <div className="search-session" title={titles.get(g.sessionId)}>
                <span className="search-session-title">{titles.get(g.sessionId) ?? "会话"}</span>
                <span className="search-session-count">{g.hits.length}</span>
              </div>
              {g.hits.map(({ hit, index }) => (
                <button
                  key={hit.uuid}
                  className={`search-hit${index === active ? " active" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => open(hit)}
                >
                  <span className="search-hit-text">
                    <span className={`search-role ${hit.role}`}>{hit.role === "user" ? "你" : "Claude"}</span>
                    {marked(hit.snippet, result!.query)}
                  </span>
                  <span className="search-hit-meta">
                    {hit.count > 1 && <span>{hit.count} 处</span>}
                    {hit.at !== undefined && <span>{formatTime(hit.at)}</span>}
                  </span>
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 片段里出现 query 的地方（不分大小写）包上 <mark> */
function marked(text: string, query: string): ReactNode[] {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (let i = lower.indexOf(needle); needle && i >= 0; i = lower.indexOf(needle, i + needle.length)) {
    if (i > from) out.push(text.slice(from, i));
    out.push(<mark key={i}>{text.slice(i, i + needle.length)}</mark>);
    from = i + needle.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/** 今天的只显示时分，今年的显示月日时分，更早的带年份 */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? `${date} ${time}` : `${d.getFullYear()}年${date} ${time}`;
}
