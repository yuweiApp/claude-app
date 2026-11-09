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

/** 输入框上面的「技能」「插件」：点开搜索和选择，选中后写进输入框 */
export function CapabilityPicker({ kind, items, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setSearch("");
  }, [open]);

  const keyword = search.trim().toLowerCase();
  const shown = items.filter((item) => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(keyword));

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
            {shown.map((item) => (
              <button
                key={item.name}
                className="capability-item"
                role="menuitem"
                title={item.description}
                onClick={() => {
                  setOpen(false);
                  onPick(item.name);
                }}
              >
                <Avatar name={item.name} />
                <span className="capability-name">{item.name}</span>
              </button>
            ))}
            {shown.length === 0 && <div className="capability-empty">{items.length ? `没有匹配的${kind}` : `暂无${kind}`}</div>}
          </div>
        </div>
      )}
    </div>
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
