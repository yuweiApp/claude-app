import { useState } from "react";
import { api, type BackgroundTask } from "../api";
import { Caret, formatDuration, useNow } from "./TasksPanel";

interface Props {
  sessionId: string;
  tasks: BackgroundTask[];
  /** 打开「后台任务」面板（同时收起会话栏） */
  onOpenTasks: () => void;
  onError: (message: string) => void;
}

/**
 * 会话栏（参照 Claude 桌面版右上角的「会话栏」）：每个功能区一张卡片，现在只有「后台任务」。
 * 点卡片里的标题、任务或「N 个已结束」打开后台任务面板
 */
export function SessionBar({ sessionId, tasks, onOpenTasks, onError }: Props) {
  const [tasksOpen, setTasksOpen] = useState(true);
  const running = tasks.filter((t) => t.status === "running").sort((a, b) => b.startedAt - a.startedAt);
  const finished = tasks.length - running.length;

  return (
    <aside className="session-bar session-bar-cards" aria-label="会话栏">
      <div className="bar-body">
        <section className="bar-card">
          <div className="bar-card-head">
            <button className="bar-card-title" onClick={onOpenTasks}>
              后台任务
            </button>
            <button className="bar-card-caret" title={tasksOpen ? "收起" : "展开"} aria-expanded={tasksOpen} onClick={() => setTasksOpen((o) => !o)}>
              <Caret open={tasksOpen} />
            </button>
          </div>
          {tasksOpen && (
            <div className="bar-card-body">
              {running.map((task) => (
                <RunningTask key={task.taskId} sessionId={sessionId} task={task} onOpen={onOpenTasks} onError={onError} />
              ))}
              {finished > 0 && (
                <button className="bar-row bar-row-button" onClick={onOpenTasks}>
                  <DoneIcon />
                  <span className="bar-row-text">{finished} 个已结束</span>
                </button>
              )}
              {!tasks.length && <div className="bar-empty">暂无后台任务</div>}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function RunningTask({ sessionId, task, onOpen, onError }: { sessionId: string; task: BackgroundTask; onOpen: () => void; onError: (message: string) => void }) {
  const now = useNow(true);
  return (
    <div className="bar-row">
      <button className="bar-row-main" onClick={onOpen} title={task.description}>
        <TerminalIcon />
        <span className="bar-row-text">{task.description}</span>
      </button>
      <span className="bar-row-meta">{formatDuration(now - task.startedAt)}</span>
      <button
        className="task-stop"
        title="停止"
        aria-label="停止"
        onClick={() => api.stopTask(sessionId, task.taskId).catch((e: Error) => onError(`停止任务失败：${e.message}`))}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

/** 标题栏 / 对话上方显示、隐藏会话栏的按钮 */
export function SessionBarButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  const label = open ? "隐藏会话栏" : "显示会话栏";
  return (
    <button className={`icon-btn session-bar-btn${open ? " active" : ""}`} title={label} aria-label={label} aria-pressed={open} onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M5 6h.01M7.5 6H11M5 8h.01M7.5 8H11M5 10h.01M7.5 10H11" />
      </svg>
    </button>
  );
}

function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10h3" />
    </svg>
  );
}

function DoneIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 4 4 4-4 4M8 4l4 4-4 4" />
    </svg>
  );
}
