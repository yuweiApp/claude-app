import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { api, subscribe, type GatewayConfig, type SessionSummary } from "./api";
import { Composer } from "./components/Composer";
import { Messages } from "./components/Messages";
import { PermissionCard } from "./components/PermissionCard";
import { Sidebar } from "./components/Sidebar";
import { emptyView, reduce } from "./state/session";

export function App() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <Sidebar sessions={sessions} currentId={currentId} onSelect={setCurrentId} />
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
            config={config}
            onCreated={(id) => {
              setCurrentId(id);
              refresh();
            }}
            onChanged={refresh}
            onError={setError}
          />
        )}
      </main>
    </div>
  );
}

interface ChatProps {
  sessionId: string | null;
  config: GatewayConfig;
  onCreated: (id: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

function Chat({ sessionId, config, onCreated, onChanged, onError }: ChatProps) {
  const [view, dispatch] = useReducer(reduce, undefined, emptyView);
  const [newMode, setNewMode] = useState<PermissionMode>(config.permissionMode);
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
      else onCreated(await api.createSession(text, attachments, newMode));
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
        <span>{view.model ?? config.model ?? "默认模型"}</span>
        <span className="muted">{config.workspaceDir}</span>
      </div>
      <div className="scroll">
        {!sessionId && <div className="empty">有什么可以帮你？</div>}
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
        permissionMode={permissionMode}
        maxUploadMb={config.maxUploadMb}
        onSend={send}
        onInterrupt={() => sessionId && api.interrupt(sessionId).catch((e: Error) => onError(e.message))}
        onPermissionMode={changeMode}
      />
    </div>
  );
}
