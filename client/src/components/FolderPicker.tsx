import { HostIcon, HostStatusDot } from "./HostIcon";
import { useEffect, useRef, useState } from "react";
import { desktop } from "../desktop";
import { machinePath, parseRemote, remoteUri } from "../remote";
import { refreshSshConnections, useSshConnections } from "../state/sshConnections";
import { FolderPickerDialog } from "./FolderPickerDialog";
import { folderName } from "./Sidebar";

interface Props {
  /** 选中的文件夹，null 是没选（在默认工作目录里跑，侧边栏归到「无文件夹」） */
  value: string | null;
  /** 最近用过的文件夹（会话的工作目录） */
  recent: string[];
  onChange: (cwd: string | null) => void;
}

/** 点菜单外面时关掉 */
function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);
  return ref;
}

/**
 * 新会话在哪台机器上跑（同 Claude 桌面版新会话栏的环境选择）：本机或某个 SSH 连接。只有添加过 SSH 连接时才显示。
 * 换环境时文件夹清空：本机是 null，远程主机是 ssh://<id>（不选文件夹，开在远端的 workspace 下）
 */
export function EnvPicker({ value, onChange, onManage }: { value: string | null; onChange: (cwd: string | null) => void; onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const connections = useSshConnections();
  const host = parseRemote(value)?.host ?? null;
  const current = host ? connections.find((c) => c.id === host) : null;
  if (!connections.length && !host) return null;

  const pick = (id: string | null) => {
    setOpen(false);
    if (id !== host) onChange(id ? remoteUri(id) : null);
  };

  return (
    <div className="folder-picker" ref={ref}>
      <button
        className="new-chat-chip"
        onClick={() => {
          // 列表里的连接状态可能是早先取的（会话用到主机时也会连上、断开），展开时刷新
          if (!open) void refreshSshConnections();
          setOpen((o) => !o);
        }}
        title={current ? `在 ${current.name}（${current.host}）上运行` : "在这台电脑上运行"}>
        {host ? <HostIcon hostId={host} /> : <LaptopIcon />}
        <span className="new-chat-chip-label">{host ? (current?.name ?? host) : "本机"}</span>
      </button>
      {open && (
        <div className="menu env-menu" role="menu">
          <button className={`menu-item env-item${host === null ? " selected" : ""}`} onClick={() => pick(null)}>
            <LaptopIcon />
            <span className="env-item-text">
              <span className="menu-item-name">本机</span>
            </span>
          </button>
          <div className="menu-label">SSH</div>
          {connections.map((c) => (
            <button key={c.id} className={`menu-item env-item${host === c.id ? " selected" : ""}`} onClick={() => pick(c.id)} title={c.host}>
              <HostIcon hostId={c.id} />
              <span className="env-item-text">
                <span className="menu-item-name">{c.name}</span>
                <span className="menu-item-sub">{c.host}</span>
              </span>
              <HostStatusDot hostId={c.id} />
            </button>
          ))}
          <div className="menu-divider" />
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <span className="menu-item-name">管理 SSH 连接…</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 新会话输入框上面的「选择文件夹」（同 codex-app-server 新聊天页输入框上面那一栏）：
 * 点开是这个环境（本机或 EnvPicker 选的远程主机）最近用过的文件夹，「选择文件夹…」本机在桌面版里弹系统的文件夹对话框、
 * 网页里打开对话框浏览网关这台机器上的文件夹，远程主机打开对话框浏览远端的；没有别的可选时不弹菜单，点按钮直接选
 */
export function FolderPicker({ value, recent: allRecent, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  /** 当前环境：null 是本机，否则是 SSH 连接 id */
  const host = parseRemote(value)?.host ?? null;
  const recent = allRecent.filter((d) => (parseRemote(d)?.host ?? null) === host);
  /** 选了文件夹（远程主机只有 ssh://<id> 时是没选） */
  const chosen = value !== null && (host === null || parseRemote(value)!.path !== "");
  const ref = useOutsideClose(open, () => setOpen(false));

  const pick = (cwd: string | null) => {
    onChange(cwd);
    setOpen(false);
  };

  // 远程主机上的文件夹只能用网页的对话框浏览
  const browse = () => {
    setOpen(false);
    if (host || !desktop) return setBrowsing(true);
    void desktop.pickFolder(value ?? recent[0]).then((dir) => dir && onChange(dir));
  };
  const onlyBrowse = recent.length === 0 && !chosen;

  return (
    <div className="folder-picker" ref={ref}>
      <button className="new-chat-chip" onClick={() => (onlyBrowse ? browse() : setOpen((o) => !o))} title={chosen ? machinePath(value!) : "选择会话在哪个文件夹里运行"}>
        <FolderIcon />
        <span className="new-chat-chip-label">{chosen ? folderName(value!) : "选择文件夹"}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          {recent.length > 0 && <div className="menu-label">最近</div>}
          {recent.map((dir) => (
            <button key={dir} className={`menu-item${dir === value ? " selected" : ""}`} onClick={() => pick(dir)} title={machinePath(dir)}>
              <span className="menu-item-name">{folderName(dir)}</span>
              <span className="menu-item-sub">{machinePath(dir)}</span>
            </button>
          ))}
          {chosen && (
            <button className="menu-item" onClick={() => pick(host ? remoteUri(host) : null)}>
              <span className="menu-item-name">不选文件夹</span>
            </button>
          )}
          {(recent.length > 0 || chosen) && <div className="menu-divider" />}
          <button className="menu-item" onClick={browse}>
            <span className="menu-item-name">选择文件夹…</span>
          </button>
        </div>
      )}
      {browsing && (
        <FolderPickerDialog
          host={host ?? undefined}
          initial={chosen ? value! : (recent[0] ?? (host ? remoteUri(host) : undefined))}
          onClose={() => setBrowsing(false)}
          onPick={(dir) => {
            setBrowsing(false);
            onChange(dir);
          }}
        />
      )}
    </div>
  );
}

export function FolderIcon() {
  return (
    <svg className="ic ic-folder" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path fill="currentColor" fillOpacity="0.2" d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  );
}

function LaptopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3.5" width="10" height="7" rx="1.2" />
      <path d="M1.5 12.5h13" />
    </svg>
  );
}

