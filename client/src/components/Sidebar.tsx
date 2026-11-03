import type { SessionSummary } from "../api";

interface Props {
  sessions: SessionSummary[];
  currentId: string | null;
  onSelect: (id: string | null) => void;
}

export function Sidebar({ sessions, currentId, onSelect }: Props) {
  return (
    <aside className="sidebar">
      <button className="new-chat" onClick={() => onSelect(null)}>
        新会话
      </button>
      <ul>
        {sessions.map((s) => (
          <li key={s.sessionId}>
            <button className={s.sessionId === currentId ? "active" : ""} onClick={() => onSelect(s.sessionId)} title={s.title}>
              {s.state === "running" && <span className="dot" />}
              {s.title}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
