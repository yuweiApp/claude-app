import { useEffect, useRef, useState } from "react";
import { api, type ContextSettings, type ContextUsage, type SessionContextInfo } from "../api";
import { useDismiss } from "./ComposerPickers";

/** token 数写短：57k、258.4k、1.05M */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}k`;
  return String(n);
}

interface Props {
  sessionId: string;
  /** 事件流里最新的用量（context 事件），还没收到时 null，用网关记着的 */
  usage: ContextUsage | null;
  /** 这一轮还在进行：不能压缩、不能改设置 */
  running: boolean;
  /** 正在压缩（自动的或手动的） */
  compacting: boolean;
  /** 会话的模型：换了模型重新取设置（各模型的默认窗口不同） */
  model: string | undefined;
  onError: (message: string) => void;
}

/** 输入框底部的上下文用量圆环，点开显示用量、距自动压缩还剩多少、「压缩会话」和窗口设置 */
export function ContextMeter({ sessionId, usage: live, running, compacting, model, onError }: Props) {
  const [info, setInfo] = useState<SessionContextInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  useEffect(() => {
    setInfo(null);
    let stale = false;
    api.context(sessionId).then((next) => !stale && setInfo(next), () => undefined);
    return () => {
      stale = true;
    };
  }, [sessionId, model]);
  // 打开弹层时再取一次：设置可能在别的窗口改过
  useEffect(() => {
    if (open) api.context(sessionId).then(setInfo, () => undefined);
  }, [open, sessionId]);

  // 事件流的和网关记着的取新的那个
  const usage = live && (!info?.usage || live.at >= info.usage.at) ? live : (info?.usage ?? null);
  if (!usage) return null;
  // 刚压缩过：压缩后的用量要等模型下一次回复才知道
  const compacted = Boolean(usage.compacted);
  const limit = usage.threshold ?? usage.window;
  const ratio = compacted ? 0 : Math.min(1, usage.used / limit);
  const percent = Math.round((usage.used / usage.window) * 100);
  const summary = compacted ? "已压缩，下一轮对话后更新用量" : `上下文 ${formatTokens(usage.used)} / ${formatTokens(usage.window)}（${percent}%）`;
  const R = 6;
  const C = 2 * Math.PI * R;

  const compact = () => {
    setRequesting(true);
    api
      .compact(sessionId)
      .then(() => setOpen(false))
      .catch((e: Error) => onError(`压缩失败：${e.message}`))
      .finally(() => setRequesting(false));
  };

  return (
    <div className="context-meter" ref={ref}>
      <button
        className={`context-ring${open ? " active" : ""}${ratio >= 0.9 ? " warn" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={summary}
        aria-label="上下文窗口"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" className={compacting ? "compacting" : undefined}>
          <circle cx="8" cy="8" r={R} className="context-ring-track" />
          <circle
            cx="8"
            cy="8"
            r={R}
            className="context-ring-fill"
            strokeDasharray={`${ratio * C} ${C}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
      {open && (
        <div className="context-pop" role="dialog" aria-label="上下文窗口">
          <div className="context-pop-row">
            <span className="context-pop-title">上下文窗口</span>
            <span className="context-pop-value">
              {compacted ? `窗口 ${formatTokens(usage.window)}` :`${formatTokens(usage.used)} / ${formatTokens(usage.window)}（${percent}%）`}
            </span>
          </div>
          <div className="context-bar">
            <div className="context-bar-fill" style={{ width: `${compacted ? 0 : Math.min(100, (usage.used / usage.window) * 100)}%` }} />
            {usage.threshold !== null && <div className="context-bar-mark" style={{ left: `${(usage.threshold / usage.window) * 100}%` }} title={`用到 ${formatTokens(usage.threshold)} 时自动压缩`} />}
          </div>
          <div className="context-pop-row">
            <span className="context-pop-dim">
              {compacting
                ? "正在压缩…"
                : compacted
                  ? "已压缩，下一轮对话后更新用量"
                  : usage.threshold === null
                    ? "自动压缩已关闭"
                    : usage.used >= usage.threshold
                      ? "已到自动压缩的用量，下一次请求前压缩"
                      : `距自动压缩还剩 ${formatTokens(usage.threshold - usage.used)}`}
            </span>
            <button
              className="context-pop-btn"
              disabled={running || compacting || requesting}
              title={running ? "这一轮结束后才能压缩" : "把之前的对话总结成摘要，腾出上下文"}
              onClick={compact}
            >
              压缩会话
            </button>
          </div>
          {info && (info.adjustable ? (
            <ContextSettingsForm key={`${info.model}:${JSON.stringify(info.session)}:${JSON.stringify(info.modelDefault)}`} info={info} running={running} onSaved={setInfo} sessionId={sessionId} onError={onError} />
          ) : (
            <div className="context-set">
              <span className="context-set-hint">这个模型的窗口按 Claude Code 自己的模型表，不能改</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 窗口大小和自动压缩阈值：拖动只改草稿，「应用」才保存（子进程空闲时网关重启它） */
function ContextSettingsForm({
  info,
  running,
  sessionId,
  onSaved,
  onError,
}: {
  info: SessionContextInfo;
  running: boolean;
  sessionId: string;
  onSaved: (info: SessionContextInfo) => void;
  onError: (message: string) => void;
}) {
  const { limits, buffer } = info;
  // 会话没设时继承的：模型默认，再是网关默认
  const inheritedWindow = info.modelDefault.contextWindow ?? info.defaultWindow;
  const savedWindow = info.session.contextWindow ?? inheritedWindow;
  const [size, setSize] = useState(savedWindow);
  // 阈值的范围：自动压缩窗口（阈值 + buffer）不小于 Claude Code 的下限，最大是不设时 Claude Code 自己的（窗口 − buffer）
  const maxPercent = Math.floor(((size - buffer) / size) * 100);
  const minPercent = Math.min(maxPercent, Math.ceil(((limits.minAutoCompactWindow - buffer) / size) * 100));
  const inheritedPercent = info.modelDefault.autoCompactPercent;
  const savedPercent = info.session.autoCompactPercent ?? inheritedPercent;
  const [percentDraft, setPercent] = useState<number | null>(savedPercent);
  // null 是不设（Claude Code 自己的阈值），显示成最大值
  const percent = percentDraft === null ? maxPercent : Math.max(minPercent, Math.min(maxPercent, percentDraft));
  const threshold = percentDraft === null || percent >= maxPercent ? size - buffer : Math.round((size * percent) / 100);
  const [saving, setSaving] = useState(false);

  // 要保存的：拖到最右边的阈值等于不设
  const next: ContextSettings = { contextWindow: size, autoCompactPercent: percentDraft === null || percent >= maxPercent ? null : percent };
  const changed = next.contextWindow !== savedWindow || next.autoCompactPercent !== savedPercent;
  const save = (settings: ContextSettings, asModelDefault: boolean) => {
    setSaving(true);
    api
      .setContext(sessionId, settings, asModelDefault)
      .then(onSaved)
      .catch((e: Error) => onError(`保存上下文设置失败：${e.message}`))
      .finally(() => setSaving(false));
  };
  // 会话自己的设置：和继承的一样的项不单独记
  const sessionSettings: ContextSettings = {
    contextWindow: next.contextWindow === inheritedWindow ? null : next.contextWindow,
    autoCompactPercent: next.autoCompactPercent === inheritedPercent ? null : next.autoCompactPercent,
  };
  const hasOverride = info.session.contextWindow !== null || info.session.autoCompactPercent !== null;
  const modelIsSame = (info.modelDefault.contextWindow ?? info.defaultWindow) === size && info.modelDefault.autoCompactPercent === next.autoCompactPercent;

  return (
    <div className="context-set">
      <label className="context-set-row">
        <span className="context-set-label">窗口大小</span>
        <input
          type="range"
          min={limits.minWindow}
          max={limits.maxWindow}
          step={1000}
          value={size}
          disabled={saving}
          onChange={(e) => setSize(Number(e.target.value))}
        />
        <span className="context-set-value">
          {formatTokens(size)}
          {size === inheritedWindow && "（默认）"}
        </span>
      </label>
      <label className="context-set-row">
        <span className="context-set-label">自动压缩</span>
        <input type="range" min={minPercent} max={maxPercent} step={1} value={percent} disabled={saving} onChange={(e) => setPercent(Number(e.target.value))} />
        <span className="context-set-value">
          {percent}%{next.autoCompactPercent === null && "（默认）"}
        </span>
      </label>
      <span className="context-set-hint">
        用到 {formatTokens(threshold)} 时自动压缩。{info.session.contextWindow === null && info.session.autoCompactPercent === null && !changed ? "现在用的是默认设置" : "只对这个会话生效"}
      </span>
      <span className="context-set-hint">窗口要和模型实际支持的一致，设大了请求会在模型那边超限报错</span>
      {running && changed && <span className="context-set-hint warn">这一轮结束后再应用</span>}
      <div className="context-set-actions">
        <button className="context-pop-btn" disabled={saving || running || modelIsSame} title={`以后 ${info.model} 的会话默认用这个设置`} onClick={() => save(next, true)}>
          设为模型默认
        </button>
        <button className="context-pop-btn" disabled={saving || running || !hasOverride} title="去掉这个会话自己的设置，用模型默认" onClick={() => save({ contextWindow: null, autoCompactPercent: null }, false)}>
          恢复默认
        </button>
        <button className="context-pop-btn primary" disabled={saving || running || !changed} onClick={() => save(sessionSettings, false)}>
          应用
        </button>
      </div>
    </div>
  );
}
