import { useEffect, useRef, useState } from "react";
import { api, type BackgroundTask } from "../api";

interface Props {
  sessionId: string;
  tasks: BackgroundTask[];
  onClose: () => void;
  onError: (message: string) => void;
}

/**
 * 后台任务面板（参照 Claude 桌面版，从会话栏的「后台任务」卡片打开，会话栏同时收起）：
 * 运行中的在上面，计时、可以停止；已完成的折叠在下面。点开一个任务看命令和输出，运行中的每 1.5 秒刷新一次输出
 */
export function TasksPanel({ sessionId, tasks, onClose, onError }: Props) {
  const [wide, setWide] = useState(false);
  const [finishedOpen, setFinishedOpen] = useState(true);
  const running = tasks.filter((t) => t.status === "running").sort((a, b) => b.startedAt - a.startedAt);
  const finished = tasks.filter((t) => t.status !== "running").sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));

  return (
    <aside className={`session-bar${wide ? " wide" : ""}`} aria-label="后台任务">
      <div className="tasks-head">
        <span className="tasks-title">后台任务</span>
        <button
          className="icon-btn"
          title="清除已完成"
          aria-label="清除已完成"
          disabled={!finished.length}
          onClick={() => api.clearTasks(sessionId).catch((e: Error) => onError(e.message))}
        >
          <TrashIcon />
        </button>
        <button className="icon-btn" title={wide ? "缩小" : "放大"} aria-label={wide ? "缩小" : "放大"} onClick={() => setWide((w) => !w)}>
          <ExpandIcon wide={wide} />
        </button>
        <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="tasks-body">
        {!tasks.length && <div className="tasks-empty">这个会话还没有后台任务</div>}
        {running.length > 0 && (
          <section>
            <div className="tasks-section">运行中 {running.length}</div>
            {running.map((task) => (
              <TaskCard key={task.taskId} sessionId={sessionId} task={task} onError={onError} />
            ))}
          </section>
        )}
        {finished.length > 0 && (
          <section>
            <button className="tasks-section tasks-section-toggle" aria-expanded={finishedOpen} onClick={() => setFinishedOpen((o) => !o)}>
              <Caret open={finishedOpen} />
              已完成 {finished.length}
            </button>
            {finishedOpen && finished.map((task) => <TaskCard key={task.taskId} sessionId={sessionId} task={task} onError={onError} />)}
          </section>
        )}
      </div>
    </aside>
  );
}

function TaskCard({ sessionId, task, onError }: { sessionId: string; task: BackgroundTask; onError: (message: string) => void }) {
  const running = task.status === "running";
  // 运行中的默认展开，结束的默认收起
  const [open, setOpen] = useState(running);
  const [output, setOutput] = useState<string | null>(null);
  const now = useNow(running);
  const outputRef = useRef<HTMLPreElement>(null);

  // 展开时拉输出；运行中的定时刷新，结束时再拉一次拿到完整输出
  useEffect(() => {
    if (!open || !task.hasOutput) return;
    let stopped = false;
    const load = () =>
      api.taskOutput(sessionId, task.taskId).then(
        (r) => !stopped && setOutput(r.truncated ? `…（只显示最后一段）\n${r.text}` : r.text),
        () => undefined,
      );
    void load();
    if (!running) return () => void (stopped = true);
    const timer = setInterval(load, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, running, task.hasOutput, sessionId, task.taskId]);

  // 输出增长时停在最下面（用户往上翻了就不动）
  useEffect(() => {
    const el = outputRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 40) el.scrollTop = el.scrollHeight;
  }, [output]);

  const stop = () => api.stopTask(sessionId, task.taskId).catch((e: Error) => onError(`停止任务失败：${e.message}`));
  // 退出码不是 0 只写在输出最后（[exited with code N]），不标红；没有退出码的失败才标红
  const failed = task.status === "failed" && task.exitCode === undefined;

  return (
    <div className={`task-card${open ? " open" : ""}`}>
      <div className="task-row">
        <button className="task-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={task.description}>
          <Caret open={open} />
          <span className={`task-name${failed ? " failed" : ""}`}>{task.description}</span>
        </button>
        <span className="task-time">{formatDuration((task.endedAt ?? now) - task.startedAt)}</span>
        {running && (
          <button className="task-stop" title="停止" aria-label="停止" onClick={stop}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <pre className="task-output" ref={outputRef}>
          {task.command && <span className="task-command">{`$ ${task.command}\n`}</span>}
          {task.hasOutput ? (output ?? "") : (task.summary ?? (running ? "运行中…" : statusText(task)))}
          {!running && task.hasOutput && output === "" && statusText(task)}
        </pre>
      )}
    </div>
  );
}

function statusText(task: BackgroundTask): string {
  if (task.status === "stopped") return "[已停止]";
  if (task.status === "failed") return "[失败]";
  return task.exitCode !== undefined ? `[exited with code ${task.exitCode}]` : "[已完成]";
}

/** 49秒、1分钟 08秒、1小时 02分钟（同 Claude 桌面版） */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}秒`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}分钟 ${pad(s % 60)}秒`;
  return `${Math.floor(s / 3600)}小时 ${pad(Math.floor((s % 3600) / 60))}分钟`;
}

/** 当前时间，ticking 时每秒刷新 */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

export function Caret({ open }: { open: boolean }) {
  return (
    <svg className={`caret${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3 1.5 7.5 5 3 8.5z" fill="currentColor" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4M6.8 6.5v5M9.2 6.5v5" />
    </svg>
  );
}

function ExpandIcon({ wide }: { wide: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {wide ? <path d="M13.5 2.5 9.5 6.5M9.5 3v3.5H13M2.5 13.5l4-4M3 9.5h3.5V13" /> : <path d="M9.5 6.5l4-4M10 2.5h3.5V6M6.5 9.5l-4 4M2.5 10v3.5H6" />}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M3 3l8 8M11 3l-8 8" />
    </svg>
  );
}
