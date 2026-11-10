import { useEffect, useRef, useState } from "react";
import { desktop } from "../desktop";
import { useDismiss } from "./ComposerPickers";

export function AccountMenu() {
  const [account, setAccount] = useState<{ username: string; displayName: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  useEffect(() => { void desktop?.account.info().then(setAccount).catch(() => {}); }, []);
  if (!account) return null;
  const name = account.displayName || account.username;
  return (
    <div className="account-menu" ref={ref}>
      <button className="account-avatar" title={name} aria-label={`账号：${name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{name.slice(0, 1).toUpperCase()}</button>
      {open && (
        <div className="account-popup" role="menu" aria-label="账号菜单">
          <strong>{name}</strong>
          <span>{account.username}</span>
          {error && <p role="alert">{error}</p>}
          <button role="menuitem" disabled={busy} onClick={async () => {
            setBusy(true);
            setError("");
            try { await desktop!.account.logout(); }
            catch { setError("退出失败，请重试"); setBusy(false); }
          }}>{busy ? "正在退出…" : "退出登录"}</button>
        </div>
      )}
    </div>
  );
}
