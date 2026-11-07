import { useEffect, useRef, useState } from "react";
import { api, type BackgroundTask } from "../api";
import { useDismiss } from "./ComposerPickers";

interface Props {
  sessionId: string;
  tasks: BackgroundTask[];
  onError: (message: string) => void;
}

const POPOVER_WIDTH = 400;

/**
 * 会话标题后面的后台任务按钮，点开是弹窗（列表样式同 codex-app-server 的 SubAgentList）：
 * 「运行中 · N」「已完成 · N」两组，一行是任务说明和命令，右边是用时；点一行展开输出
 */
export function TasksPopover({ sessionId, tasks, onError }: Props) {
  // 弹窗位置（视口坐标），null 是关着
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, at !== null, () => setAt(null));

  const running = tasks.filter((t) => t.status === "running").sort((a, b) => b.startedAt - a.startedAt);
  const finished = tasks.filter((t) => t.status !== "running").sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));

  const toggle = () => {
    if (at) return setAt(null);
    const rect = ref.current!.getBoundingClientRect();
    setAt({ left: Math.max(12, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 12)), top: rect.bottom + 6 });
  };

  return (
    <div className="tasks-anchor" ref={ref}>
      <button className={`icon-btn tasks-btn${at ? " active" : ""}`} title="后台任务" aria-label="后台任务" aria-expanded={at !== null} onClick={toggle}>
        <TerminalIcon />
        {running.length > 0 && <span className="tasks-badge">{running.length}</span>}
      </button>
      {at && (
        <div className="tasks-popover" role="dialog" aria-label="后台任务" style={{ ...at, width: POPOVER_WIDTH }}>
          <section className="tasks-section">
            <div className="tasks-section-title">运行中 · {running.length}</div>
            {running.length === 0 && <div className="tasks-empty">没有运行中的任务</div>}
            {running.map((task) => (
              <TaskRow key={task.taskId} sessionId={sessionId} task={task} onError={onError} />
            ))}
          </section>
          {finished.length > 0 && (
            <section className="tasks-section">
              <div className="tasks-section-title">
                已完成 · {finished.length}
                <button className="tasks-clear" onClick={() => api.clearTasks(sessionId).catch((e: Error) => onError(e.message))}>
                  清除
                </button>
              </div>
              {finished.map((task) => (
                <TaskRow key={task.taskId} sessionId={sessionId} task={task} onError={onError} />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function TaskRow({ sessionId, task, onError }: { sessionId: string; task: BackgroundTask; onError: (message: string) => void }) {
  const running = task.status === "running";
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const now = useNow(running);
  const outputRef = useRef<HTMLPreElement>(null);

  // 展开时拉输出；运行中的每 1.5 秒刷新，结束时再拉一次拿到完整输出
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
  // 转到后台的 browser_run_code：说明和通知的 summary 都是工具名，第二行显示代码的第一行
  const preview = task.command ?? firstLine(task.code) ?? (task.summary !== task.description ? task.summary : undefined);

  return (
    <div className="task-item">
      <div className="task-row">
        <button className="task-main" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={task.description}>
          <TerminalIcon />
          <span className="task-text">
            <span className={`task-name${failed ? " failed" : ""}`}>{task.description}</span>
            {preview && <span className="task-preview">{preview}</span>}
          </span>
          <span className="task-time">{formatDuration((task.endedAt ?? now) - task.startedAt)}</span>
        </button>
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
          {task.code !== undefined && <span className="task-command">{`${task.code}\n\n`}</span>}
          {task.hasOutput ? (output ?? "") : task.result !== undefined ? (
            <span className={task.resultIsError ? "task-error" : undefined}>{task.result || "（没有输出）"}</span>
          ) : running ? "运行中…" : (task.summary && task.summary !== task.description ? task.summary : statusText(task))}
          {!running && task.hasOutput && output === "" && statusText(task)}
        </pre>
      )}
    </div>
  );
}

function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n").find((line) => line.trim())?.trim();
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

/** 对话里的用时（「用时 13s」「1m 05s」），同 codex-app-server 的 TurnView */
export function formatShortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** 当前时间，ticking 时每秒刷新 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10h3" />
    </svg>
  );
}
