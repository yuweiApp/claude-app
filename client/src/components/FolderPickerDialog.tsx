import { Fragment, useEffect, useState } from "react";
import { api, type FolderListing } from "../api";
import { machinePath, remoteUri } from "../remote";
import { sshName } from "../state/sshConnections";

/**
 * 「选择文件夹」对话框（同 codex-app-server 的 FolderPickerDialog）：浏览网关这台机器上的文件夹。
 * 上面是路径框（可以直接输入，回车或「前往」），下面是可以点的路径，再下面是子文件夹（第一行 .. 是上一级）。
 * host 是 SSH 连接 id 时浏览那台远程主机：网关收发的路径都是 ssh://<id>/…，这里显示、输入的是远端路径；
 * 可以「不选文件夹」，会话开在远端的 ~/.claude-app/workspace 下
 */
export function FolderPickerDialog({ initial, host, onPick, onClose }: { initial?: string; host?: string; onPick: (path: string) => void; onClose: () => void }) {
  /** 远端路径换成网关要的写法 */
  const target = (p: string) => (host ? remoteUri(host, p) : p);
  const [dir, setDir] = useState<FolderListing | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const go = (path?: string) => {
    setLoading(true);
    api.folders(path).then(
      (d) => {
        setDir(d);
        setInput(machinePath(d.path));
        setError(null);
        setLoading(false);
      },
      (e: Error) => {
        setError(e.message);
        setLoading(false);
      },
    );
  };

  useEffect(() => go(initial), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 可以点的路径：/ › home › yuw › …；Windows 的路径（本机或远端）是 C: › Users › …
  const crumbs = dir ? pathCrumbs(machinePath(dir.path)).map((c) => ({ name: c.name, path: target(c.path) })) : [];

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog folder-dialog" role="dialog" aria-label="选择文件夹">
        <h3>{host ? `选择「${sshName(host)}」上的文件夹` : "选择文件夹"}</h3>
        <form
          className="folder-path"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) go(target(input.trim()));
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder={dir && /^[a-z]:/i.test(machinePath(dir.path)) ? "C:\\…" : "/home/…"} />
          <button type="submit">前往</button>
        </form>
        {dir && (
          <div className="folder-crumbs">
            <button onClick={() => go(dir.home)} title={machinePath(dir.home)}>
              ~
            </button>
            <span className="folder-crumbs-gap" />
            <button onClick={() => go(target("/"))}>/</button>
            {crumbs.map((c, i) => (
              <Fragment key={c.path}>
                <span className="folder-crumb-sep">›</span>
                <button className={i === crumbs.length - 1 ? "current" : undefined} onClick={() => go(c.path)}>
                  {c.name}
                </button>
              </Fragment>
            ))}
          </div>
        )}
        {error && <div className="folder-error">{error}</div>}
        <div className={`folder-list${loading ? " loading" : ""}`}>
          {dir?.parent && (
            <button className="folder-entry" onClick={() => go(dir.parent!)}>
              ..
            </button>
          )}
          {dir?.entries.map((e) => (
            <button key={e.path} className="folder-entry" onClick={() => go(e.path)} title={machinePath(e.path)}>
              {e.name}
            </button>
          ))}
          {dir && dir.entries.length === 0 && <div className="folder-empty">没有子文件夹</div>}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>取消</button>
          {host && <button onClick={() => onPick(remoteUri(host))} title="会话开在远端的 ~/.claude-app/workspace 下">不选文件夹</button>}
          <button className="primary" disabled={!dir} onClick={() => dir && onPick(dir.path)}>
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}

/** 路径的每一级和到那一级的路径：/home/yuw → home、yuw；C:\Users\x → C:、Users、x（到 C: 那一级是 C:\） */
function pathCrumbs(p: string): { name: string; path: string }[] {
  const win = /^[a-z]:/i.test(p);
  const parts = p.split(win ? /[\\/]/ : "/").filter(Boolean);
  return parts.map((name, i) => ({
    name,
    path: win ? `${parts.slice(0, i + 1).join("\\")}${i === 0 ? "\\" : ""}` : `/${parts.slice(0, i + 1).join("/")}`,
  }));
}
