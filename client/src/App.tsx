import { HostIcon } from "./components/HostIcon";
import { sshName } from "./state/sshConnections";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { GearGlyph, HomeGlyph, IosIcon } from "./components/IosIcon";
import type { EffortLevel, ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { api, BROWSERS_CHANGED, subscribe, type Capabilities, type ExternalBrowserInfo, type GatewayConfig, type SessionListItem } from "./api";
import { CapabilityPicker } from "./components/CapabilityPicker";
import { MentionNamesContext } from "./components/MentionText";
import { Composer, type ComposerHandle } from "./components/Composer";
import { Messages } from "./components/Messages";
import { PermissionCard } from "./components/PermissionCard";
import { EnvPicker, FolderPicker } from "./components/FolderPicker";
import { ModelPicker, PermissionPicker, resolveModel } from "./components/ComposerPickers";
import { Sidebar, folderName, groupByFolder, sessionTitle } from "./components/Sidebar";
import { DEFAULT_SIDEBAR_WIDTH, SidebarResizer } from "./components/SidebarResizer";
import { SidebarToggle } from "./components/SidebarToggle";
import { SettingsPage, type SettingsSection } from "./components/SettingsPage";
import { revealInTree, type LineRange } from "./components/FileBrowser";
import { newPanelState, PanelIcon, SidePanel, withBrowserTab, withFileOpen, withFolderTab, type PanelState } from "./components/SidePanel";
import { FileLinkContext } from "./components/ReplyMarkdown";
import { TasksPopover } from "./components/TasksPopover";
import { DesktopTargetFloat } from "./components/DesktopTargetFloat";
import { TitleBar } from "./components/TitleBar";
import { desktop } from "./desktop";
import { useBrowserTabs } from "./state/browserTabs";
import { TabPicker } from "./components/TabPicker";
import { isRemote, machinePath, parseRemote } from "./remote";
import { DesktopPicker } from "./components/DesktopPicker";
import { emptyView, reduce } from "./state/session";
import { AnnotationEditor, AnnotationSelectionButton, AnnotationSessionContext, NotesChip } from "./components/ResponseAnnotations";
import { ANNOTATION_SCOPE_ATTR, clearResponseAnnotations, useResponseAnnotations, withResponseAnnotations } from "./state/responseAnnotations";

export function App() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  /** 正在看的会话，null 是新会话页 */
  const [currentId, setCurrentId] = useState<string | null>(null);
  /** 新聊天页选的项目（工作目录），null 是默认工作目录 */
  const [newCwd, setNewCwd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  /** 图标栏上开着的页面：首页（会话）或设置 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 打开设置时先显示哪一页（新会话栏的「管理 SSH 连接…」直接到 SSH 连接） */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>();
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const commitSidebarWidth = (width: number) => {
    setSidebarWidth(width);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {
      // 写不了就只在这次打开里生效
    }
  };
  const toggleSidebar = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, String(!c));
      } catch {
        // 无痕模式等写不了，只在这次打开里生效
      }
      return !c;
    });
  /** 删掉的会话正在看的话回到新会话页 */
  const forget = (ids: string[]) => setCurrentId((id) => (id && ids.includes(id) ? null : id));
  const select = (id: string | null) => setCurrentId(id);
  /** 切到新会话页：右侧面板默认收起，要用再点开 */
  const startNew = (cwd?: string) => {
    setNewCwd(cwd ?? null);
    select(null);
    showPanel(false);
  };
  const current = sessions.find((s) => s.sessionId === currentId);
  /** 有会话在运行时，图标栏的首页图标带动效 */
  const anyRunning = sessions.some((s) => s.state === "running");
  // 会话标题和工作目录，显示在对话上方那一行（右边是会话栏按钮）；新会话页没有。
  // 项目会话显示项目文件夹名，悬停看完整路径；普通会话（侧栏「会话」里的）的 scratch-… 目录是网关建的，不显示
  const title = currentId ? (current ? sessionTitle(current) : "新会话") : null;
  const folder = current?.cwd && !current.chat ? folderName(current.cwd) : null;
  const chatCwd = currentId ? (current?.cwd ?? null) : newCwd;
  // 右侧面板（文件、终端、浏览器）开在会话的工作目录：项目文件夹，或者普通会话自己的 scratch 目录。
  // 发出第一条消息、会话建好（列表里有了）之后才能用：新会话页还没有工作目录（普通会话的 scratch 目录是建会话时才有的），按钮置灰。
  // 旧的普通会话工作目录就是 workspace 本身，文件树列的就是整个 workspace。开着还是收起全局记住，标签页按文件夹分开
  const panelCwd = config && current ? current.cwd || config.workspaceDir : null;
  const [panelOpen, setPanelOpen] = useState(initialPanelOpen);
  // 标签页按文件夹存在 localStorage，重启、刷新后恢复（浏览器标签按 key 对回桌面版恢复的标签页，终端标签按网关上还在不在）
  const [panels, setPanels] = useState<Record<string, PanelState>>(initialPanels);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
      } catch {
        // 忽略
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [panels]);
  // 还没改过的项目用同一个默认状态（每次渲染新建的话标签页 id 会变）
  const defaultPanels = useRef<Record<string, PanelState>>({});
  const panelOf = (all: Record<string, PanelState>, cwd: string) => all[cwd] ?? (defaultPanels.current[cwd] ??= newPanelState());
  const showPanel = (open: boolean) => {
    setPanelOpen(open);
    try {
      localStorage.setItem(PANEL_OPEN_KEY, String(open));
    } catch {
      // 忽略
    }
  };
  const togglePanel = () => showPanel(!panelOpen);
  // 回复里指向本地文件的链接：打开右侧面板，在文件标签里显示；指向文件夹的在目录树里定位。root 是工作目录外的，标签以它为根。
  // 网址：桌面版给当前会话新建一个内置浏览器的标签页，打开右侧面板切过去
  const browserSessionId = current?.sessionId ?? null;
  const fileLinks = useMemo(
    () =>
      panelCwd
        ? {
            cwd: panelCwd,
            openUrl:
              desktop?.browser && browserSessionId
                ? async (url: string) => {
                    let info;
                    try {
                      info = await desktop!.browser.create(browserSessionId, url);
                    } catch (err) {
                      // 常见于桌面版外壳还是旧的（同 SidePanel 的 openBrowser）
                      window.alert(`打开网页失败：${(err as Error).message}\n\n如果刚更新过代码，请重启桌面版。`);
                      return;
                    }
                    if (!info) return;
                    setPanels((all) => {
                      const state = panelOf(all, panelCwd);
                      return { ...all, [panelCwd]: withBrowserTab(state, state.active, info) };
                    });
                    showPanel(true);
                  }
                : undefined,
            open: (path: string, root?: string, line?: LineRange | null) => {
              setPanels((all) => {
                const state = panelOf(all, panelCwd);
                return { ...all, [panelCwd]: withFileOpen(state, state.active, path, false, root, line) };
              });
              showPanel(true);
            },
            openFolder: (path: string, root?: string) => {
              setPanels((all) => {
                const state = panelOf(all, panelCwd);
                return { ...all, [panelCwd]: withFolderTab(state, state.active, root) };
              });
              showPanel(true);
              if (path) revealInTree(root ?? panelCwd, path);
            },
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panelCwd, browserSessionId],
  );

  const deleteSessions = async (ids: string[]) => {
    const results = await Promise.allSettled(ids.map((id) => api.deleteSession(id)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) setError(`有 ${failed.length} 个会话删除失败：${(failed[0]!.reason as Error).message}`);
    forget(ids);
    refresh();
  };

  /** 先在列表里换上新标题，失败时报错并按网关的列表改回来 */
  const renameSession = async (id: string, title: string) => {
    setSessions((all) => all.map((s) => (s.sessionId === id ? { ...s, customTitle: title } : s)));
    try {
      await api.renameSession(id, title);
    } catch (e) {
      setError(`重命名失败：${(e as Error).message}`);
    }
    refresh();
  };

  const refresh = useCallback(() => {
    api.listSessions().then(setSessions, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    api.config().then(setConfig, (e: Error) => setError(e.message));
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="app-shell">
      {desktop && (
        <TitleBar
          desktop={desktop}
          sidebarCollapsed={collapsed}
          onToggleSidebar={toggleSidebar}
        />
      )}
      <div className="app">
        {/* 最左边的功能图标栏（同 codex-app-server 的 .sidebar-rail）：现在只有首页，之后的功能往这里加 */}
        <nav className="app-rail" aria-label="功能">
          <button
            className={`rail-btn rail-home${settingsOpen ? "" : " active"}${anyRunning ? " running" : ""}`}
            title={anyRunning ? "首页 · 有会话在运行" : "首页"}
            aria-label={anyRunning ? "首页，有会话在运行" : "首页"}
            aria-current={settingsOpen ? undefined : "page"}
            // 从设置回到首页，留在原来看的会话；已经在首页就不动（新建会话用侧栏的「新会话」）
            onClick={() => setSettingsOpen(false)}
          >
            <IosIcon tone="orange" size={28}>
              <HomeGlyph />
            </IosIcon>
          </button>
          <button
            className={`rail-btn rail-bottom${settingsOpen ? " active" : ""}`}
            title="设置"
            aria-label="设置"
            aria-current={settingsOpen ? "page" : undefined}
            onClick={() => {
              setSettingsSection(undefined);
              setSettingsOpen(true);
            }}
          >
            <IosIcon tone="gray" size={28}>
              <GearGlyph />
            </IosIcon>
          </button>
        </nav>
        {/* 桌面版标题栏上的收起按钮在设置页里收起左边的导航；网页版设置页里没有这个按钮，导航一直显示 */}
        {settingsOpen && <SettingsPage key={settingsSection ?? "default"} initialSection={settingsSection} navCollapsed={!!desktop && collapsed} />}
        {!settingsOpen && !collapsed && (
          <>
            {config && (
              <>
                <Sidebar
                  sessions={sessions}
                  workspaceDir={config.workspaceDir}
                  currentId={currentId}
                  onSelect={select}
                  onNew={startNew}
                  onDelete={(ids) => void deleteSessions(ids)}
                  onRename={(id, title) => void renameSession(id, title)}
                  // 桌面版的收起按钮在标题栏上
                  onCollapse={desktop ? undefined : toggleSidebar}
                  width={sidebarWidth}
                />
                <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} onCommit={commitSidebarWidth} onCollapse={toggleSidebar} />
              </>
            )}
          </>
        )}
        {!settingsOpen && (
          <FileLinkContext.Provider value={fileLinks}>
          <main>
            {error && (
              <div className="banner" onClick={() => setError(null)}>
                {error}
              </div>
            )}
            <div className="main-split">
            {config && (
              <Chat
                key={currentId ?? "new"}
                sessionId={currentId}
                cwd={chatCwd}
                folderPicker={
                  !currentId && (
                    <>
                      <EnvPicker
                        value={newCwd}
                        onChange={setNewCwd}
                        onManage={() => {
                          setSettingsSection("ssh");
                          setSettingsOpen(true);
                        }}
                      />
                      <FolderPicker
                        value={newCwd}
                        recent={groupByFolder(sessions.filter((s) => !s.chat), config.workspaceDir).map((g) => g.cwd)}
                        onChange={setNewCwd}
                      />
                    </>
                  )
                }
                config={config}
                onCreated={(id) => {
                  select(id);
                  refresh();
                }}
                onChanged={refresh}
                onError={setError}
                headerStart={!desktop && collapsed && <SidebarToggle collapsed onToggle={toggleSidebar} />}
              title={title}
              folder={folder}
                headerEnd={
                  // 面板开着时收起按钮在面板上；新会话页置灰
                  (!panelCwd || !panelOpen) && (
                    <button
                      className="icon-btn panel-toggle"
                      onClick={togglePanel}
                      disabled={!panelCwd}
                      title={
                        panelCwd
                          ? `打开右侧面板（${["文件", "终端", desktop && "浏览器"].filter(Boolean).join("、")}）`
                          : `发出第一条消息后才能使用右侧面板（文件、终端${desktop ? "、浏览器" : ""}）`
                      }
                      aria-label="打开右侧面板"
                    >
                      <PanelIcon />
                    </button>
                  )
                }
              />
            )}
            {panelCwd && current && panelOpen && (
              <SidePanel
                key={panelCwd}
                cwd={panelCwd}
                sessionId={current.sessionId}
                state={panelOf(panels, panelCwd)}
                onChange={(update) =>
                  setPanels((all) => {
                    const current = panelOf(all, panelCwd);
                    const next = update(current);
                    return next === current ? all : { ...all, [panelCwd]: next };
                  })
                }
                onClose={togglePanel}
              />
            )}
            </div>
          </main>
          </FileLinkContext.Provider>
        )}
      </div>
    </div>
  );
}

const COLLAPSED_KEY = "sidebarCollapsed";
const PANEL_OPEN_KEY = "sidePanelOpen";
const PANELS_KEY = "sidePanelStates";

function initialPanels(): Record<string, PanelState> {
  try {
    const saved = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "{}") as Record<string, PanelState>;
    const valid = Object.entries(saved).filter(([, p]) => Array.isArray(p?.tabs) && p.tabs.length > 0 && typeof p.active === "string");
    return Object.fromEntries(valid);
  } catch {
    return {};
  }
}

function initialPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}
const SIDEBAR_WIDTH_KEY = "sidebarWidth";

function initialSidebarWidth(): number {
  try {
    return Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** 侧边栏和对话并排、不盖在对话上（同 codex-app-server 的电脑布局），收起 / 展开记住上次的选择 */
function initialCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

interface ChatProps {
  sessionId: string | null;
  config: GatewayConfig;
  onCreated: (id: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  /** 标题栏最左边的内容：侧边栏收起时是「展开侧边栏」按钮 */
  headerStart?: ReactNode;
  /** 标题栏最右边：右侧面板的开关 */
  headerEnd?: ReactNode;
  /** 对话上方显示的会话标题和项目名 */
  title?: string | null;
  folder?: string | null;
  /** 工作目录（文件夹）；新会话页是选的文件夹，null 是无文件夹（默认工作目录） */
  cwd: string | null;
  /** 新会话页输入框工具栏里的选文件夹 */
  folderPicker?: ReactNode;
}

function Chat({
  sessionId,
  cwd,
  config,
  onCreated,
  onChanged,
  onError,
  headerStart,
  headerEnd,
  title,
  folder,
  folderPicker,
}: ChatProps) {
  const [view, dispatch] = useReducer(reduce, undefined, emptyView);
  /** 远程会话（工作目录是 ssh://…）：输入框上面只留「浏览器」 */
  const remoteChat = isRemote(cwd);
  const remoteHost = parseRemote(cwd)?.host ?? null;
  const [newMode, setNewMode] = useState<PermissionMode>(config.permissionMode);
  // 新会话选的模型（模型列表里的 value）和推理强度，发第一条消息时带上
  const [newModel, setNewModel] = useState<string | undefined>();
  const [newEffort, setNewEffort] = useState<EffortLevel>(config.effort);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // 正在切换的模型、推理强度：要等子进程 resume、Claude Code 第一次用新模型时的检查，可能好几秒。
  // 这期间胶囊先显示要切到的，带「切换中」样式；接口返回（成功时会话的 state 事件已经先到）或报错后清掉
  const [switching, setSwitching] = useState<{ model?: string; effort?: EffortLevel } | null>(null);
  const switchSeq = useRef(0);
  const switchModel = (id: string, change: { model?: string; effort?: EffortLevel }) => {
    const seq = ++switchSeq.current;
    setSwitching((prev) => ({ ...prev, ...change }));
    api
      .setModel(id, change)
      .catch((e: Error) => onError(`切换${change.model !== undefined ? "模型" : "推理强度"}失败：${e.message}`))
      // 连着点了几次时，等最后一次返回再清
      .finally(() => seq === switchSeq.current && setSwitching(null));
  };
  useEffect(() => {
    api.models().then(setModels, (e: Error) => onError(`读取模型列表失败：${e.message}`));
  }, []);
  const composerRef = useRef<ComposerHandle>(null);
  // 桌面版内置浏览器里这个会话的标签页，输入框 @ 可以引用
  const browserTabs = useBrowserTabs(sessionId);
  // 技能和插件按工作目录（项目里可以有自己的技能）
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  useEffect(() => {
    api.capabilities(cwd ?? undefined).then(setCapabilities, () => setCapabilities(null));
  }, [cwd]);
  // 启用着的外部浏览器（设置页「浏览器」）：引用的名字、图标和输入框上面的「浏览器」菜单用。设置页改了会发 BROWSERS_CHANGED
  const [externalBrowsers, setExternalBrowsers] = useState<ExternalBrowserInfo[]>([]);
  useEffect(() => {
    const load = () => api.externalTabs().then((list) => setExternalBrowsers(list.map(({ id, name, logo }) => ({ id, name, logo }))), () => undefined);
    load();
    window.addEventListener(BROWSERS_CHANGED, load);
    return () => window.removeEventListener(BROWSERS_CHANGED, load);
  }, []);
  const mentionNames = useMemo(
    () => ({
      plugins: capabilities?.plugins.map((p) => p.name) ?? [],
      skills: capabilities?.skills.filter((s) => s.enabled).map((s) => s.name) ?? [],
      browsers: externalBrowsers,
    }),
    [capabilities, externalBrowsers],
  );

  // 先连事件流再拉历史，两边按 uuid 去重，见 docs/README.md「客户端归并规则」
  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = subscribe(sessionId, (event) => {
      dispatch({ type: "event", event });
      if (event.type === "state" || event.type === "title") onChanged();
    });
    api.messages(sessionId).then((messages) => dispatch({ type: "history", messages }), (e: Error) => onError(e.message));
    api.tasks(sessionId).then((tasks) => dispatch({ type: "tasks", tasks }), () => undefined);
    return unsubscribe;
  }, [sessionId]);


  useEffect(() => {
    if (view.needsReload && sessionId) {
      api.messages(sessionId).then((messages) => dispatch({ type: "history", messages }), (e: Error) => onError(e.message));
    }
  }, [view.needsReload, sessionId]);

  // 在底部时跟着新内容往下滚；用户自己往上翻了才不跟，出「回到底部」按钮。
  // 是不是用户在滚只看输入事件（滚轮、触摸、按键、拖滚动条），不看 scrollTop 变小：
  // 平滑滚动和设 scrollTop 打架、内容收起时浏览器夹住 scrollTop，都会让它变小，但不是用户要往上看
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const lastTopRef = useRef(0);
  const userScrollRef = useRef(0); // 最近一次用户滚动输入的时间
  const pointerDownRef = useRef(false); // 按住滚动条拖动中
  const pinToBottom = () => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const byUser = pointerDownRef.current || performance.now() - userScrollRef.current < 300;
    if (bottom) stickRef.current = true;
    else if (byUser && el.scrollTop < lastTopRef.current - 2) stickRef.current = false;
    lastTopRef.current = el.scrollTop;
    setAtBottom(bottom || stickRef.current);
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mark = () => (userScrollRef.current = performance.now());
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) mark();
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) mark();
    };
    // 点在滚动容器自身（不是里面的内容）上，就是在拖滚动条
    const onDown = (e: PointerEvent) => {
      if (e.target === el) pointerDownRef.current = true;
    };
    const onUp = () => (pointerDownRef.current = false);
    // 平滑滚动停下时内容可能又长了，补一下
    const onScrollEnd = () => pinToBottom();
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    el.addEventListener("scrollend", onScrollEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      el.removeEventListener("scrollend", onScrollEnd);
    };
  }, []);
  const scrollToBottom = (behavior: ScrollBehavior) => {
    stickRef.current = true;
    setAtBottom(true);
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior });
  };
  useEffect(pinToBottom, [view.items.length, view.streaming.text, view.permissions.length]);
  // 内容变高（流式文字、图片加载完、展开工具输出）或对话区变矮（输入框变高）时，在底部的继续贴着底部
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
      // 内容变矮时浏览器把 scrollTop 夹到底部，不一定发 scroll 事件，这里补上「已在底部」
      else if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
        stickRef.current = true;
        setAtBottom(true);
      }
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // 在 Claude 的回复里选中文字写的回复，随下一条消息发出
  const annotations = useResponseAnnotations(sessionId);
  const send = async (text: string, attachments: string[]) => {
    // 发消息直接跳到底部：平滑滚动途中新消息、回复接连进来，和贴底部的跳转打架
    scrollToBottom("auto");
    try {
      if (sessionId) {
        const message = withResponseAnnotations(text, annotations);
        await api.send(sessionId, message.text, attachments, message.elements);
        if (annotations.length) clearResponseAnnotations(sessionId);
      }
      else onCreated(await api.createSession(text, attachments, { permissionMode: newMode, cwd: cwd ?? undefined, model: newModel, effort: newEffort }));
    } catch (e) {
      onError((e as Error).message);
      throw e;
    }
  };

  // 最后一轮是中断的（后面只有 result、换模型之类的提示）：输入框空着时可以一键「继续」
  const lastItem = view.items.findLast((item) => item.kind !== "result" && item.kind !== "model" && item.kind !== "notice");
  const interrupted = !!sessionId && view.state !== "running" && lastItem?.kind === "interrupted";

  const permissionMode = sessionId ? (view.permissionMode ?? config.permissionMode) : newMode;
  const changeMode = (mode: string) => {
    if (!sessionId) setNewMode(mode as PermissionMode);
    else api.setPermissionMode(sessionId, mode as PermissionMode).catch((e: Error) => onError(e.message));
  };

  return (
    <MentionNamesContext.Provider value={mentionNames}>
    <div className="chat">
      {(headerStart || title || headerEnd) && (
        <div className="chat-header">
          {headerStart}
          {title && (
            <span className="chat-title" title={title}>
              {title}
            </span>
          )}
          {folder && (
            <span className="chat-folder" title={remoteHost ? `${sshName(remoteHost)}：${machinePath(cwd!)}` : (cwd ?? undefined)}>
              {remoteHost && <HostIcon hostId={remoteHost} size={12} />}
              {folder}
            </span>
          )}
          {sessionId && <TasksPopover sessionId={sessionId} tasks={view.backgroundTasks} onError={onError} />}
          {headerEnd && <span className="chat-header-end">{headerEnd}</span>}
        </div>
      )}
      <div className="scroll-area">
      <div className="scroll" ref={scrollRef} onScroll={onScroll} {...(sessionId && { [ANNOTATION_SCOPE_ATTR]: sessionId })}>
        <div className="scroll-content" ref={contentRef}>
        {!sessionId && (
          <div className="empty">
            有什么可以帮你？
            {cwd && <div className="empty-sub">新会话在 {remoteHost ? `${sshName(remoteHost)}${parseRemote(cwd)!.path ? `：${machinePath(cwd)}` : ""}` : cwd}</div>}
          </div>
        )}
        <AnnotationSessionContext.Provider value={sessionId}>
          <Messages view={view} />
        </AnnotationSessionContext.Provider>
        {view.permissions.map((request) => (
          <PermissionCard
            key={request.requestId}
            request={request}
            onReply={(behavior, always, answers) => {
              if (sessionId) {
                api.replyPermission(sessionId, request.requestId, behavior, always, answers).catch((e: Error) => onError(e.message));
              }
            }}
          />
        ))}
        </div>
      </div>
      {!atBottom && <ScrollToBottom running={view.state === "running"} onClick={() => scrollToBottom("smooth")} />}
      {sessionId && view.desktopTarget && <DesktopTargetFloat key={sessionId} target={view.desktopTarget} running={view.state === "running"} />}
      </div>
      <AnnotationSelectionButton scrollRef={scrollRef} />
      <AnnotationEditor sessionId={sessionId} onSaved={() => composerRef.current?.focus()} />
      <Composer
        running={view.state === "running"}
        maxUploadMb={config.maxUploadMb}
        onSend={send}
        onInterrupt={() => sessionId && api.interrupt(sessionId).catch((e: Error) => onError(e.message))}
        onContinue={interrupted ? () => void send("继续", []).catch(() => undefined) : undefined}
        left={<PermissionPicker value={permissionMode} onChange={changeMode} />}
        handle={composerRef}
        cwd={cwd}
        notes={sessionId && <NotesChip sessionId={sessionId} annotations={annotations} />}
        hasNotes={annotations.length > 0}
        top={
          <>
            {folderPicker}
            {/* 远程会话（SSH）只留「浏览器」：技能、插件、Computer Use 远端都不挂 */}
            {!remoteChat && <CapabilityPicker kind="技能" items={capabilities?.skills.filter((s) => s.enabled && !s.builtin) ?? []} onPick={(name) => composerRef.current?.mentionSkill(name)} />}
            {!remoteChat && <CapabilityPicker kind="插件" items={capabilities?.plugins.filter((p) => !p.builtin) ?? []} onPick={(name) => composerRef.current?.mention(name)} />}
            <TabPicker
              inapp={browserTabs}
              external={externalBrowsers}
              onPick={(tab, source) => composerRef.current?.mentionTab(tab.title, tab.url, source)}
              onPickBrowser={(b) => composerRef.current?.mentionBrowser(b?.name ?? "内置浏览器")}
            />
            <DesktopPicker
              enabled={config.desktop && !remoteChat}
              onPick={(w) => composerRef.current?.mentionTab(w.title || w.app, `window:${w.id}`, "desktop", w.app)}
              onPickDesktop={() => composerRef.current?.mentionBrowser("桌面")}
            />
          </>
        }
        right={
          <ModelPicker
            models={models}
            model={
              // 网关重启后子进程没起来的会话没有 state 事件：按历史里最后一次回复的模型，resume 时网关也用它
              sessionId
                ? (resolveModel(models, switching?.model) ?? view.model ?? view.shownModel ?? config.model ?? undefined)
                : (resolveModel(models, newModel) ?? config.model ?? undefined)
            }
            effort={sessionId ? (switching?.effort ?? view.effort ?? config.effort) : newEffort}
            switching={switching !== null}
            onModel={(value) => {
              if (!sessionId) setNewModel(value);
              else switchModel(sessionId, { model: value });
            }}
            onEffort={(effort) => {
              if (!sessionId) setNewEffort(effort);
              else switchModel(sessionId, { effort });
            }}
          />
        }
      />
    </div>
    </MentionNamesContext.Provider>
  );
}

/** 对话区底部正中的「回到底部」：平时是向下箭头，代理运行中是跳动的三个点 */
function ScrollToBottom({ running, onClick }: { running: boolean; onClick: () => void }) {
  return (
    <button className={running ? "scroll-bottom running" : "scroll-bottom"} onClick={onClick} title="回到底部" aria-label="回到底部">
      {running ? (
        <span className="scroll-bottom-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
        </svg>
      )}
    </button>
  );
}
