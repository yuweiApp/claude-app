import { useCallback, useEffect, useRef, useState } from "react";
import { api, type FileTransfer } from "../api";
import { desktop, fileManagerName } from "../desktop";

/**
 * 文件树的上传、下载。桌面版连着本机的网关时「直传」：界面只给出文件在这台机器上的路径（拖进来的文件、系统的打开/保存对话框），
 * 网关直接在本机路径和项目里的路径之间复制（远程会话经 SFTP，多个请求同时发），内容不经过 HTTP，界面轮询进度。
 * 网页版、网关在别的机器上时走 HTTP：上传是 multipart（XHR 报进度），下载交给浏览器
 */

let directCheck: Promise<boolean> | null = null;
/** 能不能直传；还不知道时 null */
function useDirect(): boolean | null {
  const [direct, setDirect] = useState<boolean | null>(desktop?.files ? null : false);
  useEffect(() => {
    if (!desktop?.files) return;
    directCheck ??= desktop.files.localGateway().catch(() => false);
    let alive = true;
    void directCheck.then((d) => alive && setDirect(d));
    return () => {
      alive = false;
    };
  }, []);
  return direct;
}

/** 要上传的一个文件：直传是本机路径，HTTP 是浏览器里的 File */
export type UploadItem = { name: string; local: string } | { name: string; file: File };

/** 界面上的一行；HTTP 上传的一批文件是一行，abort 取消 */
type Row = FileTransfer & { abort?: () => void; startedAt?: number };

const POLL_MS = 500;
/** 上传完的行留一会儿再自动关掉（文件已经出现在树里了）；下载完的留着，可以点「在…中显示」 */
const UPLOADED_SHOWN_MS = 3000;

const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
const parentDir = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "");

export function useFileTransfers(cwd: string, onUploaded: (dir: string) => void) {
  const direct = useDirect();
  const [gateway, setGateway] = useState<FileTransfer[]>([]);
  const [http, setHttp] = useState<Row[]>([]);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;
  /** 每个传输上次看到的状态：上传从没传完变成传完时刷新那个文件夹 */
  const seen = useRef(new Map<string, FileTransfer["state"]>());

  const poll = useCallback(async () => {
    const list = await api.transfers(cwd).catch(() => null);
    if (!list) return;
    for (const t of list) {
      const prev = seen.current.get(t.id);
      seen.current.set(t.id, t.state);
      if (t.kind === "upload" && t.state === "done" && prev !== "done") {
        onUploadedRef.current(parentDir(t.path));
        window.setTimeout(() => void api.dismissTransfer(t.id).then(poll, () => undefined), UPLOADED_SHOWN_MS);
      }
    }
    setGateway(list);
  }, [cwd]);

  // 打开时取一次（刷新页面后接上进行中的），有没传完的就一直轮询
  useEffect(() => {
    if (direct) void poll();
  }, [direct, poll]);
  const active = gateway.some((t) => t.state === "queued" || t.state === "running");
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, poll]);

  /** HTTP 上传：一批文件一个请求 */
  const httpUpload = (dir: string, files: File[], overwrite: boolean) => {
    const id = `http-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const total = files.reduce((n, f) => n + f.size, 0);
    const name = files.length === 1 ? files[0]!.name : `${files[0]!.name} 等 ${files.length} 个文件`;
    const update = (patch: Partial<Row>) => setHttp((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const remove = () => setHttp((rows) => rows.filter((r) => r.id !== id));
    const startedAt = Date.now();
    const { done, abort } = api.uploadFiles(cwd, dir, files, overwrite, (sent) => {
      const ms = Date.now() - startedAt;
      update({ done: Math.min(sent, total), speed: ms > 0 ? Math.round((sent / ms) * 1000) : 0 });
    });
    setHttp((rows) => [...rows, { id, cwd, kind: "upload", name, path: dir + name, local: "", state: "running", done: 0, total, speed: 0, abort, startedAt }]);
    done.then(
      () => {
        update({ state: "done", done: total });
        onUploadedRef.current(dir);
        window.setTimeout(remove, UPLOADED_SHOWN_MS);
      },
      (err: Error) => {
        if (err.name === "AbortError") return remove();
        update({ state: "error", error: err.message });
        // 一批里前面传好了的已经存下了
        onUploadedRef.current(dir);
      },
    );
  };

  return {
    /** null：还不知道能不能直传，菜单先不给上传、下载 */
    ready: direct !== null,
    rows: [...gateway, ...http] as Row[],
    /** 选要上传的文件：直传是系统的打开对话框，HTTP 是浏览器的文件选择；取消时 null */
    async pick(): Promise<UploadItem[] | null> {
      if (direct && desktop?.files) {
        const paths = await desktop.files.pickFiles();
        return paths ? paths.map((local) => ({ name: baseName(local), local })) : null;
      }
      const files = await pickBrowserFiles();
      return files?.length ? files.map((file) => ({ name: file.name, file })) : null;
    },
    /** 拖进来的文件；文件夹在 folders 里（不能上传） */
    fromDrop(data: DataTransfer): { items: UploadItem[]; folders: string[] } {
      const items: UploadItem[] = [];
      const folders: string[] = [];
      [...data.items].forEach((item) => {
        if (item.kind !== "file") return;
        const file = item.getAsFile();
        if (!file) return;
        if (item.webkitGetAsEntry()?.isDirectory) return void folders.push(file.name);
        const local = direct && desktop?.files ? desktop.files.pathForFile(file) : "";
        items.push(local ? { name: file.name, local } : { name: file.name, file });
      });
      return { items, folders };
    },
    /** 传进项目里的文件夹 dir（"" 是根，否则以 / 结尾）；overwrite：同名的文件覆盖（先问过用户） */
    async upload(dir: string, items: UploadItem[], overwrite: boolean): Promise<void> {
      const locals = items.flatMap((i) => ("local" in i ? [i.local] : []));
      const files = items.flatMap((i) => ("file" in i ? [i.file] : []));
      if (locals.length) {
        await api.startUpload(cwd, dir.replace(/\/$/, ""), locals, overwrite);
        await poll();
      }
      if (files.length) httpUpload(dir, files, overwrite);
    },
    /** 下载项目里的文件：直传先弹保存对话框，取消了什么都不做；HTTP 交给浏览器 */
    async download(path: string): Promise<void> {
      const name = baseName(path);
      if (direct && desktop?.files) {
        const local = await desktop.files.pickSavePath(name);
        if (!local) return;
        await api.startDownload(cwd, path, local);
        await poll();
        return;
      }
      const a = document.createElement("a");
      a.href = api.downloadUrl(cwd, path);
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
    },
    /** 取消进行中的，或者关掉结束了的 */
    dismiss(row: Row) {
      if (row.abort && row.state === "running") return row.abort();
      if (row.id.startsWith("http-")) return setHttp((rows) => rows.filter((r) => r.id !== row.id));
      setGateway((rows) => rows.filter((r) => r.id !== row.id));
      void api.dismissTransfer(row.id).catch(() => undefined);
    },
  };
}

function pickBrowserFiles(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => resolve(input.files ? [...input.files] : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** 文件树筛选框下面的传输列表：文件名、进度条、进度或结果；进行中的能取消，结束了的能关掉 */
export function TransferList({ rows, onDismiss }: { rows: Row[]; onDismiss: (row: Row) => void }) {
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  if (!rows.length) return null;
  return (
    <div className="file-transfers" role="status">
      {rows.map((t) => {
        const running = t.state === "running" || t.state === "queued";
        const ratio = t.total > 0 ? Math.min(1, t.done / t.total) : t.state === "done" ? 1 : 0;
        const canShow = t.kind === "download" && t.state === "done" && !missing.has(t.id) && desktop;
        return (
          <div key={t.id} className={`file-transfer ${t.state}`} title={t.kind === "upload" ? `${t.local || t.name}\n→ ${t.path}` : `${t.path}\n→ ${t.local}`}>
            <span className="file-transfer-icon" aria-hidden="true">
              {t.kind === "upload" ? "↑" : "↓"}
            </span>
            <div className="file-transfer-text">
              <span className="file-transfer-name">{t.name}</span>
              <span className="file-transfer-status">{missing.has(t.id) ? "文件已被删除或移走" : transferStatus(t)}</span>
              {running && (
                <div className="file-transfer-bar" aria-hidden="true">
                  <div style={{ width: `${ratio * 100}%` }} />
                </div>
              )}
            </div>
            {canShow && (
              <button
                className="btn-small"
                onClick={() => void desktop!.showItemInFolder(t.local).then((ok) => !ok && setMissing((m) => new Set(m).add(t.id)))}
              >
                在{fileManagerName}中显示
              </button>
            )}
            <button className="icon-btn file-tree-btn" title={running ? "取消" : "关闭"} aria-label={running ? "取消" : "关闭"} onClick={() => onDismiss(t)}>
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

function transferStatus(t: Row): string {
  switch (t.state) {
    case "queued":
      return "等待中";
    case "running": {
      // HTTP 上传的进度是发给网关的字节数，发完了网关可能还在往远端写
      if (t.id.startsWith("http-") && t.total > 0 && t.done >= t.total) return `已发送 ${formatBytes(t.total)}，等待写入完成…`;
      const pct = t.total > 0 ? `${Math.floor((t.done / t.total) * 100)}% · ` : "";
      const speed = t.speed > 0 ? ` · ${formatBytes(t.speed)}/s` : "";
      return `${pct}${formatBytes(t.done)} / ${formatBytes(t.total)}${speed}`;
    }
    case "done":
      return t.kind === "upload" ? `已上传 · ${formatBytes(t.total)}` : `已下载到 ${folderOf(t.local)}`;
    default:
      return t.error || "失败";
  }
}

function folderOf(file: string): string {
  const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return i > 0 ? file.slice(0, i) : file;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
