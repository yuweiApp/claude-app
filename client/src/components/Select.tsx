import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useDismiss } from "./ComposerPickers";

export interface SelectOption {
  value: string;
  label: string;
}

/** 代替原生 <select> 的下拉框：按钮 + 弹出列表，样式和其他弹层一致。支持方向键、回车、Esc */
export function Select({
  value,
  options,
  onChange,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const currentIndex = options.findIndex((o) => o.value === value);
  const current = options[currentIndex];

  // 打开时高亮当前选中的一项并滚到它
  useEffect(() => {
    if (open) setActive(Math.max(0, currentIndex));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  // 列表宽度按内容算（width: max-content）时不含竖向滚动条，出了滚动条文字会被挤掉：把滚动条的宽度补上
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!open || !el) return;
    const style = getComputedStyle(el);
    const scrollbar = el.offsetWidth - el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    if (scrollbar > 0) el.style.width = `${el.offsetWidth + scrollbar}px`;
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[active];
      if (o) pick(o.value);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={`select${className ? ` ${className}` : ""}`} ref={ref}>
      <button
        type="button"
        className={`select-btn${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{current?.label ?? ""}</span>
        <svg className="select-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="select-pop" role="listbox" aria-label={ariaLabel} ref={listRef}>
          {options.map((o, i) => (
            <button
              type="button"
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              tabIndex={-1}
              className={`select-item${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
            >
              <span className="select-item-label">{o.label}</span>
              {o.value === value && (
                <svg className="select-check" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M3 7.5 5.8 10 11 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
