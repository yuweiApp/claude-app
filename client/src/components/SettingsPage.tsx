import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Capabilities, type McpServerInfo, type McpServerInput, type SkillDetail } from "../api";
import { desktop, fileManagerName } from "../desktop";
import { Avatar } from "./CapabilityPicker";
import { Card, CardGrid } from "./CardGrid";
import { useDismiss } from "./ComposerPickers";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConnectorDirectory, ConnectorIcon } from "./ConnectorDirectory";
import { PluginDirectory } from "./PluginDirectory";
import { McpAuthDialog } from "./McpAuthDialog";
import { FolderPickerDialog } from "./FolderPickerDialog";
import { IosIcon } from "./IosIcon";
import { AppearancePage } from "./AppearancePage";

type Section = "appearance" | "plugins" | "skills" | "mcp";
/** 技能、插件页顶部的标签：个人（导入的、项目里的、导入插件带的、从市场装的）和 Claude Code 自带的；插件页还有插件市场 */
type Origin = "mine" | "builtin" | "directory";
/** 连接器页顶部的标签：已经添加的（设置页添加的、插件和配置文件带来的）和连接器市场（MCP 注册表） */
type ConnectorTab = "added" | "directory";

const SECTIONS: { key: Section; label: string; icon: ReactNode; group?: string }[] = [
  { key: "appearance", label: "外观", icon: <IosIcon tone="orange"><AppearanceIcon /></IosIcon>, group: "个人" },
  { key: "plugins", label: "插件", icon: <IosIcon tone="blue"><PluginIcon /></IosIcon>, group: "集成" },
  { key: "skills", label: "技能", icon: <IosIcon tone="purple"><SkillIcon /></IosIcon> },
  { key: "mcp", label: "连接器", icon: <IosIcon tone="pink"><McpIcon /></IosIcon> },
];

/** 设置页（同 codex-app-server 的设置页）：左边分组导航，右边是列表；navCollapsed 时收起左边的导航（跟着侧边栏的收起状态） */
export function SettingsPage({ navCollapsed = false }: { navCollapsed?: boolean }) {
  const [section, setSection] = useState<Section>("plugins");
  const [data, setData] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState<Origin>("mine");
  const [connectorTab, setConnectorTab] = useState<ConnectorTab>("added");
  /** 插件市场、连接器市场的「刷新」：换个 key 让市场列表重新加载 */
  const [directoryKey, setDirectoryKey] = useState(0);
  const [viewing, setViewing] = useState<Capabilities["skills"][number] | null>(null);
  /** 插件页里打开详情的插件名 */
  const [openPlugin, setOpenPlugin] = useState<string | null>(null);

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
  useEffect(() => {
    setSearch("");
    setOrigin("mine");
    setConnectorTab("added");
    setOpenPlugin(null);
    setDirectoryKey(0);
  }, [section]);
  useEffect(() => setSearch(""), [origin, connectorTab]);

  const keyword = search.trim().toLowerCase();
  const match = (...texts: (string | undefined)[]) => texts.join(" ").toLowerCase().includes(keyword);
  const inOrigin = (item: { builtin: boolean }) => item.builtin === (origin === "builtin");
  const plugins = (data?.plugins ?? []).filter((p) => inOrigin(p) && match(p.name, p.source));
  const skills = (data?.skills ?? []).filter((s) => inOrigin(s) && match(s.name, s.description));
  const count = (items: { builtin: boolean }[] | undefined, builtin: boolean) => items?.filter((i) => i.builtin === builtin).length ?? 0;
  const servers = (data?.mcpServers ?? []).filter((m) => match(m.name, m.target, m.connector?.title));
  const browsing = section === "mcp" && connectorTab === "directory";
  const marketBrowsing = section === "plugins" && origin === "directory";
  const detail = section === "plugins" ? (data?.plugins.find((p) => p.name === openPlugin) ?? null) : null;
  const label = SECTIONS.find((s) => s.key === section)!.label;

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="设置" hidden={navCollapsed}>
        <h2>设置</h2>
        {SECTIONS.map((s) => [
          s.group && <div key={s.group} className="settings-group">{s.group}</div>,
          <button key={s.key} className={`settings-nav-item${s.key === section ? " active" : ""}`} aria-current={s.key === section ? "page" : undefined} onClick={() => setSection(s.key)}>
            {s.icon}
            {s.label}
          </button>,
        ])}
      </nav>
      {section === "appearance" ? (
        <main className="settings-main">
          <AppearancePage />
        </main>
      ) : (
        <main className="settings-main">
          <header className="settings-head">
            <div className="settings-title">
              <h1>{label}</h1>
              <p>
                {section === "plugins" && `已安装 ${data?.plugins.length ?? 0} 个插件。`}
                {section === "skills" && `共 ${data?.skills.length ?? 0} 个技能，已启用 ${data?.skills.filter((s) => s.enabled).length ?? 0} 个，启停对新会话生效。`}
                {section === "mcp" &&
                  `连接器（MCP 服务器）把 Figma、Notion、GitHub 等外部服务接进对话，提供工具和数据。已添加 ${data?.mcpServers.length ?? 0} 个，已启用 ${data?.mcpServers.filter((m) => m.enabled).length ?? 0} 个。`}
              </p>
            </div>
            <input className="settings-search" hidden={detail !== null} value={search} placeholder={browsing ? "在 MCP 注册表里搜索" : marketBrowsing ? "搜索插件市场" : `搜索${label}`} onChange={(e) => setSearch(e.target.value)} />
            <button
              disabled={loading}
              onClick={() => {
                load(true);
                if (browsing || marketBrowsing) setDirectoryKey((k) => k + 1);
              }}
            >
              {loading ? "刷新中…" : "刷新"}
            </button>
            {section === "plugins" && <ImportButton kind="plugins" onImported={() => load(false)} onError={setError} />}
            {section === "skills" && <ImportButton kind="skills" onImported={() => load(false)} onError={setError} />}
            {section === "mcp" && <AddServerButton onAdded={() => load(false)} />}
          </header>
          {(section === "plugins" || section === "skills") && !detail && (
            <div className="settings-tabs" role="tablist">
              {(section === "plugins" ? (["mine", "builtin", "directory"] as const) : (["mine", "builtin"] as const)).map((o) => (
                <button key={o} role="tab" aria-selected={o === origin} className={`settings-tab${o === origin ? " active" : ""}`} onClick={() => setOrigin(o)}>
                  {o === "directory" ? (
                    "插件市场"
                  ) : (
                    <>
                      {o === "mine" ? "个人" : "内置"}
                      {label}
                      <span className="settings-tab-count">{count(section === "skills" ? data?.skills : data?.plugins, o === "builtin")}</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          )}
          {section === "mcp" && (
            <div className="settings-tabs" role="tablist">
              {(["added", "directory"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={t === connectorTab} className={`settings-tab${t === connectorTab ? " active" : ""}`} onClick={() => setConnectorTab(t)}>
                  {t === "added" ? "已添加" : "连接器市场"}
                  {t === "added" && <span className="settings-tab-count">{data?.mcpServers.length ?? 0}</span>}
                </button>
              ))}
            </div>
          )}
          {error && <div className="settings-error">{error}</div>}
          {detail && data && (
            <PluginDetail
              plugin={detail}
              data={data}
              onBack={() => setOpenPlugin(null)}
              onViewSkill={setViewing}
              onChanged={() => load(false)}
              onDeleted={() => {
                setOpenPlugin(null);
                load(false);
              }}
              onError={setError}
            />
          )}
          {marketBrowsing && !detail && (
            <PluginDirectory
              key={directoryKey}
              refresh={directoryKey > 0}
              search={search}
              imported={(data?.plugins ?? []).filter((p) => p.managed && !p.marketplace).map((p) => p.name)}
              onChanged={() => load(false)}
              onOpen={setOpenPlugin}
            />
          )}
          {section === "plugins" && !detail && !marketBrowsing && (
            <List empty={data ? (keyword ? "没有匹配的插件" : origin === "mine" ? "还没有个人插件，在「插件市场」里安装，或点右上角导入" : "没有内置插件") : "加载中…"}>
              {plugins.map((p) => {
                const parts = pluginParts(p.name, data!);
                const meta = [`${parts.skills.length} 个技能`, `${parts.servers.length} 个连接器`, p.version && `版本 ${p.version}`].filter(Boolean).join(" · ");
                return (
                  <Row key={p.name} name={p.name} sub={p.description ?? p.source} wrap meta={meta} onOpen={() => setOpenPlugin(p.name)}>
                    {p.managed && <PluginDeleteButton plugin={p} onDeleted={() => load(false)} onError={setError} />}
                  </Row>
                );
              })}
            </List>
          )}
          {section === "skills" && (
            <SkillGrid
              skills={skills}
              empty={data ? (keyword ? "没有匹配的技能" : origin === "mine" ? "还没有个人技能，点右上角导入，或放在项目的 .claude/skills 里" : "没有内置技能") : "加载中…"}
              onOpen={setViewing}
              onChanged={() => load(false)}
              onError={setError}
            />
          )}
          {browsing && <ConnectorDirectory key={directoryKey} search={search} servers={data?.mcpServers ?? []} onChanged={() => load(false)} />}
          {section === "mcp" && !browsing && (
            <List empty={data ? (keyword ? "没有匹配的连接器" : "还没有连接器，在「连接器市场」里添加，或点右上角手动添加") : "加载中…"}>
              {servers.map((server) => (
                <ServerRow key={server.name} server={server} onChanged={() => load(false)} onError={setError} />
              ))}
            </List>
          )}
        </main>
      )}
      {viewing && <SkillDialog skill={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function List({ empty, children }: { empty: string; children: ReactNode[] }) {
  return children.length ? <div className="settings-list">{children}</div> : <div className="settings-empty">{empty}</div>;
}

/** 插件带的技能（插件名:技能名）和 MCP 服务器（plugin:插件名:服务器名） */
function pluginParts(name: string, data: Capabilities) {
  return {
    skills: data.skills.filter((s) => s.name.startsWith(`${name}:`)),
    servers: data.mcpServers.filter((m) => m.name.startsWith(`plugin:${name}:`)),
  };
}

/** 插件详情（同 Claude 桌面版）：描述、作者、版本，下面分「技能」「连接器」两个标签 */
function PluginDetail({
  plugin,
  data,
  onBack,
  onViewSkill,
  onChanged,
  onDeleted,
  onError,
}: {
  plugin: Capabilities["plugins"][number];
  data: Capabilities;
  onBack: () => void;
  onViewSkill: (skill: Capabilities["skills"][number]) => void;
  onChanged: () => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const { skills, servers } = pluginParts(plugin.name, data);
  const [tab, setTab] = useState<"skills" | "connectors">(skills.length === 0 && servers.length > 0 ? "connectors" : "skills");
  const meta = [plugin.author && `作者：${plugin.author}`, plugin.version && `版本 ${plugin.version}`, plugin.source].filter(Boolean).join(" · ");
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 从市场装的：更新到市场里的最新版本，显示 Claude Code 的说明 */
  const update = () => {
    setUpdating(true);
    setNotice(null);
    api
      .updatePlugin(plugin.source!)
      .then(
        (message) => {
          setNotice(message);
          onChanged();
        },
        (e: Error) => onError(`更新失败：${e.message}`),
      )
      .finally(() => setUpdating(false));
  };

  return (
    <>
      <button className="settings-back" onClick={onBack}>
        ← 全部插件
      </button>
      <div className="plugin-head">
        <Avatar name={plugin.name} />
        <div className="settings-row-main">
          <div className="settings-row-name">
            {plugin.name}
            {plugin.builtin && <span className="settings-tag">内置</span>}
          </div>
          {meta && <div className="settings-row-sub">{meta}</div>}
        </div>
        {plugin.marketplace && (
          <button disabled={updating} onClick={update}>
            {updating ? "更新中…" : "检查更新"}
          </button>
        )}
        {plugin.managed && <PluginDeleteButton plugin={plugin} onDeleted={onDeleted} onError={onError} />}
      </div>
      {notice && <p className="plugin-notice">{notice}</p>}
      {plugin.description && <p className="plugin-description">{plugin.description}</p>}
      <div className="settings-tabs" role="tablist">
        {(["skills", "connectors"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={t === tab} className={`settings-tab${t === tab ? " active" : ""}`} onClick={() => setTab(t)}>
            {t === "skills" ? "技能" : "连接器"}
            <span className="settings-tab-count">{t === "skills" ? skills.length : servers.length}</span>
          </button>
        ))}
      </div>
      {tab === "skills" && (
        <SkillGrid skills={skills} plugin={plugin.name} empty="这个插件没有技能" onOpen={onViewSkill} onChanged={onChanged} onError={onError} />
      )}
      {tab === "connectors" && (
        <List empty="这个插件没有连接器">
          {servers.map((server) => (
            <ServerRow key={server.name} server={server} onChanged={onChanged} onError={onError} />
          ))}
        </List>
      )}
    </>
  );
}

/**
 * 技能卡片（同插件市场的卡片网格）：名称、最多 3 行描述，右上角是停用/启用、移除的菜单，点卡片看详情。
 * plugin：都是这个插件的技能时传插件名，名称去掉「插件名:」，描述去掉 Claude Code 加的「(插件名) 」
 */
function SkillGrid({
  skills,
  plugin,
  empty,
  onOpen,
  onChanged,
  onError,
}: {
  skills: Capabilities["skills"];
  plugin?: string;
  empty: string;
  onOpen: (skill: Capabilities["skills"][number]) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  if (!skills.length) return <div className="settings-empty">{empty}</div>;
  return (
    <CardGrid>
      {skills.map((s) => {
        const name = plugin ? s.name.slice(plugin.length + 1) : s.name;
        return (
          <Card
            key={s.name}
            icon={<Avatar name={name} />}
            title={name}
            badge={!s.enabled && <span className="settings-tag">已停用</span>}
            menu={<SkillMenu skill={s} onChanged={onChanged} onError={onError} />}
            description={plugin ? s.description.replace(`(${plugin}) `, "") : s.description}
            dimmed={!s.enabled}
            onOpen={() => onOpen(s)}
          />
        );
      })}
    </CardGrid>
  );
}

function Row({ name, sub, wrap, tag, meta, onOpen, children }: { name: string; sub?: string; wrap?: boolean; tag?: string; meta?: string; onOpen?: () => void; children?: ReactNode }) {
  const text = (
    <>
      <div className="settings-row-name">
        {name}
        {tag && <span className="settings-tag">{tag}</span>}
      </div>
      {sub && <div className={`settings-row-sub${wrap ? " wrap" : ""}`} title={sub}>{sub}</div>}
      {meta && <div className="settings-row-status">{meta}</div>}
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

/** 删除插件：导入的删文件；从市场装的交给 Claude Code 卸载 */
function PluginDeleteButton({ plugin, onDeleted, onError }: { plugin: Capabilities["plugins"][number]; onDeleted: () => void; onError: (message: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  if (!plugin.marketplace) return <DeleteButton kind="plugins" name={plugin.name} onDeleted={onDeleted} onError={onError} />;
  return (
    <>
      <button className="settings-danger" disabled={running} onClick={() => setConfirming(true)}>
        {running ? "卸载中…" : "卸载"}
      </button>
      {confirming && (
        <ConfirmDialog
          title="卸载插件"
          message={`将卸载从「${plugin.marketplace}」安装的插件「${plugin.name}」，它带的技能和连接器在新会话里不再可用。`}
          confirmLabel="卸载"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            setRunning(true);
            api
              .uninstallPlugin(plugin.source!)
              .then(onDeleted, (e: Error) => onError(`卸载失败：${e.message}`))
              .finally(() => setRunning(false));
          }}
        />
      )}
    </>
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

/** 技能的来处：插件里的技能叫 插件名:技能名 */
function skillOrigin(skill: Capabilities["skills"][number]): string {
  if (skill.managed) return "已导入";
  if (skill.builtin) return "内置";
  const plugin = skill.name.includes(":") ? skill.name.split(":")[0] : undefined;
  return plugin ? `插件 ${plugin}` : "项目或插件";
}

/** 技能详情：路径、字段和正文；内置技能没有文件，只显示描述 */
function SkillDialog({ skill, onClose }: { skill: Capabilities["skills"][number]; onClose: () => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState(true);
  const [revealFailed, setRevealFailed] = useState(false);
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
            <div className="settings-row-sub">{skillOrigin(skill)}</div>
          </div>
          <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {detail && (
          <div className="skill-dialog-path">
            <code title={detail.path}>{detail.path}</code>
            {desktop && (
              <button
                className="skill-reveal"
                title={revealFailed ? "这台电脑上没有这个文件（网关在别的机器上）" : undefined}
                onClick={() => void desktop!.showItemInFolder(detail.path).then((shown) => setRevealFailed(!shown))}
              >
                {revealFailed ? "找不到文件" : `在${fileManagerName}中显示`}
              </button>
            )}
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
              <p className="settings-row-sub">{skill.builtin ? "这是 Claude Code 自带的技能，没有可查看的文件。" : "没有找到这个技能的 SKILL.md 文件。"}</p>
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
  const [signingIn, setSigningIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState<"confirm" | "running" | null>(null);
  const run = (action: Promise<unknown>) => action.then(onChanged, (e: Error) => onError(e.message));
  /** 远程服务器连上的可以断开（清除登录令牌）；不是靠登录连上的，清除后仍然连着，提示一下 */
  const remote = server.type === "http" || server.type === "sse";
  const logout = () => {
    setLoggingOut("running");
    api
      .logoutMcpServer(server.name)
      .then(
        (status) => {
          if (status === "connected") onError(`「${server.name}」没有保存的登录信息，清除后仍然连着`);
          onChanged();
        },
        (e: Error) => onError(`断开失败：${e.message}`),
      )
      .finally(() => setLoggingOut(null));
  };

  return (
    <div className="settings-row">
      <ConnectorIcon name={server.connector?.title ?? server.name} icon={server.connector?.icon} />
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
      {(server.managed || server.status === "needs-auth" || (remote && server.status === "connected")) && (
        <div className="settings-row-actions">
          {server.status === "needs-auth" && (
            <button className="primary" onClick={() => setSigningIn(true)}>
              登录
            </button>
          )}
          {remote && server.status === "connected" && (
            <button disabled={loggingOut === "running"} onClick={() => setLoggingOut("confirm")}>
              {loggingOut === "running" ? "断开中…" : "断开"}
            </button>
          )}
          {server.managed && (
            <>
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
            </>
          )}
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
      {loggingOut === "confirm" && (
        <ConfirmDialog
          title="断开连接器"
          message={`将清除「${server.name}」保存的登录信息，所有会话都要重新登录才能用它，开着的会话会重连这个服务器。`}
          confirmLabel="断开"
          onCancel={() => setLoggingOut(null)}
          onConfirm={logout}
        />
      )}
      {signingIn && (
        <McpAuthDialog
          name={server.name}
          onClose={(done) => {
            setSigningIn(false);
            if (done) onChanged();
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

type ServerForm = { name: string; type: McpServerInput["type"]; command: string; args: string; env: string; url: string; headers: string };
const EMPTY_FORM: ServerForm = { name: "", type: "stdio", command: "", args: "", env: "", url: "", headers: "" };

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/work"]
    }
  }
}`;

/**
 * 解析 MCP 服务器文档里常见的 JSON 配置，填进表单：{ "mcpServers": { 名称: 配置 } }、{ 名称: 配置 } 或者单个配置（没有名称）。
 * 有多个服务器时取第一个，note 里说明
 */
function parseServerJson(text: string): { form: ServerForm; note?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`不是合法的 JSON：${(e as Error).message}`);
  }
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const isConfig = (v: unknown): v is Record<string, unknown> => isObject(v) && (typeof v.command === "string" || typeof v.url === "string");
  if (!isObject(data)) throw new Error("JSON 应该是一个对象");
  const servers = isObject(data.mcpServers) ? data.mcpServers : isObject(data.servers) ? data.servers : data;
  const entries: [string, Record<string, unknown>][] = isConfig(servers) ? [["", servers]] : Object.entries(servers).filter((e): e is [string, Record<string, unknown>] => isConfig(e[1]));
  const [name, cfg] = entries[0] ?? [];
  if (!cfg) throw new Error("没有找到服务器配置：需要带 command（本机命令）或 url（远程地址）");
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const pairs = (v: unknown, sep: string) => (isObject(v) ? Object.entries(v).map(([k, val]) => `${k}${sep}${String(val)}`).join("\n") : "");
  const remote = typeof cfg.url === "string";
  const form: ServerForm = {
    ...EMPTY_FORM,
    name: name ?? "",
    type: remote ? (cfg.type === "sse" || cfg.transport === "sse" ? "sse" : "http") : "stdio",
    command: typeof cfg.command === "string" ? cfg.command : "",
    args: strings(cfg.args).join("\n"),
    env: pairs(cfg.env, "="),
    url: remote ? (cfg.url as string) : "",
    headers: pairs(cfg.headers, ": "),
  };
  return { form, note: entries.length > 1 ? `JSON 里有 ${entries.length} 个服务器，已填入第一个「${name}」` : undefined };
}

function AddServerButton({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM);
  // 「从 JSON 导入」：粘贴页，解析后回到表单
  const [importing, setImporting] = useState(false);
  const [json, setJson] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (key: keyof ServerForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const stdio = form.type === "stdio";

  const close = () => {
    setOpen(false);
    setForm(EMPTY_FORM);
    setImporting(false);
    setJson("");
    setNote(null);
    setError(null);
  };

  const parse = () => {
    try {
      const parsed = parseServerJson(json);
      setForm(parsed.form);
      setNote(parsed.note ?? null);
      setError(null);
      setImporting(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
          close();
          onAdded();
        },
        (err: Error) => setError(err.message),
      )
      .finally(() => setSaving(false));
  };

  return (
    <>
      <button className="primary" onClick={() => setOpen(true)}>
        手动添加
      </button>
      {open && (
        <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          {importing ? (
            <div className="dialog settings-form mcp-dialog" role="dialog" aria-label="从 JSON 导入 MCP 服务器">
              <h3>添加 MCP 服务器</h3>
              <label>
                粘贴 JSON 配置
                <textarea autoFocus className="mono" rows={10} value={json} placeholder={JSON_PLACEHOLDER} onChange={(e) => setJson(e.target.value)} />
              </label>
              <p className="mcp-hint">支持 MCP 服务器文档里常见的 mcpServers 写法，解析后填进表单。</p>
              {error && <div className="settings-error">{error}</div>}
              <div className="dialog-actions">
                <button
                  type="button"
                  onClick={() => {
                    setImporting(false);
                    setError(null);
                  }}
                >
                  返回
                </button>
                <button type="button" className="primary" disabled={!json.trim()} onClick={parse}>
                  解析
                </button>
              </div>
            </div>
          ) : (
            <form className="dialog settings-form mcp-dialog" aria-label="添加 MCP 服务器" onSubmit={submit}>
              <h3>添加 MCP 服务器</h3>
              <label>
                名称
                <input autoFocus required value={form.name} onChange={update("name")} placeholder="例如 filesystem、github" pattern="[\w\-]+" title="字母、数字、下划线和连字符；同名会覆盖" />
              </label>
              <div className="mcp-type-row">
                <div className="mcp-type" role="radiogroup" aria-label="类型">
                  <button type="button" role="radio" aria-checked={stdio} className={stdio ? "active" : undefined} onClick={() => setForm((f) => ({ ...f, type: "stdio" }))}>
                    STDIO（本机命令）
                  </button>
                  <button type="button" role="radio" aria-checked={!stdio} className={stdio ? undefined : "active"} onClick={() => setForm((f) => ({ ...f, type: f.type === "sse" ? "sse" : "http" }))}>
                    HTTP（远程地址）
                  </button>
                </div>
                <button
                  type="button"
                  className="mcp-import"
                  onClick={() => {
                    setImporting(true);
                    setError(null);
                  }}
                >
                  从 JSON 导入
                </button>
              </div>
              {note && <p className="mcp-hint">{note}</p>}
              {stdio ? (
                <>
                  <label>
                    启动命令
                    <input required value={form.command} onChange={update("command")} placeholder="npx、uvx、node 或可执行文件路径" />
                  </label>
                  <label>
                    参数（每行一个）
                    <textarea className="mono" rows={3} value={form.args} onChange={update("args")} placeholder={"-y\n@modelcontextprotocol/server-filesystem"} />
                  </label>
                  <label>
                    环境变量（每行一个 名称=值）
                    <textarea className="mono" rows={2} value={form.env} onChange={update("env")} placeholder="API_KEY=xxx" />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    地址
                    <input required type="url" value={form.url} onChange={update("url")} placeholder="https://example.com/mcp" />
                  </label>
                  <label>
                    请求头（每行一个 名称: 值）
                    <textarea className="mono" rows={2} value={form.headers} onChange={update("headers")} placeholder="Authorization: Bearer xxx" />
                  </label>
                  {form.type === "sse" && <p className="mcp-hint">按 JSON 里的配置使用 SSE 传输</p>}
                </>
              )}
              {error && <div className="settings-error">{error}</div>}
              <div className="dialog-actions">
                <button type="button" onClick={close}>
                  取消
                </button>
                <button type="submit" className="primary" disabled={saving}>
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </form>
          )}
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
    <svg className="ic ic-plugin" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" fill="currentColor" fillOpacity="0.2" />
      <path d="M10.6 5.4v3.5a1.7 1.7 0 0 0 3.4 0V8a6 6 0 1 0-2.4 4.8" />
    </svg>
  );
}

function SkillIcon() {
  return (
    <svg className="ic ic-skill" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8 13.4 4.9v6.2L8 14.2l-5.4-3.1V4.9z" fill="currentColor" fillOpacity="0.18" />
      <path d="M8 5.2 10.5 6.6v2.8L8 10.8 5.5 9.4V6.6z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function McpIcon() {
  return (
    <svg className="ic ic-mcp" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m2.5 8 5-5a2 2 0 0 1 2.8 2.8L6.5 9.6M5 10.5l5.5-5.5a2 2 0 0 1 2.8 2.8l-5 5a1 1 0 0 0 0 1.4M7.5 11 11 7.5" />
    </svg>
  );
}

function AppearanceIcon() {
  return (
    <svg className="ic" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2a6 6 0 1 0 0 12c.9 0 1.3-.6 1.3-1.2 0-.7-.5-1-.5-1.6 0-.6.5-1 1.1-1H11a3 3 0 0 0 3-3C14 4.4 11.3 2 8 2Z" />
      <circle cx="5.2" cy="7.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7.6" cy="4.9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.6" cy="5.8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
