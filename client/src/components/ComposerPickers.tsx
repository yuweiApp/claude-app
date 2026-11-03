import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { EffortLevel, ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/** 点到弹层外面时关闭 */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

// ---- 权限：Claude Code 的 permissionMode，样式同 codex-app-server 的权限下拉框 ----

const PERMISSION_MODES: Array<{ mode: PermissionMode; label: string; hint: string; icon: ReactNode; full?: boolean }> = [
  { mode: "default", label: "每次询问", hint: "编辑文件、运行命令前都先问你", icon: <AskIcon /> },
  { mode: "acceptEdits", label: "自动接受编辑", hint: "直接编辑文件，运行命令前问你", icon: <ShieldIcon /> },
  { mode: "plan", label: "计划模式", hint: "只读代码、制定计划，不改文件", icon: <PlanIcon /> },
  { mode: "bypassPermissions", label: "完全访问权限", hint: "所有操作都不问直接执行，请谨慎使用", icon: <FullIcon />, full: true },
];

export function PermissionPicker({ value, onChange }: { value: string; onChange: (mode: PermissionMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const current = PERMISSION_MODES.find((m) => m.mode === value) ?? PERMISSION_MODES[0]!;
  return (
    <div className="perm-picker" ref={ref}>
      <button className={`perm-btn${current.full ? " perm-btn-full" : ""}`} onClick={() => setOpen((o) => !o)} title="更改权限" aria-haspopup="menu" aria-expanded={open}>
        {current.icon}
        {current.label}
      </button>
      {open && (
        <div className="perm-pop" role="menu">
          <div className="perm-pop-title">Claude 操作前要不要问你？</div>
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.mode}
              role="menuitemradio"
              aria-checked={m.mode === current.mode}
              className={`perm-item${m.full ? " perm-item-full" : ""}`}
              onClick={() => {
                onChange(m.mode);
                setOpen(false);
              }}
            >
              <span className="perm-item-icon">{m.icon}</span>
              <span className="perm-item-text">
                <span className="perm-item-label">{m.label}</span>
                <span className="perm-item-hint">{m.hint}</span>
              </span>
              {m.mode === current.mode && <span className="pick-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- 模型和推理强度：Claude Code 的模型列表（ModelInfo），样式同 codex-app-server 的模型胶囊 ----

const EFFORT_LABELS: Record<EffortLevel, string> = { low: "轻度", medium: "中", high: "高", xhigh: "极高", max: "Max" };

/** 去掉 Claude Code 给 1M 上下文版本加的 [1m] 后缀 */
const plainModel = (m: string) => m.replace(/\[1m\]$/i, "");

/** 胶囊里的短名：gpt-6-luna → 6 Luna，claude-fable-5-1 → Fable 5 1（同 codex-app-server 的 shortModel） */
function shortModel(model: string) {
  const m = plainModel(model);
  return m
    .slice(m.lastIndexOf("/") + 1)
    .replace(/^(gpt|claude)-/i, "")
    .replace(/-/g, " ")
    .replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/**
 * 别名（default / opus / sonnet / haiku）常常解析到同一个模型，按实际模型去重，只列一次；
 * 优先留不带 [1m] 的别名（第三方接口不一定认 1M 上下文的请求头）
 */
function distinctModels(models: ModelInfo[]): ModelInfo[] {
  const byModel = new Map<string, ModelInfo>();
  for (const m of models) {
    const key = plainModel(m.resolvedModel ?? m.value);
    const prev = byModel.get(key);
    if (!prev || (/\[1m\]$/i.test(prev.resolvedModel ?? "") && !/\[1m\]$/i.test(m.resolvedModel ?? ""))) byModel.set(key, m);
  }
  return [...byModel.values()];
}

interface ModelPickerProps {
  models: ModelInfo[];
  /** 当前的实际模型名（会话 init 报的，或新会话选的别名解析出来的） */
  model: string | undefined;
  effort: EffortLevel | undefined;
  onModel: (value: string) => void;
  onEffort: (effort: EffortLevel) => void;
}

export function ModelPicker({ models, model, effort, onModel, onEffort }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const list = distinctModels(models);
  const matched = search.trim() ? list.filter((m) => (m.resolvedModel ?? m.value).toLowerCase().includes(search.trim().toLowerCase())) : list;
  const pickModel = (value: string) => {
    onModel(value);
    setOpen(false);
    setSearch("");
  };
  const current = list.find((m) => model && plainModel(m.resolvedModel ?? m.value) === plainModel(model));
  const efforts = current?.supportedEffortLevels ?? (current?.supportsEffort === false ? [] : ["low", "medium", "high", "xhigh", "max"]);
  if (!model) return null;
  return (
    <div className="model-picker" ref={ref}>
      <button className="model-pill" data-effort={effort} onClick={() => setOpen((o) => !o)} title={`模型 ${plainModel(model)}${effort ? `，推理强度 ${EFFORT_LABELS[effort]}` : ""}`}>
        {shortModel(model)}
        {effort && <span className="model-pill-effort">{EFFORT_LABELS[effort]}</span>}
      </button>
      {open && (
        <div className="model-pop">
          {efforts.length > 0 && (
            <>
              <div className="model-pop-title">推理强度</div>
              <div className="effort-seg" role="radiogroup" aria-label="推理强度">
                {efforts.map((e) => (
                  <button key={e} role="radio" aria-checked={e === effort} className={e === effort ? "selected" : ""} onClick={() => onEffort(e)}>
                    {EFFORT_LABELS[e]}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="model-pop-title">模型</div>
          <input
            className="model-pop-search"
            autoFocus
            value={search}
            placeholder="搜索模型"
            spellCheck={false}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              // Enter 选中第一个匹配的模型（同 codex-app-server 的模型菜单）
              if (e.key === "Enter" && matched[0]) pickModel(matched[0].value);
            }}
          />
          <div className="model-pop-list">
            {matched.map((m) => {
              const name = plainModel(m.resolvedModel ?? m.value);
              const selected = m === current;
              return (
                <button
                  key={m.value}
                  className={`model-pop-item${selected ? " selected" : ""}`}
                  title={m.description}
                  onClick={() => pickModel(m.value)}
                >
                  <span>{name}</span>
                  {selected && <span className="pick-check">✓</span>}
                </button>
              );
            })}
            {list.length === 0 && <div className="model-pop-empty">读取模型列表中…</div>}
            {list.length > 0 && matched.length === 0 && <div className="model-pop-empty">没有匹配的模型</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 别名（default / opus…）解析出的实际模型名，新会话的胶囊用 */
export function resolveModel(models: ModelInfo[], value: string | undefined): string | undefined {
  if (!value) return undefined;
  return models.find((m) => m.value === value)?.resolvedModel ?? value;
}

// 图标同 codex-app-server 的 client/src/icons（ask、auto、plan、full）

function AskIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 8.5V3.5a1 1 0 0 1 2 0v4M7.5 7.5V2.5a1 1 0 0 1 2 0v5M9.5 7.5v-4a1 1 0 0 1 2 0V9.5a5 5 0 0 1-5 5h-.4a4 4 0 0 1-3.1-1.5L1.7 10.4a1 1 0 0 1 1.5-1.3L5.5 11" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.5 13 3.5v4c0 3.2-2.1 5.8-5 7-2.9-1.2-5-3.8-5-7v-4zM5.8 8l1.6 1.6 3-3.2" />
    </svg>
  );
}

function PlanIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.7.6 1.1v.2h4v-.2c0-.4.2-.8.6-1.1A4.5 4.5 0 0 0 8 1.5z" />
    </svg>
  );
}

function FullIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM8 4.8v3.8M8 11h.01" />
    </svg>
  );
}
