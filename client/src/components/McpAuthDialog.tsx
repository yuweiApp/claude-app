import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type McpAuthState } from "../api";

/**
 * MCP 服务器的 OAuth 登录：网关让 Claude Code 开始登录，拿到登录页在浏览器里打开；Claude Code 在网关那台电脑的 localhost 上等回调，
 * 换好令牌、连上服务器后这里查到 done 自动关掉。网页和网关不在同一台电脑上时，回调页打不开，把地址栏里的网址贴回来交给网关
 */
export function McpAuthDialog({ name, onClose }: { name: string; onClose: (done: boolean) => void }) {
  const [auth, setAuth] = useState<McpAuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [callback, setCallback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const finished = useRef(false);

  const close = (done: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (!done) void api.cancelMcpAuth(name).catch(() => {});
    onClose(done);
  };

  // 开始登录；桌面版的 window.open 由外壳交给系统浏览器，网页版可能被拦截弹窗，对话框里还有链接
  useEffect(() => {
    let cancelled = false;
    setAuth(null);
    setError(null);
    api.startMcpAuth(name).then(
      (state) => {
        if (cancelled) return;
        if (state.state === "done") return close(true);
        setAuth(state);
        if (state.authUrl) window.open(state.authUrl, "_blank", "noopener");
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [name, attempt]);

  // 等用户在浏览器里登录完
  const waiting = auth?.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      api.mcpAuth(name).then(
        (state) => {
          if (state.state === "done") close(true);
          else if (state.state === "failed") setAuth(state);
        },
        () => {},
      );
    }, 1500);
    return () => clearInterval(timer);
  }, [name, waiting]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    api
      .submitMcpAuthCallback(name, callback.trim())
      .then(
        (state) => (state.state === "done" ? close(true) : setAuth(state)),
        (err: Error) => setError(err.message),
      )
      .finally(() => setSubmitting(false));
  };

  const failed = auth?.state === "failed" ? (auth.error ?? "登录失败") : null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <form className="dialog settings-form mcp-dialog" aria-label={`登录 ${name}`} onSubmit={submit}>
        <h3>登录 {name}</h3>
        {!auth && !error && <p className="mcp-hint">正在连接服务器…</p>}
        {waiting && (
          <>
            <p className="mcp-auth-text">
              已在浏览器中打开登录页，登录并授权后这里会自动完成。没有打开的话，
              <a href={auth.authUrl} target="_blank" rel="noreferrer">
                点这里打开登录页
              </a>
              。
            </p>
            <label>
              浏览器停在打不开的 localhost 页面时（网关不在这台电脑上会这样），把地址栏里的完整网址粘贴到这里
              <input value={callback} onChange={(e) => setCallback(e.target.value)} placeholder="http://localhost:…/callback?code=…" />
            </label>
          </>
        )}
        {failed && <div className="settings-error">{failed}</div>}
        {error && <div className="settings-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={() => close(false)}>
            取消
          </button>
          {waiting ? (
            <button type="submit" className="primary" disabled={!callback.trim() || submitting}>
              {submitting ? "提交中…" : "提交网址"}
            </button>
          ) : (
            (failed || error) && (
              <button type="button" className="primary" onClick={() => setAttempt((n) => n + 1)}>
                重新登录
              </button>
            )
          )}
        </div>
      </form>
    </div>
  );
}
