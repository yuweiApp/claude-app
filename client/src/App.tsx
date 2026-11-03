import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { EffortLevel, ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { api, subscribe, type GatewayConfig, type SessionListItem } from "./api";
import { Composer } from "./components/Composer";
import { Messages } from "./components/Messages";
import { PermissionCard } from "./components/PermissionCard";
import { FolderPicker } from "./components/FolderPicker";
import { ModelPicker, PermissionPicker, resolveModel } from "./components/ComposerPickers";
import { Sidebar, folderName, groupByFolder } from "./components/Sidebar";
import { SidebarToggle } from "./components/SidebarToggle";
import { emptyView, reduce } from "./state/session";

export function App() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  /** 新聊天页选的项目（工作目录），null 是默认工作目录 */
  const [newCwd, setNewCwd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggleSidebar = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, String(!c));
      } catch {
        // 无痕模式等写不了，只在这次打开里生效
      }
      return !c;
    });
  const select = (id: string | null) => setCurrentId(id);
  const startNew = (cwd?: string) => {
    setNewCwd(cwd ?? null);
    select(null);
  };
  const current = sessions.find((s) => s.sessionId === currentId);

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
              onCollapse={toggleSidebar}
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
              setCurrentId(id);
              refresh();
            }}
            onChanged={refresh}
            onError={setError}
            headerStart={collapsed && <SidebarToggle collapsed onToggle={toggleSidebar} />}
          />
        )}
      </main>
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

interface ChatProps {
  sessionId: string | null;
  config: GatewayConfig;
  onCreated: (id: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  /** 标题栏最左边的内容：侧边栏收起时是「展开侧边栏」按钮 */
  headerStart?: ReactNode;
  /** 工作目录（文件夹）；新会话页是选的文件夹，null 是无文件夹（默认工作目录） */
  cwd: string | null;
  /** 新会话页输入框工具栏里的选文件夹 */
  folderPicker?: ReactNode;
}

function Chat({ sessionId, cwd, config, onCreated, onChanged, onError, headerStart, folderPicker }: ChatProps) {
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
      <div className="chat-header">
        {headerStart}
        <span>{view.model ?? config.model ?? "默认模型"}</span>
        <span className="muted" title={cwd ?? config.workspaceDir}>
          {cwd && cwd !== config.workspaceDir ? folderName(cwd) : "无文件夹"}
        </span>
      </div>
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
  );
}
