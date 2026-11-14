import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type SshConfigHost, type SshConnectionInfo, type SshConnectionInput } from "../api";
import { refreshSshConnections, setSshConnections, useSshConnections } from "../state/sshConnections";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 设置里的「SSH 连接」：在远程主机上开会话（gateway/src/ssh/）。连接存在网关（gateway-ssh-connections.json），
 * 只存主机、端口、私钥文件的路径和信任过的主机密钥指纹；密码每次连接时输入，只留在网关内存里
 */
export function SshPage() {
  const connections = useSshConnections();
  const [editing, setEditing] = useState<SshConnectionInfo | "new" | null>(null);
  const [removing, setRemoving] = useState<SshConnectionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 共用的列表是早先取的（会话用到主机时也会连上、断开），打开设置页先刷新一次，开着时也定时刷新；
  // 连接、准备远端时的每秒刷新在 state/sshConnections 里
  useEffect(() => {
    void refreshSshConnections();
    const timer = setInterval(() => void refreshSshConnections(), 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="appearance ssh-page">
      <header className="settings-head">
        <div className="settings-title">
          <h1>SSH 连接</h1>
          <p>
            在远程主机上开会话：AI 在那台主机上读写文件、执行命令，右侧面板的文件和终端也是那台主机的。模型请求经 SSH 转回这台电脑发出，接口密钥不离开这台电脑。
            第一次连接时在远端的 ~/.claude-app 下装 Claude Code。远端支持 macOS、Linux、Windows。本机 ~/.ssh/config 里的主机自动列在这里，不用添加。
          </p>
        </div>
        <button className="primary" onClick={() => setEditing("new")}>
          添加连接
        </button>
      </header>
      {error && <div className="settings-error">{error}</div>}
      <section className="appearance-section">
        {connections.length ? (
          <div className="settings-list">
            {connections.map((c) => (
              <ConnectionRow key={c.id} conn={c} onEdit={() => setEditing(c)} onRemove={() => setRemoving(c)} onError={setError} />
            ))}
          </div>
        ) : (
          <div className="settings-empty">还没有 SSH 连接</div>
        )}
      </section>
      {editing && (
        <ConnectionDialog
          conn={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            void refreshSshConnections();
            // 新加的直接连一次
            if (editing === "new") void connect(saved.id, undefined, setError);
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`删除连接「${removing.name}」？`}
          message={
            removing.fromConfig
              ? "这台主机上的会话会从列表里去掉（远端的会话记录和文件不删）。~/.ssh/config 不改，只是这里不再列出；要加回来，在「添加连接」里选这个别名。"
              : "这台主机上的会话会从列表里去掉（远端的会话记录和文件不删）。"
          }
          confirmLabel="删除"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const id = removing.id;
            setRemoving(null);
            api.removeSshConnection(id).then(() => refreshSshConnections(), (e: Error) => setError(e.message));
          }}
        />
      )}
    </div>
  );
}

/** 连接：等到连上或失败，期间的进度靠轮询；结果更新到共用的列表里 */
function connect(id: string, password: string | undefined, onError: (msg: string | null) => void): Promise<void> {
  onError(null);
  const started = api.connectSsh(id, password);
  // 马上刷一次，状态变成「连接中」，开始轮询
  setTimeout(() => void refreshSshConnections(), 200);
  return started.then(
    () => refreshSshConnections(),
    (e: Error) => {
      onError(e.message);
      return refreshSshConnections();
    },
  );
}

function target(c: SshConnectionInput & { address?: string }) {
  return c.address ?? `${c.host}${c.port ? `:${c.port}` : ""}`;
}

function ConnectionRow({ conn: c, onEdit, onRemove, onError }: { conn: SshConnectionInfo; onEdit: () => void; onRemove: () => void; onError: (msg: string | null) => void }) {
  const [password, setPassword] = useState("");
  const status = (() => {
    switch (c.status) {
      case "ready":
        return <span className="mcp-status connected">已连接{c.platform ? `（${c.platform}）` : ""}</span>;
      case "connecting":
        return <span>连接中…</span>;
      case "deploying":
        return <span>正在准备远端{c.progress !== undefined && c.progress > 0 ? `（安装 Claude Code ${Math.round(c.progress * 100)}%）` : "…"}</span>;
      case "error":
        return c.hostKey ? (
          <span className="mcp-status needs-auth">{c.hostKey.changed ? "主机密钥变了" : "第一次连接，要确认主机密钥"}</span>
        ) : c.needsPassword ? (
          <span className="mcp-status needs-auth">需要密码</span>
        ) : (
          <span className="mcp-status failed" title={c.error}>
            连接失败：{c.error}
          </span>
        );
      default:
        return <span>未连接</span>;
    }
  })();
  const working = c.status === "connecting" || c.status === "deploying";

  return (
    <div className="settings-row ssh-row">
      <div className="settings-row-main">
        <div className="settings-row-name">
          {c.name}
          {c.fromConfig && (
            <span className="settings-tag" title="本机 ~/.ssh/config 里的主机，自动列出；要改改那个文件">
              ~/.ssh/config
            </span>
          )}
        </div>
        <div className="settings-row-target" title={target(c)}>
          {target(c)}
          {c.identityFile ? ` · ${c.identityFile}` : ""}
        </div>
        <div className="settings-row-status">
          {status}
          {!c.fromConfig && (
            <>
              {" · "}
              <button className="settings-link" onClick={onEdit}>
                编辑
              </button>
            </>
          )}
          {" · "}
          <button className="settings-link" onClick={onRemove}>
            删除
          </button>
        </div>
        {c.status === "ready" && c.forwards && c.forwards.length > 0 && (
          <ul className="ssh-forwards">
            {c.forwards.map((f) => (
              <li key={`${f.remote}-${f.local}`} className={f.error ? "failed" : undefined} title={f.error}>
                <span className="mono">远端 {f.remote}</span> → <span className="mono">本机 {f.local}</span>
                {f.error ? `：${f.error}` : ""}
              </li>
            ))}
          </ul>
        )}
        {c.status === "error" && c.hostKey && (
          <div className="ssh-hostkey">
            <p>
              {c.hostKey.changed
                ? "这台主机提供的密钥和上次信任的不一样。可能是重装了系统，也可能有人在冒充它。确认是同一台主机再信任："
                : "第一次连接这台主机。在主机上运行 ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub 可以核对指纹："}
            </p>
            <code>
              {c.hostKey.type} {c.hostKey.fingerprint}
            </code>
            <button
              className="primary"
              onClick={() =>
                api.trustSshHostKey(c.id, c.hostKey!.fingerprint).then(
                  () => connect(c.id, undefined, onError),
                  (e: Error) => onError(e.message),
                )
              }
            >
              信任并连接
            </button>
          </div>
        )}
        {c.status === "error" && !c.hostKey && c.needsPassword && (
          <form
            className="browsers-field"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void connect(c.id, password, onError).then(() => setPassword(""));
            }}
          >
            <span className="browsers-field-label">密码</span>
            <input type="password" autoComplete="off" value={password} placeholder="只在网关内存里，不保存" onChange={(e) => setPassword(e.target.value)} />
            <button type="submit" disabled={!password}>
              连接
            </button>
          </form>
        )}
      </div>
      <div className="settings-row-actions">
        {c.status === "ready" ? (
          <button onClick={() => api.disconnectSsh(c.id).then(() => refreshSshConnections(), (e: Error) => onError(e.message))}>断开</button>
        ) : (
          <button disabled={working} onClick={() => void connect(c.id, undefined, onError)}>
            {working ? "连接中…" : "连接"}
          </button>
        )}
      </div>
    </div>
  );
}

/** 添加、编辑连接。主机可以从本机 ~/.ssh/config 里选别名（端口、用户、私钥按 ssh 自己的配置） */
function ConnectionDialog({ conn, onClose, onSaved }: { conn: SshConnectionInfo | null; onClose: () => void; onSaved: (c: SshConnectionInfo) => void }) {
  const [name, setName] = useState(conn?.name ?? "");
  const [host, setHost] = useState(conn?.host ?? "");
  const [port, setPort] = useState(conn?.port ? String(conn.port) : "");
  const [identityFile, setIdentityFile] = useState(conn?.identityFile ?? "");
  const [startDirectory, setStartDirectory] = useState(conn?.startDirectory ?? "");
  const [forwards, setForwards] = useState((conn?.remoteForwards ?? []).join("\n"));
  const [configHosts, setConfigHosts] = useState<SshConfigHost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameTouched = useRef(Boolean(conn));

  useEffect(() => {
    api.sshConfigHosts().then(setConfigHosts, () => undefined);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const input: SshConnectionInput = {
      name: name.trim() || host.trim(),
      host: host.trim(),
      ...(port.trim() ? { port: Number(port) } : {}),
      identityFile: identityFile.trim(),
      startDirectory: startDirectory.trim(),
      remoteForwards: forwards
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    };
    (conn ? api.updateSshConnection(conn.id, input) : api.addSshConnection(input))
      .then(
        (saved) => {
          void api.sshConnections().then(setSshConnections, () => undefined);
          onSaved(saved);
        },
        (err: Error) => setError(err.message),
      )
      .finally(() => setSaving(false));
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog settings-form mcp-dialog" aria-label={conn ? "编辑 SSH 连接" : "添加 SSH 连接"} onSubmit={submit}>
        <h3>{conn ? "编辑 SSH 连接" : "添加 SSH 连接"}</h3>
        <label>
          主机
          <input
            autoFocus
            required
            className="mono"
            list="ssh-config-hosts"
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              if (!nameTouched.current) setName(e.target.value.replace(/^.*@/, ""));
            }}
            placeholder="user@host、host，或 ~/.ssh/config 里的别名"
          />
          <datalist id="ssh-config-hosts">
            {configHosts.map((h) => (
              <option key={h.alias} value={h.alias}>
                {[h.user && `${h.user}@`, h.hostname ?? h.alias, h.port && `:${h.port}`].filter(Boolean).join("")}
              </option>
            ))}
          </datalist>
        </label>
        <label>
          名称
          <input
            value={name}
            onChange={(e) => {
              nameTouched.current = true;
              setName(e.target.value);
            }}
            placeholder="侧边栏、文件夹选择里显示的名字"
          />
        </label>
        <label>
          端口（可选）
          <input className="mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="默认按 ~/.ssh/config，没有就是 22" />
        </label>
        <label>
          私钥文件（可选）
          <input className="mono" value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} placeholder="~/.ssh/id_ed25519；不填按 ~/.ssh/config，也会试 ssh-agent" />
        </label>
        <label>
          默认目录（可选）
          <input className="mono" value={startDirectory} onChange={(e) => setStartDirectory(e.target.value)} placeholder="选择文件夹时先打开的远端目录，默认是远端的用户目录" />
        </label>
        <label>
          反向转发（可选）
          <textarea
            className="mono"
            rows={2}
            value={forwards}
            onChange={(e) => setForwards(e.target.value)}
            placeholder={"一行一条，同 ssh -R：远端端口:本机地址:本机端口\n5432:127.0.0.1:5432"}
          />
        </label>
        <p className="mcp-hint">反向转发让远端连自己的端口时连到这台电脑上的服务（比如本机的数据库）；~/.ssh/config 里写的 RemoteForward 也照样生效。</p>
        <p className="mcp-hint">只保存私钥文件的路径，不保存私钥内容。用密钥、ssh-agent 都登录不了时，连接时再输入密码（不保存）。</p>
        {error && <div className="settings-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={saving || !host.trim()}>
            {saving ? "保存中…" : conn ? "保存" : "添加并连接"}
          </button>
        </div>
      </form>
    </div>
  );
}
