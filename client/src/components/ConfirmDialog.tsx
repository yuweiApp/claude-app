import { useEffect, useRef } from "react";

interface Props {
  title: string;
  /** 不传就只有标题 */
  message?: string;
  confirmLabel: string;
  /** 操作进行中：确认按钮转圈、显示这段文字，两个按钮都不能点，Esc 和点外面也不关 */
  busy?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 危险操作的确认框：默认焦点在「取消」上，回车、Esc、点外面都不会执行操作 */
export function ConfirmDialog({ title, message, confirmLabel, busy, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => !busy && e.target === e.currentTarget && onCancel()}>
      <div className="dialog confirm-dialog" role="alertdialog" aria-label={title} aria-busy={!!busy}>
        <h3>{title}</h3>
        {message && <p className="confirm-message">{message}</p>}
        <div className="dialog-actions">
          <button ref={cancelRef} onClick={onCancel} disabled={!!busy}>
            取消
          </button>
          <button className={busy ? "danger busy" : "danger"} onClick={onConfirm} disabled={!!busy}>
            {busy && <span className="confirm-spinner" aria-hidden />}
            {busy ?? confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
