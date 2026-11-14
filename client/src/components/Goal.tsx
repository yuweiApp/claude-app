import { useEffect, useRef, useState } from "react";
import type { GoalState } from "../api";

/** 条件最多这么多字（Claude Code 的上限，网关也按它检查） */
const GOAL_MAX_LENGTH = 4000;

/** 目标的图标：靶心 */
export function GoalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <circle cx="8" cy="8" r="3.6" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * 输入框上面的目标栏：进行中的目标，没通过的检查次数；点文字展开看全文和最近一次检查的理由，
 * 右边是修改、取消
 */
export function GoalBar({ goal, onEdit, onClear }: { goal: GoalState; onEdit: () => void; onClear: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const clear = () => {
    setClearing(true);
    onClear().finally(() => setClearing(false));
  };
  return (
    <div className={open ? "goal-bar open" : "goal-bar"} aria-label="进行中的目标">
      <button className="goal-bar-main" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? "收起" : "展开查看全文"}>
        <span className="goal-bar-label">
          <GoalIcon />
          目标
        </span>
        <span className="goal-bar-text">{goal.condition}</span>
        {goal.checks > 0 && <span className="goal-bar-checks">{goal.checks} 次检查未通过</span>}
      </button>
      <span className="goal-bar-actions">
        <button onClick={onEdit} title="修改目标" aria-label="修改目标">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5V10.5Z" />
          </svg>
        </button>
        <button onClick={clear} disabled={clearing} title="取消目标" aria-label="取消目标">
          ×
        </button>
      </span>
      {open && (
        <div className="goal-bar-detail">
          <div className="goal-bar-full">{goal.condition}</div>
          {goal.lastReason && (
            <div className="goal-bar-reason">
              <span>最近一次检查：</span>
              {goal.lastReason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 设定、修改目标：输入框上面展开的一栏。Ctrl/⌘+Enter 提交，Esc 关掉。
 * running：这一轮还在进行，网关会先结束这一轮再设定
 */
export function GoalEditor({
  initial,
  running,
  onSubmit,
  onClose,
}: {
  initial: string;
  running: boolean;
  onSubmit: (condition: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const condition = text.trim();
  const tooLong = condition.length > GOAL_MAX_LENGTH;
  const editing = Boolean(initial);
  const submit = () => {
    if (!condition || tooLong || busy) return;
    setBusy(true);
    onSubmit(condition)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <div className="goal-editor">
      <div className="goal-editor-head">
        <GoalIcon />
        {editing ? "修改目标" : "设定目标"}
      </div>
      <textarea
        ref={ref}
        value={text}
        rows={3}
        placeholder="写清楚怎样算完成，例如：test/auth 下的测试全部通过（npm test 退出码为 0）"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="goal-editor-hint">
        设好后 AI 会一直做下去：每次它要停下时，另一个模型按这个条件检查对话，没达成就让它接着做，达成后目标自动结束。
        {running && " 这一轮会先停下，再按新目标开始。"}
      </div>
      <div className="goal-editor-foot">
        <span className={tooLong ? "goal-editor-count over" : "goal-editor-count"}>
          {condition.length} / {GOAL_MAX_LENGTH}
        </span>
        <button onClick={onClose} disabled={busy}>
          取消
        </button>
        <button className="primary" onClick={submit} disabled={!condition || tooLong || busy}>
          {busy ? "提交中…" : editing ? "更新目标" : "开始"}
        </button>
      </div>
    </div>
  );
}
