import { useEffect, useRef, useState } from "react";
import { useDismiss } from "./ComposerPickers";

export interface Capability {
  name: string;
  description?: string;
}

interface Props {
  kind: "技能" | "插件";
  items: Capability[];
  onPick: (name: string) => void;
}

const COLORS = ["#d9822b", "#2563eb", "#1890ff", "#dc2626", "#c2410c", "#15803d", "#7c3aed", "#0d9488"];

/** 名字首字母的小方块，颜色按名字固定 */
export function Avatar({ name }: { name: string }) {
  const hash = [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return (
    <span className="capability-avatar" style={{ background: COLORS[hash % COLORS.length] }}>
      {name[0]!.toUpperCase()}
    </span>
  );
}

/** 展开着的组（插件名），存在 localStorage；没存过的组默认折叠。插件的名字里没有冒号，只有技能会分组 */
const EXPANDED_KEY = "skill-picker-expanded";

function readExpanded(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveExpanded(groups: string[]) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(groups));
  } catch {
    // 存不了（隐私模式等）就只在这次有效
  }
}

/**
 * 输入框上面的「技能」「插件」：点开搜索和选择，选中后写进输入框。
 * 插件带的技能名字是 `插件名:技能名`，按插件分组列在后面，组可以折叠（默认折叠，展开的记在 localStorage），
 * 组里只显示冒号后面的部分；搜索时不管折没折叠，都列出匹配的
 */
export function CapabilityPicker({ kind, items, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(readExpanded);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setSearch("");
  }, [open]);

  const keyword = search.trim().toLowerCase();
  const shown = items.filter((item) => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(keyword));
  const loose = shown.filter((item) => !item.name.includes(":"));
  const groups = new Map<string, Capability[]>();
  for (const item of shown) {
    const i = item.name.indexOf(":");
    if (i < 0) continue;
    const group = item.name.slice(0, i);
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  const pick = (name: string) => {
    setOpen(false);
    onPick(name);
  };
  const toggle = (group: string) =>
    setExpanded((prev) => {
      const next = prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group];
      saveExpanded(next);
      return next;
    });

  return (
    <div className="capability-picker" ref={ref}>
      <button className="new-chat-chip" title={kind} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {kind === "技能" ? <SkillIcon /> : <PluginIcon />}
        <span className="new-chat-chip-label">{kind}</span>
      </button>
      {open && (
        <div className="menu capability-menu" role="menu">
          <input ref={inputRef} className="capability-search" value={search} placeholder={`搜索${kind}…`} onChange={(e) => setSearch(e.target.value)} />
          <div className="capability-list">
            {loose.map((item) => (
              <Item key={item.name} item={item} label={item.name} onPick={pick} />
            ))}
            {[...groups].map(([group, members]) => {
              const unfolded = !!keyword || expanded.includes(group);
              return (
                <div key={group} className="capability-group">
                  <button className="capability-item capability-group-head" aria-expanded={unfolded} title={unfolded ? "折叠" : "展开"} onClick={() => toggle(group)}>
                    <Avatar name={group} />
                    <span className="capability-name">{group}</span>
                    <span className="capability-group-count">{members.length}</span>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3.5 2 6.5 5l-3 3" />
                    </svg>
                  </button>
                  {unfolded && members.map((item) => <Item key={item.name} item={item} label={item.name.slice(group.length + 1)} onPick={pick} nested />)}
                </div>
              );
            })}
            {shown.length === 0 && <div className="capability-empty">{items.length ? `没有匹配的${kind}` : `暂无${kind}`}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Item({ item, label, onPick, nested }: { item: Capability; label: string; onPick: (name: string) => void; nested?: boolean }) {
  return (
    <button
      className={nested ? "capability-item capability-nested" : "capability-item"}
      role="menuitem"
      title={item.description ? `${item.name}\n${item.description}` : item.name}
      onClick={() => onPick(item.name)}
    >
      <Avatar name={label} />
      <span className="capability-name">{label}</span>
    </button>
  );
}

function SkillIcon() {
  return (
    <svg className="ic ic-skill" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8 13.4 4.9v6.2L8 14.2l-5.4-3.1V4.9z" fill="currentColor" fillOpacity="0.18" />
      <path d="M8 5.2 10.5 6.6v2.8L8 10.8 5.5 9.4V6.6z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PluginIcon() {
  return (
    <svg className="ic ic-plugin" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" fill="currentColor" fillOpacity="0.2" />
      <path d="M10.6 5.4v3.5a1.7 1.7 0 0 0 3.4 0V8a6 6 0 1 0-2.4 4.8" />
    </svg>
  );
}
