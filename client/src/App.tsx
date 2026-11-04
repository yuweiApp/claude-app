import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { EffortLevel, ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { api, subscribe, type GatewayConfig, type SessionListItem } from "./api";
import { Composer } from "./components/Composer";
import { Messages } from "./components/Messages";
import { PermissionCard } from "./components/PermissionCard";
import { FolderPicker } from "./components/FolderPicker";
import { ModelPicker, PermissionPicker, resolveModel } from "./components/ComposerPickers";
import { Sidebar, folderName, groupByFolder, sessionTitle } from "./components/Sidebar";
import { SidebarToggle } from "./components/SidebarToggle";
import { SessionBar, SessionBarButton } from "./components/SessionBar";
import { TasksPanel } from "./components/TasksPanel";
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
  /**
   * 对话右边的面板：会话栏，或从它打开的后台任务面板（两个不同时开）。
   * 默认都不开，点按钮才开；切换会话（包括回到刚才那个）都收起
   */
  const [panel, setPanel] = useState<SidePanel | null>(null);
  useEffect(() => setPanel(null), [currentId]);
  const barOpen = panel === "bar";
  const barButton = currentId ? <SessionBarButton open={barOpen} onClick={() => setPanel(barOpen ? null : "bar")} /> : null;
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
        {!collapsed && (
          <>
            {config && (
              <Sidebar
                sessions={sessions}
                workspaceDir={config.workspaceDir}
                currentId={currentId}
                onSelect={select}
                onNew={startNew}
                onDelete={(ids) => void deleteSessions(ids)}
                // 桌面版的收起按钮在标题栏上
                onCollapse={desktop ? undefined : toggleSidebar}
              />
            )}
          </>
        )}
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
            headerEnd={barButton}
            panel={currentId ? panel : null}
            onPanel={setPanel}
            />
          )}
        </main>
      </div>
    </div>
  );
}

const COLLAPSED_KEY = "sidebarCollapsed";

/** 侧边栏和对话并排、不盖在对话上（同 codex-app-server 的电脑布局），收起 / 展开记住上次的选择 */
function initialCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

/** 对话右边的面板：会话栏、后台任务 */
type SidePanel = "bar" | "tasks";

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
  /** 对话上方右边的按钮（会话栏按钮） */
  headerEnd?: ReactNode;
  /** 对话右边开着的面板 */
  panel: SidePanel | null;
  onPanel: (panel: SidePanel | null) => void;
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
  headerEnd,
  panel,
  onPanel,
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

  // 先连事件流再拉历史，两边按 uuid 去重，见 docs/README.md「客户端归并规则」
  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = subscribe(sessionId, (event) => {
      dispatch({ type: "event", event });
      if (event.type === "state") onChanged();
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [view.items.length, view.streaming.text, view.permissions.length]);

  const send = async (text: string, attachments: string[]) => {
    try {
      if (sessionId) await api.send(sessionId, text, attachments);
      else onCreated(await api.createSession(text, attachments, { permissionMode: newMode, cwd: cwd ?? undefined, model: newModel, effort: newEffort }));
    } catch (e) {
      onError((e as Error).message);
      throw e;
    }
  };

  const permissionMode = sessionId ? (view.permissionMode ?? config.permissionMode) : newMode;
  const changeMode = (mode: string) => {
    if (!sessionId) setNewMode(mode as PermissionMode);
    else api.setPermissionMode(sessionId, mode as PermissionMode).catch((e: Error) => onError(e.message));
  };

  return (
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
          {headerEnd && <span className="chat-header-end">{headerEnd}</span>}
        </div>
      )}
      <div className="chat-row">
        <div className="chat-main">
          <div className="scroll">
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
          <Composer
            running={view.state === "running"}
            maxUploadMb={config.maxUploadMb}
            onSend={send}
            onInterrupt={() => sessionId && api.interrupt(sessionId).catch((e: Error) => onError(e.message))}
            left={<PermissionPicker value={permissionMode} onChange={changeMode} />}
            top={folderPicker}
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
        {panel === "bar" && sessionId && (
          <SessionBar sessionId={sessionId} tasks={view.backgroundTasks} onOpenTasks={() => onPanel("tasks")} onError={onError} />
        )}
        {panel === "tasks" && sessionId && (
          <TasksPanel sessionId={sessionId} tasks={view.backgroundTasks} onClose={() => onPanel(null)} onError={onError} />
        )}
      </div>
    </div>
  );
}
