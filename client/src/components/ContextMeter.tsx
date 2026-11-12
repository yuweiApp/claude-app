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
  /** 新对话还没有会话时 undefined：只显示空圆环 */
  sessionId: string | undefined;
  /** 事件流里最新的用量（context 事件），还没收到时 null，用网关记着的 */
  usage: ContextUsage | null;
  /** 这一轮还在进行：不能压缩 */
  running: boolean;
  /** 正在压缩（自动的或手动的） */
  compacting: boolean;
  onError: (message: string) => void;
}

/** 输入框底部的上下文用量圆环，点开显示用量、距自动压缩还剩多少、「压缩会话」。还没有用量时是空圆环 */
export function ContextMeter({ sessionId, usage: live, running, compacting, onError }: Props) {
  const [info, setInfo] = useState<SessionContextInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  useEffect(() => {
    setInfo(null);
    if (!sessionId) return;
    let stale = false;
    api.context(sessionId).then((next) => !stale && setInfo(next), () => undefined);
    return () => {
      stale = true;
    };
  }, [sessionId]);

  // 事件流的和网关记着的取新的那个；新对话不用（切到新对话时事件流的可能还是上一个会话的）
  const usage = !sessionId ? null : live && (!info?.usage || live.at >= info.usage.at) ? live : (info?.usage ?? null);
  // 刚压缩过：压缩后的用量要等模型下一次回复才知道
  const compacted = Boolean(usage?.compacted);
  // 有可显示的用量
  const shown = usage && !compacted ? usage : null;
  // 圆环填充是占窗口的比例，和弹层里的百分比一致
  const ratio = shown ? Math.min(1, shown.used / shown.window) : 0;
  // 颜色：用到自动压缩阈值的一半以前是主题色，之后越来越红，到阈值时全红
  const red = shown ? Math.max(0, Math.min(1, (shown.used / (shown.threshold ?? shown.window) - 0.5) / 0.5)) : 0;
  const percent = shown ? Math.round((shown.used / shown.window) * 100) : 0;
  const summary = shown
    ? `上下文 ${formatTokens(shown.used)} / ${formatTokens(shown.window)}（${percent}%）`
    : compacted
      ? "已压缩，下一轮对话后更新用量"
      : "上下文：发送消息后显示用量";
  const R = 6;
  const C = 2 * Math.PI * R;

  const compact = () => {
    if (!sessionId) return;
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
          {ratio > 0 && (
            <circle
              cx="8"
              cy="8"
              r={R}
              className="context-ring-fill"
              strokeDasharray={`${ratio * C} ${C}`}
              transform="rotate(-90 8 8)"
            />
          )}
        </svg>
      </button>
      {open && (
        <div className="context-pop" role="dialog" aria-label="上下文窗口">
          <div className="context-pop-row">
            <span className="context-pop-title">上下文窗口</span>
            <span className="context-pop-value">
              {shown ? `${formatTokens(shown.used)} / ${formatTokens(shown.window)}（${percent}%）` : usage ? `窗口 ${formatTokens(usage.window)}` : ""}
            </span>
          </div>
          <div className="context-bar">
            <div className="context-bar-fill" style={{ width: `${ratio * 100}%` }} />
            {usage && usage.threshold !== null && (
              <div className="context-bar-mark" style={{ left: `${(usage.threshold / usage.window) * 100}%` }} title={`用到 ${formatTokens(usage.threshold)} 时自动压缩`} />
            )}
          </div>
          <div className="context-pop-row">
            <span className="context-pop-dim">
              {compacting
                ? "正在压缩…"
                : !usage
                  ? "发送消息后显示用量"
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
              disabled={!sessionId || running || compacting || requesting}
              title={!sessionId ? "还没有对话" : running ? "这一轮结束后才能压缩" : "把之前的对话总结成摘要，腾出上下文"}
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
