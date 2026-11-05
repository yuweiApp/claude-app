import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { EffortLevel, ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { api, subscribe, type Capabilities, type GatewayConfig, type SessionListItem } from "./api";
import { CapabilityPicker } from "./components/CapabilityPicker";
import { PluginNamesContext } from "./components/MentionText";
import { Composer, type ComposerHandle } from "./components/Composer";
import { Messages } from "./components/Messages";
import { PermissionCard } from "./components/PermissionCard";
import { FolderPicker } from "./components/FolderPicker";
import { ModelPicker, PermissionPicker, resolveModel } from "./components/ComposerPickers";
import { Sidebar, folderName, groupByFolder, sessionTitle } from "./components/Sidebar";
import { DEFAULT_SIDEBAR_WIDTH, SidebarResizer } from "./components/SidebarResizer";
import { SidebarToggle } from "./components/SidebarToggle";
import { SettingsPage } from "./components/SettingsPage";
import { TasksPopover } from "./components/TasksPopover";
import { TitleBar } from "./components/TitleBar";
import { desktop } from "./desktop";
import { emptyView, reduce } from "./state/session";

/** 浏览记录（桌面版标题栏的后退 / 前进）：打开过的会话，null 是新会话页 */
interface History {
  stack: (string | null)[];
  index: number;
}

export function App() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [history, setHistory] = useState<History>({ stack: [null], index: 0 });
  const currentId = history.stack[history.index] ?? null;
  /** 新聊天页选的项目（工作目录），null 是默认工作目录 */
  const [newCwd, setNewCwd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  /** 图标栏上开着的页面：首页（会话）或设置 */
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  /** 打开会话（null 是新会话页）；replace 时替换当前这条记录，不新增 */
  const navigate = (id: string | null, replace = false) =>
    setHistory((h) => {
      if (h.stack[h.index] === id) return h;
      const stack = [...h.stack.slice(0, replace ? h.index : h.index + 1), id];
      return { stack, index: stack.length - 1 };
    });
  const go = (delta: number) =>
    setHistory((h) => {
      const index = h.index + delta;
      return index >= 0 && index < h.stack.length ? { ...h, index } : h;
    });
  /** 删掉的会话在浏览记录里换成新会话页（正在看的被删了就回到新会话页），相邻重复的合并 */
  const forget = (ids: string[]) =>
    setHistory((h) => {
      const stack: (string | null)[] = [];
      let index = 0;
      h.stack.forEach((id, i) => {
        const entry = id && ids.includes(id) ? null : id;
        if (!stack.length || stack.at(-1) !== entry) stack.push(entry);
        if (i === h.index) index = stack.length - 1;
      });
      return { stack, index };
    });
  const select = (id: string | null) => navigate(id);
  const startNew = (cwd?: string) => {
    setNewCwd(cwd ?? null);
    select(null);
  };
  const current = sessions.find((s) => s.sessionId === currentId);
  // 会话标题和所在项目，显示在对话上方那一行（右边是会话栏按钮）；新会话页没有
  const title = currentId ? (current ? sessionTitle(current) : "新会话") : null;
  const folder = current?.cwd && config && current.cwd !== config.workspaceDir ? folderName(current.cwd) : null;

  const deleteSessions = async (ids: string[]) => {
    const results = await Promise.allSettled(ids.map((id) => api.deleteSession(id)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) setError(`有 ${failed.length} 个会话删除失败：${(failed[0]!.reason as Error).message}`);
    forget(ids);
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
          canBack={history.index > 0}
          canForward={history.index < history.stack.length - 1}
          onBack={() => go(-1)}
          onForward={() => go(1)}
          sidebarCollapsed={collapsed}
          onToggleSidebar={toggleSidebar}
        />
      )}
      <div className="app">
        {/* 最左边的功能图标栏（同 codex-app-server 的 .sidebar-rail）：现在只有首页，之后的功能往这里加 */}
        <nav className="app-rail" aria-label="功能">
          <button
            className={`rail-btn${settingsOpen ? "" : " active"}`}
            title="首页"
            aria-label="首页"
            aria-current={settingsOpen ? undefined : "page"}
            onClick={() => (settingsOpen ? setSettingsOpen(false) : startNew())}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 8.75 10 3.5l6.5 5.25V15.5a1 1 0 0 1-1 1h-3.25v-4.25h-4.5v4.25H4.5a1 1 0 0 1-1-1z" />
            </svg>
          </button>
          <button
            className={`rail-btn rail-bottom${settingsOpen ? " active" : ""}`}
            title="设置"
            aria-label="设置"
            aria-current={settingsOpen ? "page" : undefined}
            onClick={() => setSettingsOpen(true)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9.49 5.25L10.30 2.55L13.70 2.55L14.51 5.25L16.59 6.45L19.33 5.80L21.03 8.75L19.10 10.80L19.10 13.20L21.03 15.25L19.33 18.20L16.59 17.55L14.51 18.75L13.70 21.45L10.30 21.45L9.49 18.75L7.41 17.55L4.67 18.20L2.97 15.25L4.90 13.20L4.90 10.80L2.97 8.75L4.67 5.80L7.41 6.45Z" />
              <circle cx="12" cy="12" r="3.1" />
            </svg>
          </button>
        </nav>
        {settingsOpen && <SettingsPage />}
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
          <main>
            {error && (
              <div className="banner" onClick={() => setError(null)}>
                {error}
              </div>
            )}
            {config && (
              <Chat
                key={currentId ?? "new"}
                sessionId={currentId}
                cwd={currentId ? (current?.cwd ?? null) : newCwd}
                folderPicker={
                  !currentId && (
                    <FolderPicker
                      value={newCwd}
                      recent={groupByFolder(sessions, config.workspaceDir).map((g) => g.cwd).filter((d) => d !== config.workspaceDir)}
                      onChange={setNewCwd}
                    />
                  )
                }
                config={config}
                onCreated={(id) => {
                  // 新会话页变成了这个会话，不另记一条
                  navigate(id, true);
                  refresh();
                }}
                onChanged={refresh}
                onError={setError}
                headerStart={!desktop && collapsed && <SidebarToggle collapsed onToggle={toggleSidebar} />}
              title={title}
              folder={folder}
              />
            )}
          </main>
        )}
      </div>
    </div>
  );
}

const COLLAPSED_KEY = "sidebarCollapsed";
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
  title,
  folder,
  folderPicker,
}: ChatProps) {
  const [view, dispatch] = useReducer(reduce, undefined, emptyView);
  const [newMode, setNewMode] = useState<PermissionMode>(config.permissionMode);
  // 新会话选的模型（模型列表里的 value）和推理强度，发第一条消息时带上
  const [newModel, setNewModel] = useState<string | undefined>();
  const [newEffort, setNewEffort] = useState<EffortLevel>(config.effort);
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    api.models().then(setModels, (e: Error) => onError(`读取模型列表失败：${e.message}`));
  }, []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  // 技能和插件按工作目录（项目里可以有自己的技能）
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  useEffect(() => {
    api.capabilities(cwd ?? undefined).then(setCapabilities, () => setCapabilities(null));
  }, [cwd]);
  const pluginNames = useMemo(() => capabilities?.plugins.map((p) => p.name) ?? [], [capabilities]);

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

  // 在底部时跟着新内容往下滚；往上翻了就不动，出「回到底部」按钮
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = bottom;
    setAtBottom(bottom);
  };
  const scrollToBottom = (behavior: ScrollBehavior) => {
    stickRef.current = true;
    bottomRef.current?.scrollIntoView({ block: "end", behavior });
  };
  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [view.items.length, view.streaming.text, view.permissions.length]);
  // 内容变高（图片加载完、展开工具输出、流式文字）时，在底部的继续贴着底部
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  const send = async (text: string, attachments: string[]) => {
    scrollToBottom("smooth");
    try {
      if (sessionId) await api.send(sessionId, text, attachments);
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
    <PluginNamesContext.Provider value={pluginNames}>
    <div className="chat">
      {(headerStart || title) && (
        <div className="chat-header">
          {headerStart}
          {title && (
            <span className="chat-title" title={title}>
              {title}
            </span>
          )}
          {folder && (
            <span className="muted" title={cwd ?? undefined}>
              {folder}
            </span>
          )}
          {sessionId && <TasksPopover sessionId={sessionId} tasks={view.backgroundTasks} onError={onError} />}
        </div>
      )}
      <div className="scroll-area">
      <div className="scroll" ref={scrollRef} onScroll={onScroll}>
        {!sessionId && (
          <div className="empty">
            有什么可以帮你？
            {cwd && <div className="empty-sub">新会话在 {cwd}</div>}
          </div>
        )}
        <Messages view={view} />
        {view.permissions.map((request) => (
          <PermissionCard
            key={request.requestId}
            request={request}
            onReply={(behavior, always) => {
              if (sessionId) {
                api.replyPermission(sessionId, request.requestId, behavior, always).catch((e: Error) => onError(e.message));
              }
            }}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      {!atBottom && <ScrollToBottom running={view.state === "running"} onClick={() => scrollToBottom("smooth")} />}
      </div>
      <Composer
        running={view.state === "running"}
        maxUploadMb={config.maxUploadMb}
        onSend={send}
        onInterrupt={() => sessionId && api.interrupt(sessionId).catch((e: Error) => onError(e.message))}
        onContinue={interrupted ? () => void send("继续", []).catch(() => undefined) : undefined}
        left={<PermissionPicker value={permissionMode} onChange={changeMode} />}
        handle={composerRef}
        cwd={cwd}
        top={
          <>
            {folderPicker}
            <CapabilityPicker kind="技能" items={capabilities?.skills.filter((s) => s.enabled) ?? []} onPick={(name) => composerRef.current?.useSkill(name)} />
            <CapabilityPicker kind="插件" items={capabilities?.plugins ?? []} onPick={(name) => composerRef.current?.mention(name)} />
          </>
        }
        right={
          <ModelPicker
            models={models}
            model={sessionId ? (view.model ?? config.model ?? undefined) : (resolveModel(models, newModel) ?? config.model ?? undefined)}
            effort={sessionId ? (view.effort ?? config.effort) : newEffort}
            onModel={(value) => {
              if (!sessionId) setNewModel(value);
              else api.setModel(sessionId, { model: value }).catch((e: Error) => onError(e.message));
            }}
            onEffort={(effort) => {
              if (!sessionId) setNewEffort(effort);
              else api.setModel(sessionId, { effort }).catch((e: Error) => onError(e.message));
            }}
          />
        }
      />
    </div>
    </PluginNamesContext.Provider>
  );
}

/** 对话区底部正中的「回到底部」：平时是向下箭头，代理运行中是跳动的三个点 */
function ScrollToBottom({ running, onClick }: { running: boolean; onClick: () => void }) {
  return (
    <button className="scroll-bottom" onClick={onClick} title="回到底部" aria-label="回到底部">
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
