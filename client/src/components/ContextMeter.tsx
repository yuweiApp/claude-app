import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, type ContextUsage, type SessionContextInfo } from "../api";
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
  /** 这一轮还在进行：不能压缩 */
  running: boolean;
  /** 正在压缩（自动的或手动的） */
  compacting: boolean;
  onError: (message: string) => void;
}

/** 输入框底部的上下文用量圆环，点开显示用量、距自动压缩还剩多少、「压缩会话」 */
export function ContextMeter({ sessionId, usage: live, running, compacting, onError }: Props) {
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
  }, [sessionId]);

  // 事件流的和网关记着的取新的那个
  const usage = live && (!info?.usage || live.at >= info.usage.at) ? live : (info?.usage ?? null);
  if (!usage) return null;
  // 刚压缩过：压缩后的用量要等模型下一次回复才知道
  const compacted = Boolean(usage.compacted);
  const limit = usage.threshold ?? usage.window;
  // 圆环填充是占窗口的比例，和弹层里的百分比一致
  const ratio = compacted ? 0 : Math.min(1, usage.used / usage.window);
  // 颜色：用到自动压缩阈值的一半以前是主题色，之后越来越红，到阈值时全红
  const red = compacted ? 0 : Math.max(0, Math.min(1, (usage.used / limit - 0.5) / 0.5));
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
    <div className="context-meter" ref={ref} style={{ "--context-red": `${Math.round(red * 100)}%` } as CSSProperties}>
      <button
        className={`context-ring${open ? " active" : ""}`}
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
        </div>
      )}
    </div>
  );
}
