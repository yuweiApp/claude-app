import { useEffect, useState } from "react";
import { api, type FolderListing } from "../api";

/**
 * 「选择文件夹」对话框（同 codex-app-server 的 FolderPickerDialog）：浏览网关这台机器上的文件夹。
 * 上面是路径框（可以直接输入，回车或「前往」），下面是可以点的路径，再下面是子文件夹（第一行 .. 是上一级）
 */
export function FolderPickerDialog({ initial, onPick, onClose }: { initial?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [dir, setDir] = useState<FolderListing | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const go = (path?: string) => {
    setLoading(true);
    api.folders(path).then(
      (d) => {
        setDir(d);
        setInput(d.path);
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

  // 可以点的路径：/ › home › yuw › …
  const crumbs = dir ? dir.path.split("/").filter(Boolean).map((name, i, all) => ({ name, path: "/" + all.slice(0, i + 1).join("/") })) : [];

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog folder-dialog" role="dialog" aria-label="选择文件夹">
        <h3>选择文件夹</h3>
        <form
          className="folder-path"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) go(input.trim());
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder="/home/…" />
          <button type="submit">前往</button>
        </form>
        {dir && (
          <div className="folder-crumbs">
            <button onClick={() => go(dir.home)} title={dir.home}>
              ~
            </button>
            <button onClick={() => go("/")}>/</button>
            {crumbs.map((c) => (
              <button key={c.path} onClick={() => go(c.path)}>
                {c.name}
              </button>
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
            <button key={e.path} className="folder-entry" onClick={() => go(e.path)} title={e.path}>
              {e.name}
            </button>
          ))}
          {dir && dir.entries.length === 0 && <div className="folder-empty">没有子文件夹</div>}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={!dir} onClick={() => dir && onPick(dir.path)}>
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}
