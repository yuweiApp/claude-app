import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Capabilities, type McpServerInfo, type McpServerInput, type SkillDetail } from "../api";
import { desktop } from "../desktop";
import { Avatar } from "./CapabilityPicker";
import { useDismiss } from "./ComposerPickers";
import { ConfirmDialog } from "./ConfirmDialog";
import { FolderPickerDialog } from "./FolderPickerDialog";

type Section = "plugins" | "skills" | "mcp";

const SECTIONS: { key: Section; label: string; icon: ReactNode }[] = [
  { key: "plugins", label: "插件", icon: <PluginIcon /> },
  { key: "skills", label: "技能", icon: <SkillIcon /> },
  { key: "mcp", label: "MCP", icon: <McpIcon /> },
];

/** 设置页（同 codex-app-server 的设置页）：左边分组导航，右边是列表；navCollapsed 时收起左边的导航（跟着侧边栏的收起状态） */
export function SettingsPage({ navCollapsed = false }: { navCollapsed?: boolean }) {
  const [section, setSection] = useState<Section>("plugins");
  const [data, setData] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewing, setViewing] = useState<Capabilities["skills"][number] | null>(null);

  const load = (refresh: boolean) => {
    setLoading(true);
    api
      .capabilities(undefined, refresh)
      .then(
        (value) => {
          setData(value);
          setError(null);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setLoading(false));
  };
  useEffect(() => load(false), []);
  useEffect(() => setSearch(""), [section]);

  const keyword = search.trim().toLowerCase();
  const match = (...texts: (string | undefined)[]) => texts.join(" ").toLowerCase().includes(keyword);
  const plugins = (data?.plugins ?? []).filter((p) => match(p.name, p.source));
  const skills = (data?.skills ?? []).filter((s) => match(s.name, s.description));
  const servers = (data?.mcpServers ?? []).filter((m) => match(m.name, m.target));
  const label = SECTIONS.find((s) => s.key === section)!.label;

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="设置" hidden={navCollapsed}>
        <h2>设置</h2>
        <div className="settings-group">集成</div>
        {SECTIONS.map((s) => (
          <button key={s.key} className={`settings-nav-item${s.key === section ? " active" : ""}`} aria-current={s.key === section ? "page" : undefined} onClick={() => setSection(s.key)}>
            {s.icon}
            {s.label}
          </button>
        ))}
      </nav>
      <main className="settings-main">
        <header className="settings-head">
          <div className="settings-title">
            <h1>{label}</h1>
            <p>
              {section === "plugins" && `已安装 ${data?.plugins.length ?? 0} 个插件。在输入框上方的「插件」里可以引用。`}
              {section === "skills" && `共 ${data?.skills.length ?? 0} 个技能，已启用 ${data?.skills.filter((s) => s.enabled).length ?? 0} 个。在输入框上方的「技能」里使用，或在消息开头写 /技能名。启停对新会话生效。`}
              {section === "mcp" && `MCP 服务器提供额外的工具和数据源。共 ${data?.mcpServers.length ?? 0} 个，已启用 ${data?.mcpServers.filter((m) => m.enabled).length ?? 0} 个。`}
            </p>
          </div>
          <input className="settings-search" value={search} placeholder={`搜索${label}`} onChange={(e) => setSearch(e.target.value)} />
          <button disabled={loading} onClick={() => load(true)}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          {section === "plugins" && <ImportButton kind="plugins" onImported={() => load(false)} onError={setError} />}
          {section === "skills" && <ImportButton kind="skills" onImported={() => load(false)} onError={setError} />}
          {section === "mcp" && <AddServerButton onAdded={() => load(false)} />}
        </header>
        {error && <div className="settings-error">{error}</div>}
        {section === "plugins" && (
          <List empty={data ? (keyword ? "没有匹配的插件" : "还没有插件") : "加载中…"}>
            {plugins.map((p) => (
              <Row key={p.name} name={p.name} sub={[p.source, p.version].filter(Boolean).join(" · ")}>
                {p.managed && <DeleteButton kind="plugins" name={p.name} onDeleted={() => load(false)} onError={setError} />}
              </Row>
            ))}
          </List>
        )}
        {section === "skills" && (
          <List empty={data ? (keyword ? "没有匹配的技能" : "还没有技能") : "加载中…"}>
            {skills.map((s) => (
              <Row key={s.name} name={s.name} sub={s.description} wrap tag={s.enabled ? undefined : "已停用"} onOpen={() => setViewing(s)}>
                <SkillMenu skill={s} onChanged={() => load(false)} onError={setError} />
              </Row>
            ))}
          </List>
        )}
        {section === "mcp" && (
          <List empty={data ? (keyword ? "没有匹配的 MCP 服务器" : "还没有 MCP 服务器，点右上角添加") : "加载中…"}>
            {servers.map((server) => (
              <ServerRow key={server.name} server={server} onChanged={() => load(false)} onError={setError} />
            ))}
          </List>
        )}
      </main>
      {viewing && <SkillDialog skill={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function List({ empty, children }: { empty: string; children: ReactNode[] }) {
  return children.length ? <div className="settings-list">{children}</div> : <div className="settings-empty">{empty}</div>;
}

function Row({ name, sub, wrap, tag, onOpen, children }: { name: string; sub?: string; wrap?: boolean; tag?: string; onOpen?: () => void; children?: ReactNode }) {
  const text = (
    <>
      <div className="settings-row-name">
        {name}
        {tag && <span className="settings-tag">{tag}</span>}
      </div>
      {sub && <div className={`settings-row-sub${wrap ? " wrap" : ""}`} title={sub}>{sub}</div>}
    </>
  );
  return (
    <div className="settings-row">
      <Avatar name={name} />
      {onOpen ? (
        <button className="settings-row-main settings-row-open" onClick={onOpen}>
          {text}
        </button>
      ) : (
        <div className="settings-row-main">{text}</div>
      )}
      {children && <div className="settings-row-actions">{children}</div>}
    </div>
  );
}

const KIND_LABEL = { skills: "技能", plugins: "插件" };

/** 导入技能、插件：选一个文件夹。桌面版弹系统的文件夹对话框，网页里浏览网关机器上的文件夹 */
function ImportButton({ kind, onImported, onError }: { kind: "skills" | "plugins"; onImported: () => void; onError: (message: string) => void }) {
  const [browsing, setBrowsing] = useState(false);
  const run = (path: string) => api.importExtension(kind, path).then(onImported, (e: Error) => onError(`导入失败：${e.message}`));
  const start = () => {
    if (!desktop) return setBrowsing(true);
    void desktop.pickFolder().then((path) => {
      if (path) void run(path);
    });
  };
  return (
    <>
      <button className="primary" onClick={start}>
        导入{KIND_LABEL[kind]}
      </button>
      {browsing && (
        <FolderPickerDialog
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            setBrowsing(false);
            void run(path);
          }}
        />
      )}
    </>
  );
}

function ConfirmDelete({ kind, name, onClose, onDeleted, onError }: { kind: "skills" | "plugins"; name: string; onClose: () => void; onDeleted: () => void; onError: (message: string) => void }) {
  const label = KIND_LABEL[kind];
  const verb = kind === "skills" ? "移除" : "删除";
  return (
    <ConfirmDialog
      title={`${verb}${label}`}
      message={`将${verb}导入的${label}「${name}」和它的文件，不能恢复。`}
      confirmLabel={verb}
      onCancel={onClose}
      onConfirm={() => {
        onClose();
        api.deleteExtension(kind, name).then(onDeleted, (e: Error) => onError(e.message));
      }}
    />
  );
}

function DeleteButton({ kind, name, onDeleted, onError }: { kind: "skills" | "plugins"; name: string; onDeleted: () => void; onError: (message: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button className="settings-danger" onClick={() => setConfirming(true)}>
        删除
      </button>
      {confirming && <ConfirmDelete kind={kind} name={name} onClose={() => setConfirming(false)} onDeleted={onDeleted} onError={onError} />}
    </>
  );
}

/** 技能行右边的「⋮」：启用、停用；导入的技能还能移除（内置和项目里的技能不归网关管，只能停用） */
function SkillMenu({ skill, onChanged, onError }: { skill: Capabilities["skills"][number]; onChanged: () => void; onError: (message: string) => void }) {
  const [at, setAt] = useState<{ right: number; top: number } | null>(null);
  const [removing, setRemoving] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, at !== null, () => setAt(null));

  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 靠近窗口底部时往上挪，菜单不被裁掉
    setAt(at ? null : { right: window.innerWidth - rect.right, top: Math.min(rect.bottom + 4, window.innerHeight - 100) });
  };

  return (
    <>
      <button
        className="icon-btn"
        title="更多"
        aria-label={`${skill.name} 的更多操作`}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        // 菜单开着时按下这个按钮不算点到外面，由 onClick 收起
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
      >
        <KebabIcon />
      </button>
      {at && (
        <div ref={menuRef} className="menu context-menu" role="menu" style={{ right: at.right, left: "auto", top: at.top }}>
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setAt(null);
              api.setSkillEnabled(skill.name, !skill.enabled).then(onChanged, (e: Error) => onError(e.message));
            }}
          >
            <span className="menu-item-name">{skill.enabled ? "停用" : "启用"}</span>
          </button>
          {skill.managed && (
            <>
              <div className="menu-divider" />
              <button
                role="menuitem"
                className="menu-item danger"
                onClick={() => {
                  setAt(null);
                  setRemoving(true);
                }}
              >
                <span className="menu-item-name menu-item-icon">
                  <TrashIcon />
                  移除
                </span>
              </button>
            </>
          )}
        </div>
      )}
      {removing && <ConfirmDelete kind="skills" name={skill.name} onClose={() => setRemoving(false)} onDeleted={onChanged} onError={onError} />}
    </>
  );
}

/** 拆开 SKILL.md 开头 --- 之间的字段和正文 */
function splitFrontmatter(content: string): { fields: [string, string][]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { fields: [], body: content };
  const fields = match[1]!.split(/\r?\n/).flatMap((line): [string, string][] => {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    return field ? [[field[1]!, field[2]!.replace(/^["']|["']$/g, "")]] : [];
  });
  return { fields, body: content.slice(match[0].length) };
}

/** 技能详情：路径、字段和正文；内置技能没有文件，只显示描述 */
function SkillDialog({ skill, onClose }: { skill: Capabilities["skills"][number]; onClose: () => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState(true);
  useEffect(() => {
    api.skill(skill.name).then(setDetail, () => undefined).finally(() => setLoaded(true));
  }, [skill.name]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const parsed = detail ? splitFrontmatter(detail.content) : null;

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog skill-dialog" role="dialog" aria-label={skill.name}>
        <div className="skill-dialog-head">
          <Avatar name={skill.name} />
          <div className="settings-row-main">
            <div className="settings-row-name">{skill.name}</div>
            <div className="settings-row-sub">{skill.managed ? "已导入" : detail ? "项目或插件" : "内置"}</div>
          </div>
          <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {detail && (
          <div className="skill-dialog-path">
            <code title={detail.path}>{detail.path}</code>
            <label className="skill-preview">
              预览
              <button className={`switch${preview ? " on" : ""}`} role="switch" aria-checked={preview} aria-label="预览" onClick={() => setPreview((p) => !p)} />
            </label>
          </div>
        )}
        <div className="skill-dialog-body">
          {!loaded && <div className="settings-empty">加载中…</div>}
          {loaded && !detail && (
            <>
              <p>{skill.description}</p>
              <p className="settings-row-sub">这是 Claude Code 自带的技能，没有可查看的文件。</p>
            </>
          )}
          {parsed && !preview && <pre className="skill-source">{detail!.content}</pre>}
          {parsed && preview && (
            <>
              {parsed.fields.length > 0 && (
                <table className="skill-fields">
                  <tbody>
                    {parsed.fields.map(([key, value]) => (
                      <tr key={key}>
                        <th>{key}</th>
                        <td>{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="assistant">
                <Markdown remarkPlugins={[remarkGfm]}>{parsed.body}</Markdown>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = { connected: "已连接", failed: "连接失败", "needs-auth": "需要认证", pending: "连接中", disabled: "已停用" };

function ServerRow({ server, onChanged, onError }: { server: McpServerInfo; onChanged: () => void; onError: (message: string) => void }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const run = (action: Promise<unknown>) => action.then(onChanged, (e: Error) => onError(e.message));

  return (
    <div className="settings-row">
      <Avatar name={server.name} />
      <div className="settings-row-main">
        <div className="settings-row-name">
          {server.name}
          {server.type && <span className="settings-tag">{server.type.toUpperCase()}</span>}
        </div>
        {server.target && <div className="settings-row-target" title={server.target}>{server.target}</div>}
        <div className="settings-row-status">
          <span className={`mcp-status ${server.status}`}>{STATUS_TEXT[server.status] ?? server.status}</span>
          {server.status === "connected" && (
            <>
              {` · ${server.tools.length} 个工具`}
              {server.tools.length > 0 && (
                <>
                  {" · "}
                  <button className="settings-link" onClick={() => setToolsOpen((o) => !o)}>
                    {toolsOpen ? "收起工具" : "查看工具"}
                  </button>
                </>
              )}
            </>
          )}
          {server.error && ` · ${server.error}`}
          {server.source && ` · ${server.source}`}
        </div>
        {toolsOpen && (
          <ul className="settings-tools">
            {server.tools.map((tool) => (
              <li key={tool.name} title={tool.description}>
                <code>{tool.name}</code>
                {tool.description && <span>{tool.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {server.managed && (
        <div className="settings-row-actions">
          <button className="settings-danger" onClick={() => setConfirming(true)}>
            删除
          </button>
          <button
            className={`switch${server.enabled ? " on" : ""}`}
            role="switch"
            aria-checked={server.enabled}
            aria-label={`${server.enabled ? "停用" : "启用"} ${server.name}`}
            onClick={() => void run(api.setMcpServerEnabled(server.name, !server.enabled))}
          />
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title="删除 MCP 服务器"
          message={`将删除「${server.name}」的配置。已开着的会话要等子进程重启后才生效。`}
          confirmLabel="删除"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void run(api.deleteMcpServer(server.name));
          }}
        />
      )}
    </div>
  );
}

/** 每行一项，按分隔符拆成键值：请求头用冒号，环境变量用等号 */
function parsePairs(text: string, separator: string): Record<string, string> | undefined {
  const entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(separator);
      return i > 0 ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : null;
    })
    .filter((pair): pair is string[] => pair !== null);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function AddServerButton({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", type: "http" as McpServerInput["type"], command: "", args: "", env: "", url: "", headers: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const stdio = form.type === "stdio";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const input: Omit<McpServerInput, "name"> = stdio
      ? { type: "stdio", command: form.command.trim(), args: form.args.split("\n").map((a) => a.trim()).filter(Boolean), env: parsePairs(form.env, "=") }
      : { type: form.type, url: form.url.trim(), headers: parsePairs(form.headers, ":") };
    api
      .saveMcpServer(form.name.trim(), input)
      .then(
        () => {
          setOpen(false);
          setForm({ name: "", type: "http", command: "", args: "", env: "", url: "", headers: "" });
          setError(null);
          onAdded();
        },
        (err: Error) => setError(err.message),
      )
      .finally(() => setSaving(false));
  };

  return (
    <>
      <button className="primary" onClick={() => setOpen(true)}>
        添加服务器
      </button>
      {open && (
        <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <form className="dialog settings-form" aria-label="添加 MCP 服务器" onSubmit={submit}>
            <h3>添加 MCP 服务器</h3>
            <label>
              名称
              <input autoFocus required value={form.name} onChange={update("name")} placeholder="字母、数字、下划线和连字符；同名会覆盖" />
            </label>
            <label>
              类型
              <select value={form.type} onChange={update("type")}>
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
                <option value="stdio">STDIO（本机命令）</option>
              </select>
            </label>
            {stdio ? (
              <>
                <label>
                  命令
                  <input required value={form.command} onChange={update("command")} placeholder="node" />
                </label>
                <label>
                  参数（每行一个）
                  <textarea rows={2} value={form.args} onChange={update("args")} />
                </label>
                <label>
                  环境变量（每行一个 KEY=VALUE）
                  <textarea rows={2} value={form.env} onChange={update("env")} />
                </label>
              </>
            ) : (
              <>
                <label>
                  地址
                  <input required value={form.url} onChange={update("url")} placeholder="https://example.com/mcp" />
                </label>
                <label>
                  请求头（每行一个 Name: Value）
                  <textarea rows={2} value={form.headers} onChange={update("headers")} />
                </label>
              </>
            )}
            {error && <div className="settings-error">{error}</div>}
            <div className="dialog-actions">
              <button type="button" onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="submit" className="primary" disabled={saving}>
                添加
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="3.5" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="8" cy="12.5" r="1.3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.7 7v3.8M9.3 7v3.8" />
    </svg>
  );
}

function PluginIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" />
      <path d="M10.6 5.4v3.5a1.7 1.7 0 0 0 3.4 0V8a6 6 0 1 0-2.4 4.8" />
    </svg>
  );
}

function SkillIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8 13.4 4.9v6.2L8 14.2l-5.4-3.1V4.9z" />
    </svg>
  );
}

function McpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m2.5 8 5-5a2 2 0 0 1 2.8 2.8L6.5 9.6M5 10.5l5.5-5.5a2 2 0 0 1 2.8 2.8l-5 5a1 1 0 0 0 0 1.4M7.5 11 11 7.5" />
    </svg>
  );
}
