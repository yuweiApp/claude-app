import { useEffect, useId, useRef, useState } from "react";
import { api, type BackgroundTask, type TaskOutput } from "../api";
import { useDismiss } from "./ComposerPickers";

interface Props {
  sessionId: string;
  tasks: BackgroundTask[];
  onError: (message: string) => void;
}

const POPOVER_WIDTH = 480;

/**
 * 会话标题后面的后台任务入口：按运行中 / 已结束分组的任务列表，点一行在下面展开命令和输出。
 */
export function TasksPopover({ sessionId, tasks, onError }: Props) {
  // 弹窗位置（视口坐标），null 是关着
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const detailsId = useId();
  useDismiss(ref, at !== null, () => setAt(null));

  const running = tasks.filter((t) => t.status === "running").sort((a, b) => b.startedAt - a.startedAt);
  const finished = tasks.filter((t) => t.status !== "running").sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const selectTask = (taskId: string) => setSelectedId((current) => current === taskId ? null : taskId);

  const place = () => {
    const rect = ref.current!.getBoundingClientRect();
    return { left: Math.max(12, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 12)), top: rect.bottom + 6 };
  };
  const toggle = () => {
    if (at) return setAt(null);
    setSelectedId(null);
    setAt(place());
  };

  useEffect(() => {
    if (!at) return;
    const reposition = () => setAt(place());
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [at !== null]);

  const list = (items: BackgroundTask[]) => (
    <ul className="tasks-list">
      {items.map((task) => (
        <TaskItem key={task.taskId} sessionId={sessionId} task={task} selected={task.taskId === selectedId} detailsId={detailsId} onSelect={selectTask} onError={onError} />
      ))}
    </ul>
  );

  return (
    <div className="tasks-anchor" ref={ref}>
      <button className={`icon-btn tasks-btn${at ? " active" : ""}${running.length > 0 ? " running" : ""}`} title="后台任务" aria-label="后台任务" aria-haspopup="dialog" aria-expanded={at !== null} onClick={toggle}>
        <ListTodoIcon />
        {running.length > 0 && <span className="tasks-badge">{running.length}</span>}
      </button>
      {at && (
        <div className="tasks-popover" role="dialog" aria-label="后台任务" style={{ ...at, width: POPOVER_WIDTH, maxHeight: Math.max(0, Math.min(720, window.innerHeight - at.top - 12)) }}>
          <div className="tasks-head">
            <h2>后台任务</h2>
            <button className="icon-btn tasks-close" title="关闭后台任务" aria-label="关闭后台任务" onClick={() => setAt(null)}><CloseIcon /></button>
          </div>
          <div className="tasks-body">
            {tasks.length === 0 && <div className="tasks-empty"><TerminalIcon /><span>暂无后台任务</span><small>后台执行的任务会显示在这里</small></div>}
            {running.length > 0 && (
              <section className="tasks-section" aria-label="运行中的任务">
                <div className="tasks-section-title">运行中<span className="tasks-count">{running.length}</span></div>
                {list(running)}
              </section>
            )}
            {finished.length > 0 && (
              <section className="tasks-section" aria-label="已结束的任务">
                <div className="tasks-section-title">
                  已结束<span className="tasks-count">{finished.length}</span>
                  <button className="tasks-clear" title="清除已结束的任务" onClick={() => api.clearTasks(sessionId).catch((e: Error) => onError(e.message))}>清除记录</button>
                </div>
                {list(finished)}
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskItem({ sessionId, task, selected, detailsId, onSelect, onError }: {
  sessionId: string;
  task: BackgroundTask;
  selected: boolean;
  detailsId: string;
  onSelect: (taskId: string) => void;
  onError: (message: string) => void;
}) {
  const running = task.status === "running";
  const now = useNow(running);
  const stop = () => api.stopTask(sessionId, task.taskId).catch((e: Error) => onError(`停止任务失败：${e.message}`));
  const id = `${detailsId}-details`;

  return (
    <li className={`task-item ${task.status}${selected ? " selected" : ""}`}>
      <div className="task-row">
        <button className="task-row-main" aria-expanded={selected} aria-controls={selected ? id : undefined} onClick={() => onSelect(task.taskId)} title={task.description}>
          <TaskStatusIcon status={task.status} />
          <span className="task-text">
            <span className="task-name">{task.description}</span>
            <span className="task-meta"><span className="task-meta-status">{taskStatus(task)}</span> · 用时 {formatDuration((task.endedAt ?? now) - task.startedAt)}</span>
          </span>
          <ChevronIcon />
        </button>
        {running && (
          <button className="task-stop" title="停止任务" aria-label={`停止任务：${task.description}`} onClick={stop}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
          </button>
        )}
      </div>
      {selected && <TaskDetails key={`${sessionId}:${task.taskId}`} id={id} sessionId={sessionId} task={task} onError={onError} />}
    </li>
  );
}

function TaskDetails({ id, sessionId, task, onError }: { id: string; sessionId: string; task: BackgroundTask; onError: (message: string) => void }) {
  const running = task.status === "running";
  const [output, setOutput] = useState<TaskOutput | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const outputRef = useRef<HTMLPreElement>(null);
  const followOutput = useRef(running);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  // 展开时拉输出；运行中的每 1.5 秒刷新，结束时再拉一次拿到完整输出
  useEffect(() => {
    if (!task.hasOutput) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await api.taskOutput(sessionId, task.taskId);
        if (!stopped) {
          setOutput(result);
          setOutputError(null);
        }
      } catch (e) {
        if (!stopped) setOutputError((e as Error).message);
      }
      if (!stopped && running) timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [running, task.hasOutput, sessionId, task.taskId, reload]);

  // 输出增长时停在最下面（用户往上翻了就不动）
  useEffect(() => {
    const el = outputRef.current;
    if (el && followOutput.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const agent = task.type === "local_agent";
  // 子代理的任务说明：开始消息里带的，没有就用对话记录里第一条
  const prompt = task.prompt ?? output?.prompt;
  const outputText = task.hasOutput ? output?.text : task.result ?? (task.summary !== task.description ? task.summary : undefined);
  const outputPlaceholder = outputError && !output ? "输出加载失败" : task.hasOutput && !output ? "正在加载输出…" : running ? "等待任务输出…" : "任务没有输出";

  return (
    <div className="task-details" id={id} ref={rootRef} role="region" aria-label={`任务详情：${task.description}`}>
      {task.command !== undefined && (
        <div className="task-block command">
          <div className="task-block-head"><span><TerminalIcon />执行命令</span><TaskCopyButton text={task.command} label="复制执行命令" onError={onError} /></div>
          <pre className="task-command">{task.command}</pre>
        </div>
      )}
      {task.code !== undefined && (
        <div className="task-block code">
          <div className="task-block-head"><span><CodeIcon />执行代码</span><TaskCopyButton text={task.code} label="复制执行代码" onError={onError} /></div>
          <pre className="task-command">{task.code}</pre>
        </div>
      )}
      {prompt !== undefined && (
        <div className="task-block command">
          <div className="task-block-head"><span><PromptIcon />任务说明</span><TaskCopyButton text={prompt} label="复制任务说明" onError={onError} /></div>
          <pre className="task-command">{prompt}</pre>
        </div>
      )}
      <div className="task-block output">
        <div className="task-block-head">
          <span><OutputIcon />{agent ? "执行过程" : "输出"}{running && <span className="task-output-live">实时</span>}</span>
          <TaskCopyButton text={outputText} label="复制输出" onError={onError} />
        </div>
        {output?.truncated && <div className="task-output-note">{agent ? "记录较长，仅显示最后一部分" : "仅显示最后 64 KB"}，复制内容为当前可见输出</div>}
        {outputError && <div className="task-output-note task-error">输出加载失败 <button onClick={() => setReload((n) => n + 1)} title={outputError}>重试</button></div>}
        <pre className={`task-output${!outputText ? " empty" : task.resultIsError ? " task-error" : ""}`} ref={outputRef} onScroll={() => {
          const el = outputRef.current;
          if (el) followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}>{outputText || outputPlaceholder}</pre>
        {!running && <div className="task-exit">{statusText(task)}</div>}
      </div>
    </div>
  );
}

function TaskCopyButton({ text, label, onError }: { text: string | undefined; label: string; onError: (message: string) => void }) {
  const [state, setState] = useState<"idle" | "copying" | "done" | "error">("idle");
  useEffect(() => {
    if (state !== "done" && state !== "error") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    if (!text) return;
    setState("copying");
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch (e) {
      setState("error");
      onError(`${label}失败：${(e as Error).message}`);
    }
  };
  return (
    <button className={`task-copy${state === "done" ? " copied" : ""}`} title={state === "done" ? "已复制" : label} aria-label={label} disabled={!text || state === "copying"} onClick={() => void copy()}>
      {state === "done" ? <CheckIcon /> : <CopyIcon />}
      <span role="status">{state === "done" ? "已复制" : state === "error" ? "失败" : "复制"}</span>
    </button>
  );
}

function taskStatus(task: BackgroundTask): string {
  return task.status === "running" ? "运行中" : task.status === "stopped" ? "已停止" : task.status === "failed" ? "失败" : "已完成";
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

/** 标题后面的按钮：任务列表（上浅蓝下紫的渐变），有任务在跑时待办项轻微呼吸 */
function ListTodoIcon() {
  const id = useId();
  const stroke = `url(#${CSS.escape(id)})`;
  return (
    <svg className="tasks-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="3" y1="3" x2="21" y2="21">
          <stop offset="0" style={{ stopColor: "var(--ic-tasks-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--ic-tasks-to)" }} />
        </linearGradient>
      </defs>
      <path d="m3 5 2 2 4-4M13 5h8M13 12h8M13 19h8" />
      <rect className="tasks-icon-pending" x="3" y="10" width="4" height="4" fill={stroke} fillOpacity="0.16" />
      <rect x="3" y="17" width="4" height="4" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10h3" />
    </svg>
  );
}

/** 行首的状态图标：运行中转圈，完成打勾，失败打叉，停止是方块 */
function TaskStatusIcon({ status }: { status: BackgroundTask["status"] }) {
  return (
    <svg className="task-status-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {status === "running" ? (
        <><circle cx="8" cy="8" r="6" opacity="0.25" /><path className="task-spin" d="M8 2a6 6 0 0 1 6 6" /></>
      ) : (
        <>
          <circle cx="8" cy="8" r="6.25" fill="currentColor" fillOpacity="0.12" stroke="none" />
          {status === "completed" ? <path d="m5.25 8.25 1.75 1.75 3.75-3.75" /> : status === "failed" ? <path d="m6 6 4 4m0-4-4 4" /> : <rect x="6" y="6" width="4" height="4" rx="0.75" fill="currentColor" stroke="none" />}
        </>
      )}
    </svg>
  );
}

function ChevronIcon() {
  return <svg className="task-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>;
}

function PromptIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" /></svg>;
}

function CodeIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 4-4 4 4 4m6-8 4 4-4 4M9 2 7 14" /></svg>;
}

function OutputIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="1.5" width="11" height="13" rx="2" /><path d="M5.5 5h5M5.5 8h5M5.5 11h3" /></svg>;
}

function CopyIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" /></svg>;
}

function CheckIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>;
}

function CloseIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>;
}
