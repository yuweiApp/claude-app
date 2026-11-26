import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
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
import { PetPage } from "./PetPage";
import { BrowsersPage } from "./BrowsersPage";
import { ProxyPage } from "./ProxyPage";
import { SharePage } from "./SharePage";
import { SshPage } from "./SshPage";

export type SettingsSection = "appearance" | "pet" | "proxy" | "plugins" | "skills" | "agents" | "mcp" | "browsers" | "ssh" | "share";
type Section = SettingsSection;
/** 技能、子代理、插件页顶部的标签：个人（导入的、项目里的、导入插件带的、从市场装的）和 Claude Code 自带的；插件页还有插件市场 */
type Origin = "mine" | "builtin" | "directory";
/** 连接器页顶部的标签：已经添加的（设置页添加的、插件和配置文件带来的）和连接器市场（MCP 注册表） */
type ConnectorTab = "added" | "directory";

/** 「子代理」先隐藏：设置页导航里不显示，插件列表和详情里也不列插件带的子代理。代码和网关接口都留着，改成 true 就恢复 */
const SHOW_AGENTS = false;

const SECTIONS: { key: Section; label: string; icon: ReactNode; group?: string; hidden?: boolean }[] = [
  { key: "appearance", label: "外观", icon: <IosIcon tone="orange"><AppearanceIcon /></IosIcon>, group: "个人" },
  // 灵宠只在桌面版有（在屏幕角落）
  { key: "pet", label: "灵宠", icon: <IosIcon tone="pink"><PetIcon /></IosIcon>, hidden: !desktop?.pet },
  { key: "proxy", label: "网络代理", icon: <IosIcon tone="teal"><ProxyIcon /></IosIcon> },
  { key: "plugins", label: "插件", icon: <IosIcon tone="blue"><PluginIcon /></IosIcon>, group: "集成" },
  { key: "skills", label: "技能", icon: <IosIcon tone="purple"><SkillIcon /></IosIcon> },
  { key: "agents", label: "子代理", icon: <IosIcon tone="teal"><AgentIcon /></IosIcon>, hidden: !SHOW_AGENTS },
  { key: "mcp", label: "连接器", icon: <IosIcon tone="pink"><McpIcon /></IosIcon> },
  { key: "browsers", label: "浏览器", icon: <IosIcon tone="green"><BrowsersIcon /></IosIcon> },
  { key: "ssh", label: "SSH 连接", icon: <IosIcon tone="indigo"><SshIcon /></IosIcon>, group: "远程" },
  { key: "share", label: "公网分享", icon: <IosIcon tone="orange"><ShareIcon /></IosIcon> },
];

/** 设置页（同 codex-app-server 的设置页）：左边分组导航，右边是列表；navCollapsed 时收起左边的导航（跟着侧边栏的收起状态） */
export function SettingsPage({ navCollapsed = false, initialSection = "plugins" }: { navCollapsed?: boolean; initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection);
  const [data, setData] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState<Origin>("mine");
  const [connectorTab, setConnectorTab] = useState<ConnectorTab>("added");
  /** 插件市场、连接器市场的「刷新」：换个 key 让市场列表重新加载 */
  const [directoryKey, setDirectoryKey] = useState(0);
  const [viewing, setViewing] = useState<Capabilities["skills"][number] | null>(null);
  const [viewingAgent, setViewingAgent] = useState<Capabilities["agents"][number] | null>(null);
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
  const agents = (data?.agents ?? []).filter((a) => inOrigin(a) && match(a.name, a.description));
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
        {SECTIONS.filter((s) => !s.hidden).map((s) => [
          s.group && <div key={s.group} className="settings-group">{s.group}</div>,
          <button key={s.key} className={`settings-nav-item${s.key === section ? " active" : ""}`} aria-current={s.key === section ? "page" : undefined} onClick={() => setSection(s.key)}>
            {s.icon}
            {s.label}
          </button>,
        ])}
      </nav>
      {section === "appearance" || section === "pet" || section === "proxy" || section === "browsers" || section === "ssh" || section === "share" ? (
        <main className="settings-main">
          {section === "appearance" ? <AppearancePage /> : section === "pet" ? <PetPage /> : section === "proxy" ? <ProxyPage /> : section === "ssh" ? <SshPage /> : section === "share" ? <SharePage /> : <BrowsersPage />}
        </main>
      ) : (
        <main className="settings-main">
          <header className="settings-head">
            <div className="settings-title">
              <h1>{label}</h1>
              <p>
                {section === "plugins" && `已安装 ${data?.plugins.length ?? 0} 个插件。`}
                {section === "skills" && `共 ${data?.skills.length ?? 0} 个技能，已启用 ${data?.skills.filter((s) => s.enabled).length ?? 0} 个，启停对新会话生效。`}
                {section === "agents" &&
                  `子代理由 Claude 用 Agent 工具调起，在自己的上下文里处理交给它的任务。共 ${data?.agents.length ?? 0} 个，已启用 ${data?.agents.filter((a) => a.enabled).length ?? 0} 个，启停对新会话生效。`}
                {section === "mcp" &&
                  `连接器（MCP 服务器）把 Figma、Notion、GitHub 等外部服务接进对话，提供工具和数据。已添加 ${data?.mcpServers.length ?? 0} 个，已启用 ${data?.mcpServers.filter((m) => m.enabled).length ?? 0} 个。`}
              </p>
            </div>
            <input className="settings-search" hidden={detail !== null} value={search} placeholder={browsing ? "搜索连接器市场" : marketBrowsing ? "搜索插件市场" : `搜索${label}`} onChange={(e) => setSearch(e.target.value)} />
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
            {section === "mcp" && <AddServerButton names={data?.mcpServers.map((m) => m.name) ?? []} onAdded={() => load(false)} />}
            {section === "agents" && desktop && data && (
              <button
                className="primary"
                onClick={() => void desktop!.openFolder(data.agentsDir).then((opened) => !opened && setError("这台电脑上没有这个文件夹（网关在别的机器上）"))}
              >
                打开文件夹
              </button>
            )}
          </header>
          {(section === "plugins" || section === "skills" || section === "agents") && !detail && (
            <div className="settings-tabs" role="tablist">
              {(section === "plugins" ? (["mine", "builtin", "directory"] as const) : (["mine", "builtin"] as const)).map((o) => (
                <button key={o} role="tab" aria-selected={o === origin} className={`settings-tab${o === origin ? " active" : ""}`} onClick={() => setOrigin(o)}>
                  {o === "directory" ? (
                    "插件市场"
                  ) : (
                    <>
                      {o === "mine" ? "个人" : "内置"}
                      {label}
                      <span className="settings-tab-count">{count(section === "skills" ? data?.skills : section === "agents" ? data?.agents : data?.plugins, o === "builtin")}</span>
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
              onViewAgent={setViewingAgent}
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
                const meta = [`${parts.skills.length} 个技能`, `${parts.servers.length} 个连接器`, parts.agents.length > 0 && `${parts.agents.length} 个子代理`, p.version && `版本 ${p.version}`].filter(Boolean).join(" · ");
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
          {section === "agents" && origin === "mine" && data && <AgentsHint dir={data.agentsDir} />}
          {section === "agents" && (
            <AgentGrid
              agents={agents}
              empty={data ? (keyword ? "没有匹配的子代理" : origin === "mine" ? "还没有个人子代理" : "没有内置子代理") : "加载中…"}
              onOpen={setViewingAgent}
              onChanged={() => load(false)}
              onError={setError}
            />
          )}
          {browsing && <ConnectorDirectory key={directoryKey} search={search} servers={data?.mcpServers ?? []} onChanged={() => load(false)} />}
          {section === "mcp" && !browsing && (
            <List className="server-list" empty={data ? (keyword ? "没有匹配的连接器" : "还没有连接器，在「连接器市场」里添加，或点右上角手动添加") : "加载中…"}>
              {servers.map((server) => (
                <ServerRow key={server.name} server={server} names={data?.mcpServers.map((m) => m.name) ?? []} onChanged={() => load(false)} onError={setError} />
              ))}
            </List>
          )}
        </main>
      )}
      {viewing && (
        <DetailDialog
          name={viewing.name}
          origin={skillOrigin(viewing)}
          description={viewing.description}
          load={() => api.skill(viewing.name)}
          missing={viewing.builtin ? "这是 Claude Code 自带的技能，没有可查看的文件。" : "没有找到这个技能的 SKILL.md 文件。"}
          onClose={() => setViewing(null)}
        />
      )}
      {viewingAgent && (
        <DetailDialog
          name={viewingAgent.name}
          origin={agentOrigin(viewingAgent)}
          description={viewingAgent.description}
          load={() => api.agent(viewingAgent.name)}
          missing={viewingAgent.path ? "读不到这个子代理的定义文件。" : "这个子代理没有可查看的定义文件（Claude Code 自带的）。"}
          onClose={() => setViewingAgent(null)}
        />
      )}
    </div>
  );
}

function List({ empty, className, children }: { empty: string; className?: string; children: ReactNode[] }) {
  return children.length ? <div className={className ?? "settings-list"}>{children}</div> : <div className="settings-empty">{empty}</div>;
}

/** 插件带的技能（插件名:技能名）、MCP 服务器（plugin:插件名:服务器名）和子代理（插件名:…） */
function pluginParts(name: string, data: Capabilities) {
  return {
    skills: data.skills.filter((s) => s.name.startsWith(`${name}:`)),
    servers: data.mcpServers.filter((m) => m.name.startsWith(`plugin:${name}:`)),
    agents: SHOW_AGENTS ? data.agents.filter((a) => a.plugin === name) : [],
  };
}

/** 插件详情（同 Claude 桌面版）：描述、作者、版本，下面分「技能」「连接器」标签，带子代理的插件还有「子代理」 */
function PluginDetail({
  plugin,
  data,
  onBack,
  onViewSkill,
  onViewAgent,
  onChanged,
  onDeleted,
  onError,
}: {
  plugin: Capabilities["plugins"][number];
  data: Capabilities;
  onBack: () => void;
  onViewSkill: (skill: Capabilities["skills"][number]) => void;
  onViewAgent: (agent: Capabilities["agents"][number]) => void;
  onChanged: () => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const { skills, servers, agents } = pluginParts(plugin.name, data);
  const [tab, setTab] = useState<"skills" | "connectors" | "agents">(
    skills.length > 0 ? "skills" : servers.length > 0 ? "connectors" : agents.length > 0 ? "agents" : "skills",
  );
  const tabs = agents.length > 0 ? (["skills", "connectors", "agents"] as const) : (["skills", "connectors"] as const);
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
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={t === tab} className={`settings-tab${t === tab ? " active" : ""}`} onClick={() => setTab(t)}>
            {t === "skills" ? "技能" : t === "connectors" ? "连接器" : "子代理"}
            <span className="settings-tab-count">{t === "skills" ? skills.length : t === "connectors" ? servers.length : agents.length}</span>
          </button>
        ))}
      </div>
      {tab === "skills" && (
        <SkillGrid skills={skills} plugin={plugin.name} empty="这个插件没有技能" onOpen={onViewSkill} onChanged={onChanged} onError={onError} />
      )}
      {tab === "agents" && <AgentGrid agents={agents} plugin={plugin.name} empty="这个插件没有子代理" onOpen={onViewAgent} onChanged={onChanged} onError={onError} />}
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

/** 子代理卡片：同技能卡片，标题后面是它用的模型（inherit 显示成「同主会话」），菜单里只有停用/启用 */
function AgentGrid({
  agents,
  plugin,
  empty,
  onOpen,
  onChanged,
  onError,
}: {
  agents: Capabilities["agents"];
  plugin?: string;
  empty: string;
  onOpen: (agent: Capabilities["agents"][number]) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  if (!agents.length) return <div className="settings-empty">{empty}</div>;
  return (
    <CardGrid>
      {agents.map((a) => {
        const name = plugin ? a.name.slice(plugin.length + 1) : a.name;
        return (
          <Card
            key={a.name}
            icon={<Avatar name={name} />}
            title={name}
            badge={
              !a.enabled ? (
                <span className="settings-tag">已停用</span>
              ) : (
                a.model && <span className="settings-tag" title="使用的模型">{a.model === "inherit" ? "同主会话" : a.model}</span>
              )
            }
            menu={
              <ItemMenu
                name={a.name}
                enabled={a.enabled}
                onToggle={() => api.setAgentEnabled(a.name, !a.enabled).then(onChanged, (e: Error) => onError(e.message))}
              />
            }
            description={a.description}
            dimmed={!a.enabled}
            onOpen={() => onOpen(a)}
          />
        );
      })}
    </CardGrid>
  );
}

const AGENT_EXAMPLE = `---
name: test-runner
description: 运行和这次改动相关的测试，只返回失败的用例和原因
tools: Read, Grep, Glob, Bash
model: inherit
---

你负责运行测试。找出和改动相关的测试并运行，只汇报失败的用例、报错和你判断的原因，不要修改代码。
`;

/** 个人子代理的写法：文件放在哪、开头写哪些字段，附一个可以复制的示例 */
function AgentsHint({ dir }: { dir: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="agents-hint">
      <p>
        个人子代理是 <code>{dir}</code> 里的 .md 文件，项目的子代理放在项目的 <code>.claude/agents</code> 里。文件开头 <code>---</code> 之间写 name 和
        description，可选 model 和 tools（不写时分别用默认的子代理模型和主会话的全部工具），正文是它的系统提示词。改完点「刷新」，对新会话生效。
      </p>
      <details>
        <summary>示例</summary>
        <div className="agents-example">
          <pre className="skill-source">{AGENT_EXAMPLE}</pre>
          <button
            onClick={() =>
              void navigator.clipboard.writeText(AGENT_EXAMPLE).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </details>
    </div>
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
  // 挂到 body 上：卡片悬停时有 transform，留在卡片里的话 fixed 的遮罩会按卡片定位（见 ItemMenu）
  return createPortal(
    <ConfirmDialog
      title={`${verb}${label}`}
      message={`将${verb}导入的${label}「${name}」和它的文件，不能恢复。`}
      confirmLabel={verb}
      onCancel={onClose}
      onConfirm={() => {
        onClose();
        api.deleteExtension(kind, name).then(onDeleted, (e: Error) => onError(e.message));
      }}
    />,
    document.body,
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
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <ItemMenu
        name={skill.name}
        enabled={skill.enabled}
        onToggle={() => api.setSkillEnabled(skill.name, !skill.enabled).then(onChanged, (e: Error) => onError(e.message))}
        onRemove={skill.managed ? () => setRemoving(true) : undefined}
      />
      {removing && <ConfirmDelete kind="skills" name={skill.name} onClose={() => setRemoving(false)} onDeleted={onChanged} onError={onError} />}
    </>
  );
}

/** 卡片右上角的「⋮」：启用或停用，传了 onRemove 的还有「移除」 */
function ItemMenu({ name, enabled, onToggle, onRemove }: { name: string; enabled: boolean; onToggle: () => void; onRemove?: () => void }) {
  const [at, setAt] = useState<{ right: number; top: number } | null>(null);
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
        aria-label={`${name} 的更多操作`}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        // 菜单开着时按下这个按钮不算点到外面，由 onClick 收起
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
      >
        <KebabIcon />
      </button>
      {/* 挂到 body 上：卡片悬停时上浮用的是 transform，祖先有 transform 时 position: fixed 改按它定位，菜单会画到别处 */}
      {at &&
        createPortal(
          <div ref={menuRef} className="menu context-menu" role="menu" style={{ right: at.right, left: "auto", top: at.top }}>
            <button
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setAt(null);
                onToggle();
              }}
            >
              <span className="menu-item-name">{enabled ? "停用" : "启用"}</span>
            </button>
            {onRemove && (
              <>
                <div className="menu-divider" />
                <button
                  role="menuitem"
                  className="menu-item danger"
                  onClick={() => {
                    setAt(null);
                    onRemove();
                  }}
                >
                  <span className="menu-item-name menu-item-icon">
                    <TrashIcon />
                    移除
                  </span>
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** 拆开 SKILL.md、子代理定义文件开头 --- 之间的字段和正文 */
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

/** 子代理的来处 */
function agentOrigin(agent: Capabilities["agents"][number]): string {
  if (agent.plugin) return `插件 ${agent.plugin}`;
  return agent.builtin ? "内置" : "个人或项目";
}

/** 技能、子代理的详情：路径、字段和正文；没有文件的（内置的）只显示描述和 missing */
function DetailDialog({
  name,
  origin,
  description,
  load,
  missing,
  onClose,
}: {
  name: string;
  origin: string;
  description: string;
  load: () => Promise<SkillDetail>;
  missing: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState(true);
  const [revealFailed, setRevealFailed] = useState(false);
  useEffect(() => {
    load().then(setDetail, () => undefined).finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按名字加载一次
  }, [name]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const parsed = detail ? splitFrontmatter(detail.content) : null;

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog skill-dialog" role="dialog" aria-label={name}>
        <div className="skill-dialog-head">
          <Avatar name={name} />
          <div className="settings-row-main">
            <div className="settings-row-name">{name}</div>
            <div className="settings-row-sub">{origin}</div>
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
              <p>{description}</p>
              <p className="settings-row-sub">{missing}</p>
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
                <Markdown remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough]}>{parsed.body}</Markdown>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = { connected: "已连接", failed: "连接失败", "needs-auth": "需要认证", pending: "连接中", disabled: "已停用" };

function ServerRow({ server, names, onChanged, onError }: { server: McpServerInfo; names?: string[]; onChanged: () => void; onError: (message: string) => void }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** 编辑：先取完整配置（列表里只有拼好的命令行），取到了才打开表单 */
  const [editing, setEditing] = useState<ServerForm | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const edit = () => {
    setLoadingConfig(true);
    api
      .mcpServerConfig(server.name)
      .then((input) => setEditing(toForm(input)), (e: Error) => onError(`读取配置失败：${e.message}`))
      .finally(() => setLoadingConfig(false));
  };
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
    <div className={`server-row${server.status === "disabled" ? " dimmed" : ""}`}>
      <ConnectorIcon name={server.connector?.title ?? server.name} icon={server.connector?.icon} />
      <div className="settings-row-main">
        <div className="settings-row-name">
          <span className="server-row-title" title={server.name}>
            {server.name}
          </span>
          {server.type && <span className="settings-tag">{server.type.toUpperCase()}</span>}
          {server.source && <span className="settings-tag">{server.source}</span>}
        </div>
        {server.target && <div className="settings-row-target" title={server.target}>{server.target}</div>}
        <div className="server-row-status">
          <span className={`server-status ${server.status}`}>
            <i aria-hidden />
            {STATUS_TEXT[server.status] ?? server.status}
          </span>
          {server.status === "connected" && (
            <>
              <span className="server-row-count">{server.tools.length} 个工具</span>
              {server.tools.length > 0 && (
                <button className="server-row-toggle" aria-expanded={toolsOpen} onClick={() => setToolsOpen((o) => !o)}>
                  {toolsOpen ? "收起工具" : "查看工具"}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              )}
            </>
          )}
          {server.error && (
            <span className="server-row-error" title={server.error}>
              {server.error}
            </span>
          )}
        </div>
        {toolsOpen && (
          <ul className={`settings-tools server-tools${server.tools.some((t) => t.description) ? "" : " compact"}`}>
            {server.tools.map((tool) => (
              <li key={tool.name} title={tool.description}>
                <code>{tool.name}</code>
                {tool.description && <span>{tool.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {(server.managed || server.editable || server.status === "needs-auth" || (remote && server.status === "connected")) && (
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
          {server.editable && (
            <button disabled={loadingConfig} onClick={edit}>
              编辑
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
      {editing && (
        <ServerDialog
          original={server.name}
          userScope={!server.managed}
          initial={editing}
          names={names ?? []}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
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

/** 已有配置转成表单：参数每行一个，环境变量 名称=值，请求头 名称: 值 */
const toForm = (input: McpServerInput): ServerForm => ({
  ...EMPTY_FORM,
  name: input.name,
  type: input.type,
  command: input.command ?? "",
  args: (input.args ?? []).join("\n"),
  env: Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
  url: input.url ?? "",
  headers: Object.entries(input.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n"),
});

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/work"]
    }
  }
}`;

/** 表单转成 mcpServers 写法的 JSON（打开 JSON 页时显示当前配置）；没填命令、地址时返回空串 */
function formToJson(form: ServerForm): string {
  const stdio = form.type === "stdio";
  if (!(stdio ? form.command.trim() : form.url.trim())) return "";
  const env = parsePairs(form.env, "=");
  const headers = parsePairs(form.headers, ":");
  const args = form.args.split("\n").map((a) => a.trim()).filter(Boolean);
  const cfg = stdio
    ? { command: form.command.trim(), ...(args.length ? { args } : {}), ...(env ? { env } : {}) }
    : { type: form.type, url: form.url.trim(), ...(headers ? { headers } : {}) };
  return JSON.stringify({ mcpServers: { [form.name.trim() || "server"]: cfg } }, null, 2);
}

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

function AddServerButton({ names, onAdded }: { names: string[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="primary" onClick={() => setOpen(true)}>
        手动添加
      </button>
      {open && <ServerDialog initial={EMPTY_FORM} names={names} onClose={() => setOpen(false)} onSaved={onAdded} />}
    </>
  );
}

/**
 * 添加或编辑 MCP 服务器的表单，名称和 names 里别的服务器重名时不让保存（网关也会拒绝和设置页添加的、用户范围的重名）。
 * 传 original 是编辑那个服务器，名称可以改；userScope 是用户范围的（Claude Code 的 .claude.json），不传 original 是手动添加
 */
function ServerDialog({
  original,
  userScope = false,
  initial,
  names = [],
  onClose,
  onSaved,
}: {
  original?: string;
  userScope?: boolean;
  initial: ServerForm;
  names?: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ServerForm>(initial);
  // 第三种写法：直接编辑 mcpServers 格式的 JSON。切过来时把表单转成 JSON，切回 STDIO / HTTP 或保存时按 JSON 的内容
  const [jsonMode, setJsonMode] = useState(false);
  const [json, setJson] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (key: keyof ServerForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const stdio = form.type === "stdio";
  const editing = original !== undefined;
  const title = editing ? "编辑 MCP 服务器" : "添加 MCP 服务器";
  const isTaken = (f: ServerForm) => {
    const n = f.name.trim();
    return (!editing || n !== original) && names.includes(n);
  };
  const name = form.name.trim();
  const renamed = editing && name !== original;
  const taken = isTaken(form);

  /** 按 JSON 的内容得到表单；JSON 是空的时沿用表单，写错了在下面报错并返回 null。JSON 里没写名字（单个配置）时沿用表单的名字 */
  const fromJson = (): ServerForm | null => {
    if (!json.trim()) return form;
    try {
      const parsed = parseServerJson(json);
      setNote(parsed.note ?? null);
      setError(null);
      return parsed.form.name ? parsed.form : { ...parsed.form, name: form.name };
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const switchTo = (target: "stdio" | "http" | "json") => {
    if (target === "json") {
      if (!jsonMode) {
        setJson(formToJson(form));
        setJsonMode(true);
        setNote(null);
        setError(null);
      }
      return;
    }
    let base = form;
    if (jsonMode) {
      const parsed = fromJson();
      if (!parsed) return;
      base = parsed;
      setJsonMode(false);
    }
    setForm({ ...base, type: target === "stdio" ? "stdio" : base.type === "sse" ? "sse" : "http" });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let f = form;
    if (jsonMode) {
      const parsed = fromJson();
      if (!parsed) return;
      f = parsed;
      setForm(parsed);
      const missing = !parsed.name.trim() ? "JSON 里没有服务器名称（mcpServers 下的键）" : parsed.type === "stdio" ? (!parsed.command.trim() ? "JSON 里没有 command" : null) : !parsed.url.trim() ? "JSON 里没有 url" : null;
      if (missing) return setError(missing);
    }
    const n = f.name.trim();
    if (isTaken(f)) return setError(`已经有名为「${n}」的连接器，换一个名字`);
    setSaving(true);
    const input: Omit<McpServerInput, "name"> =
      f.type === "stdio"
        ? { type: "stdio", command: f.command.trim(), args: f.args.split("\n").map((a) => a.trim()).filter(Boolean), env: parsePairs(f.env, "=") }
        : { type: f.type, url: f.url.trim(), headers: parsePairs(f.headers, ":") };
    (editing ? api.updateMcpServer(original, { ...input, name: n }) : api.saveMcpServer(n, input))
      .then(
        () => {
          onClose();
          onSaved();
        },
        (err: Error) => setError(err.message),
      )
      .finally(() => setSaving(false));
  };

  const mode = jsonMode ? "json" : stdio ? "stdio" : "http";
  const modes = [
    ["stdio", "STDIO（本机命令）"],
    ["http", "HTTP（远程地址）"],
    ["json", "JSON"],
  ] as const;

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog settings-form mcp-dialog" aria-label={title} onSubmit={submit}>
        <h3>{title}</h3>
        {!jsonMode && (
          <label>
            名称
            <input
              autoFocus
              required
              value={form.name}
              onChange={update("name")}
              placeholder="例如 filesystem、github"
              pattern="[\w\-]+"
              title="字母、数字、下划线和连字符"
              aria-invalid={taken || undefined}
            />
          </label>
        )}
        {!jsonMode && taken && <div className="settings-error">已经有名为「{name}」的连接器，换一个名字</div>}
        {userScope && <p className="mcp-hint">这是 Claude Code 用户范围的服务器，保存后改的是 Claude Code 自己的配置（.claude.json），终端里直接用 claude 也会跟着变。</p>}
        {!jsonMode && renamed && !taken && (
          <p className="mcp-hint">改名后模型看到的工具名跟着变（mcp__{name || "…"}__工具名）{stdio ? "。" : "；保存的登录信息按名字记，改名后要重新登录。"}</p>
        )}
        <div className="mcp-type" role="radiogroup" aria-label="类型">
          {modes.map(([key, label]) => (
            <button key={key} type="button" role="radio" aria-checked={mode === key} className={mode === key ? "active" : undefined} onClick={() => switchTo(key)}>
              {label}
            </button>
          ))}
        </div>
        {note && <p className="mcp-hint">{note}</p>}
        {jsonMode ? (
          <>
            <label className="mcp-json">
              mcpServers 格式的配置，键是名称
              <textarea autoFocus className="mono" rows={8} value={json} placeholder={JSON_PLACEHOLDER} spellCheck={false} onChange={(e) => setJson(e.target.value)} />
            </label>
            <p className="mcp-hint">可以直接改，也可以换成 MCP 服务器文档里给的配置。切回 STDIO / HTTP 或保存时按这里的内容。</p>
          </>
        ) : stdio ? (
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
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={saving || (!jsonMode && taken)}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
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

function AgentIcon() {
  return (
    <svg className="ic ic-agent" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="3.6" r="2" fill="currentColor" fillOpacity="0.2" />
      <circle cx="3.6" cy="12.4" r="1.6" />
      <circle cx="12.4" cy="12.4" r="1.6" />
      <path d="M8 5.6v2.6M8 8.2 4.6 11M8 8.2l3.4 2.8" />
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

/** 爪印 */
function PetIcon() {
  return (
    <svg className="ic" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <ellipse cx="4" cy="7" rx="1.5" ry="1.9" />
      <ellipse cx="6.6" cy="4.2" rx="1.5" ry="1.9" />
      <ellipse cx="9.4" cy="4.2" rx="1.5" ry="1.9" />
      <ellipse cx="12" cy="7" rx="1.5" ry="1.9" />
      <path d="M8 7.6c-2 0-3.8 2.1-3.8 3.9 0 1.3 1 1.9 2 1.9.7 0 1.2-.4 1.8-.4s1.1.4 1.8.4c1 0 2-.6 2-1.9 0-1.8-1.8-3.9-3.8-3.9Z" />
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

/** 浏览器：地球（经线、纬线） */
function BrowsersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.8 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.45 5.5 8S6.3 3.55 8 1.75z" />
    </svg>
  );
}

/** 网络代理：两个节点之间的中转点，来回两条线 */
function ProxyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="2.75" cy="8" r="1.5" />
      <circle cx="13.25" cy="8" r="1.5" />
      <rect x="6" y="5.5" width="4" height="5" rx="1" />
      <path d="M4.25 8H6M10 8h1.75" />
    </svg>
  );
}

/** 公网分享：三个点连成的分享符号 */
function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="3.5" r="2" />
      <circle cx="4" cy="8" r="2" />
      <circle cx="12" cy="12.5" r="2" />
      <path d="M5.8 7 10.2 4.5M5.8 9l4.4 2.5" />
    </svg>
  );
}

/** 终端提示符：远程主机 */
function SshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M4.5 6.5l2 1.75-2 1.75M8.25 10.25h3" />
    </svg>
  );
}
