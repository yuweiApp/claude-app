import { useEffect, useState, type ReactNode } from "react";

/** 消息下面的一行操作，鼠标移到这条消息上才显示（同 codex-app-server 的 MessageActions） */
export function MessageActions({ children, align }: { children: ReactNode; align: "start" | "end" }) {
  return <div className={`msg-actions msg-actions-${align}`}>{children}</div>;
}

/**
 * 复制按钮：点后短暂显示勾（同 codex-app-server 的 CopyAction，图标是它的 turn-view-copy / turn-view-check）。
 * text 可以是函数，点击时再取（代码块从 DOM 里读文字）
 */
export function CopyAction({ text, title, className }: { text: string | (() => string); title: string; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      className={className ? `msg-action ${className}` : "msg-action"}
      title={state === "done" ? "已复制" : state === "error" ? "复制失败" : title}
      aria-label={title}
      onClick={() => navigator.clipboard.writeText(typeof text === "function" ? text() : text).then(() => setState("done"), () => setState("error"))}
    >
      {state === "done" ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5.5 5.5V3a1 1 0 0 1 1-1H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-2.5M3 5.5h6.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z" />
        </svg>
      )}
    </button>
  );
}

/** 分叉按钮：从这条消息开一个新会话，这个会话不变；请求期间禁用（同 Claude 桌面版的 Fork from here） */
export function ForkAction({ onFork }: { onFork: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const title = "从这里分叉：开一个新会话，接着这条回复继续，当前会话保持不变";
  return (
    <button
      className="msg-action"
      title={busy ? "分叉中…" : title}
      aria-label="从这里分叉"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        onFork().finally(() => setBusy(false));
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="4" cy="3.5" r="1.5" />
        <circle cx="12" cy="3.5" r="1.5" />
        <circle cx="8" cy="12.5" r="1.5" />
        <path d="M4 5v1a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V5M8 8v3" />
      </svg>
    </button>
  );
}
