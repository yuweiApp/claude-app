import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { isGoalStart, SHOW_WIDGET_TOOL, type AgentItem, type ApiRetry, type GoalItem, type Item, type SessionView, type TaskItem } from "../state/session";
import { Attachments } from "./Attachments";
import { GoalIcon } from "./Goal";
import { ImageThumb } from "./ImageThumb";
import { CopyAction, ForkAction, MessageActions, MessageTime } from "./MessageActions";
import { desktopCommandLine, SparkIcon, StepGroup, stepImages, ToolIcon, ToolStep, type ToolUse } from "./Steps";
import { Widget, WidgetPending } from "./Widget";
import { McpAppView, parsePartialInput } from "./McpAppView";
import type { McpAppTool, McpAppTools } from "@gateway/shared/types";
import { StepThumbs } from "./StepThumbs";
import { formatShortDuration } from "./TasksPopover";
import { MentionText, splitImageRefs } from "./MentionText";
import { AnnotatableText, SentNotesChip } from "./ResponseAnnotations";
import { FileLinkContext, ReplyMarkdown } from "./ReplyMarkdown";
import { sessionPathUri } from "../remote";
import { useSshConnections } from "../state/sshConnections";
import { ANNOTATION_TARGET_ATTR } from "../state/responseAnnotations";
import { findMatches, flash, showHighlight } from "../searchHighlight";

type UserItem = Extract<Item, { kind: "user" }>;
type ResultItem = Extract<Item, { kind: "result" }>;
type CompactItem = Extract<Item, { kind: "compact" }>;

/**
 * 一轮：用户消息（或自动开始这一轮的后台任务通知）开头，到 result（这一轮结束）为止。
 * 这一轮进行中用户又发的消息，SDK 在下一次工具调用之后把它并进这一轮（只有一个 result，指向开头那条）。
 * 显示上按时间顺序在它那里分段：每段一个 Turn，后面的段 continued，result 挂在最后一段，前面的段用时算到下一段开始。
 * 压缩上下文的地方也这样分段，分界线显示在两段之间，不随过程折叠
 */
interface Turn {
  key: string;
  user: UserItem | null;
  task: TaskItem | null;
  /** 其他 agent 发来的消息开始的一轮 */
  agent: AgentItem | null;
  /** 这一段从压缩上下文开始 */
  compact: CompactItem | null;
  /** 设定或取消目标开始的一轮 */
  goal: GoalItem | null;
  body: Item[];
  result: ResultItem | null;
  /** 接着上一段（这条用户消息是进行中插入的） */
  continued: boolean;
  /** 下一段（插入的消息）开始的时间，这一段的用时算到这里 */
  nextAt?: number;
}

function splitTurns(items: Item[], turnStartUuids: string[]): Turn[] {
  const turns: Turn[] = [];
  const results: ResultItem[] = [];
  // result 的 user_message_uuid 指向的用户消息开始了自己的一轮，不是插进上一轮的：有工具在跑时发的消息（now），
  // Claude Code 有时先结束这一轮（result 的 stop_reason 是 tool_use）再用它开新的一轮。历史里它也紧跟在工具结果后面，光看位置分不出来。
  // 新的一轮还没结束（没有自己的 result）时，靠网关的 turn_start（上一轮的 result 之后才交给模型的消息）
  const turnStarts = new Set([...turnStartUuids, ...items.flatMap((item) => (item.kind === "result" && item.userMessageUuid ? [item.userMessageUuid] : []))]);
  // 这一轮是不是停在工具调用上（还没结束）：此时来的用户消息是中途插入的。
  // 历史记录里插入的消息排在它被读到的那个工具结果后面，实时发的也是在工具执行时发出，两边都是跟在以工具调用结尾的 assistant 消息后面
  let midTool = false;
  for (const item of items) {
    if (item.kind === "result") {
      results.push(item);
      midTool = false;
    } else if (item.kind === "user" || item.kind === "task" || item.kind === "agent" || item.kind === "compact" || isGoalStart(item) || !turns.length) {
      // 一轮中间的自动压缩接着上一段；空闲时手动压缩的自成一轮
      const continued = ((item.kind === "user" || item.kind === "agent") && midTool && !turnStarts.has(item.uuid)) || (item.kind === "compact" && !item.manual && turns.length > 0);
      if (continued) turns.at(-1)!.nextAt = item.at;
      turns.push({
        key: item.uuid,
        user: item.kind === "user" ? item : null,
        task: item.kind === "task" ? item : null,
        agent: item.kind === "agent" ? item : null,
        compact: item.kind === "compact" ? item : null,
        goal: isGoalStart(item) ? item : null,
        body: item.kind === "user" || item.kind === "task" || item.kind === "agent" || item.kind === "compact" || isGoalStart(item) ? [] : [item],
        result: null,
        continued,
      });
      midTool = false;
    } else {
      turns.at(-1)!.body.push(item);
      if (item.kind === "assistant") {
        if (item.blocks.length) midTool = item.blocks.at(-1)!.type === "tool_use";
      } else if (item.kind === "interrupted" || item.kind === "error") midTool = false;
    }
  }
  // 一轮插入过消息的，result 挂到它的最后一段
  const lastSegment = (i: number) => {
    while (turns[i + 1]?.continued) i++;
    return i;
  };
  // 历史消息（getSessionMessages）里没有 result，事件流回放的 result 排在最后：按 SDK 的 user_message_uuid 挂回所属的那一轮。
  // 后台任务开始的轮没有 user_message_uuid，按 result 到达时最近的那条用户消息或任务通知（startUuid）找。
  // 都找不到（事件缓冲从某一轮中间开始）：从后往前，挂到前面最近一个还没有 result 的轮，不超过 result 之后开始的那一轮（beforeUuid）
  const startOf = (uuid: string | undefined) => (uuid ? turns.findIndex((t) => (t.user ?? t.task ?? t.agent ?? (t.compact?.manual ? t.compact : null) ?? t.goal)?.uuid === uuid) : -1);
  let limit = turns.length;
  for (const r of results.toReversed()) {
    let i = startOf(r.userMessageUuid);
    if (i < 0) i = startOf(r.startUuid);
    if (i >= 0) i = lastSegment(i);
    if (i < 0) {
      const before = startOf(r.beforeUuid);
      const bound = before >= 0 ? Math.min(limit, before) : limit;
      i = turns.findLastIndex((t, j) => j < bound && !t.result && !turns[j + 1]?.continued);
    }
    if (i < 0) continue;
    turns[i]!.result = r;
    limit = i;
  }
  return turns;
}

/**
 * 这一轮的用时：有 result 用它的；插入过消息的最后一段和历史里没有 result 的（网关重启过、这一轮没跑完），
 * 按这一段开头那条消息到下一段开始、result 到达或最后一条消息的时间算。
 * result 的用时不会比这一轮开头到最后一条回复还短：比这还短的（Claude Code 自己造的 duration_ms 为 0 的 result、
 * 挂错了轮的 result）按消息的时间算
 */
function turnDuration(turn: Turn): number | null {
  const start = (turn.user ?? turn.task ?? turn.agent ?? turn.compact ?? turn.goal)?.at;
  const lastReply = turn.body.findLast((item) => item.kind === "assistant")?.at;
  // 插入过消息的一轮，result 的用时是整轮的，最后一段只算它自己那部分
  if (turn.result && !turn.continued) {
    const span = start && lastReply && lastReply > start ? lastReply - start : 0;
    return Math.max(turn.result.durationMs, span);
  }
  const end = turn.nextAt ?? turn.result?.at ?? lastReply;
  return start && end && end > start ? end - start : null;
}

/** 通知 summary 里的退出码（… failed with exit code 124） */
const taskExitCode = (task: TaskItem) => /exit code (-?\d+)/.exec(task.text)?.[1];

/**
 * 通知里的 summary 形如 Background command "…" completed (exit code 0)，显示引号里的任务说明。
 * 退出码不是 0 时 Claude Code 记成 failed，但命令可能只是被 timeout 结束了（124），所以不写「失败」，只写退出码；
 * 没有退出码的失败（任务本身出错）才写「失败」
 */
function taskLabel(task: TaskItem): string {
  const exit = task.status === "failed" ? taskExitCode(task) : undefined;
  const status = exit
    ? "后台任务已结束"
    : task.status === "completed" ? "后台任务已完成" : task.status === "failed" ? "后台任务失败" : task.status === "stopped" ? "后台任务已停止" : "后台任务结束";
  // Bash：Background command "…" completed；MCP 工具（历史里）：MCP task <id> (inapp/browser_run_code) failed.，实时的只有工具名
  const name = /"(.+)"/.exec(task.text)?.[1] ?? /^MCP task \S+ \((.+)\)/.exec(task.text)?.[1] ?? task.text;
  const label = name ? `${status}：${shortLine(name)}` : status;
  return exit ? `${label}（退出码 ${exit}）` : label;
}

/** 报错的开头：TimeoutError: …、TypeError: …、Error: … */
const ERROR_START = /\b[A-Z]\w*(?:Error|Exception): /;

/**
 * 失败的后台任务的原因，太长截断；全文在悬停提示里。
 * 结果原文里代码的 console 输出在前、抛出的报错在后（历史里的通知还会把换行压成空格），
 * 所以从后往前找带报错开头的那一行，从报错开头取；找不到（比如被中止的说明）就用第一行
 */
function taskReason(task: TaskItem): string | undefined {
  if (task.status !== "failed" || !task.detail) return undefined;
  const lines = task.detail.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.findLast((l) => ERROR_START.test(l));
  const line = errorLine ? errorLine.slice(ERROR_START.exec(errorLine)!.index) : lines[0];
  return line && (line.length > 200 ? `${line.slice(0, 200)}…` : line);
}

/** 标签里的说明只取第一行，太长截断 */
function shortLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * 后台任务的一行。失败也用灰色、不标红：模型接下来的回复里通常已经说明了原因，红色太扎眼。
 * 子代理的最终回复（result）默认折叠，点开在下面显示；没认出是子代理、summary 又是多行长文的，也按回复折叠
 */
function TaskLine({ task }: { task: TaskItem }) {
  const [open, setOpen] = useState(false);
  const reason = taskReason(task);
  const result = task.result ?? (task.text.includes("\n") || task.text.length > 120 ? task.text : undefined);
  if (!result) {
    return (
      <div className="task-line" title={task.detail ?? task.text}>
        {taskLabel(task)}
        {reason && <div className="task-reason">{reason}</div>}
      </div>
    );
  }
  return (
    <div className="task-entry">
      <button className="task-line task-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {taskLabel(task)}
        <span className="step-caret">{open ? "▾" : "›"}</span>
      </button>
      {reason && <div className="task-line task-reason">{reason}</div>}
      {open && (
        <div className="msg-group">
          <div className="agent-message">
            <ReplyMarkdown>{result}</ReplyMarkdown>
          </div>
          <MessageActions align="start">
            <CopyAction text={result} title="复制回复" />
          </MessageActions>
        </div>
      )}
    </div>
  );
}

/**
 * 发消息的子代理的说明（Agent 调用的 description）：按 from 找 Agent 调用，
 * 子代理的 from 是 agentId（Agent 工具的结果里有「agentId: …」），队友的是调用时给的 name
 */
function agentName(view: SessionView, from: string): string | undefined {
  if (!from) return undefined;
  const items = [view.items, ...Object.values(view.children)].flat();
  for (const item of items) {
    if (item.kind !== "assistant") continue;
    for (const b of item.blocks) {
      if (b.type !== "tool_use" || (b.name !== "Agent" && b.name !== "Task")) continue;
      const input = (b.input ?? {}) as { name?: unknown; description?: unknown };
      const result = view.toolResults[b.id]?.text ?? "";
      if (input.name === from || result.includes(`agentId: ${from}`)) {
        return typeof input.description === "string" && input.description ? input.description : typeof input.name === "string" ? input.name : undefined;
      }
    }
  }
  return undefined;
}

/**
 * 其他 agent 发来的消息：不是用户写的，不用用户消息的气泡，显示成带来源的引用块；给模型看的说明不显示。
 * 这些消息是写给模型的，往往很长，默认折叠成标题加一行摘要，点标题展开；只有一行的短消息直接显示
 */
function AgentMessage({ item, name }: { item: AgentItem; name?: string }) {
  const [open, setOpen] = useState(false);
  const head = name ? `子代理「${name}」发来消息` : "子代理发来消息";
  const text = item.text.trim();
  const short = !text.includes("\n") && text.length <= 80;
  return (
    <div className="agent-message" title={item.from ? `来自 ${item.from}` : undefined}>
      {short ? (
        <div className="agent-message-head">{head}</div>
      ) : (
        <button className="agent-message-head task-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {head}
          <span className="step-caret">{open ? "▾" : "›"}</span>
        </button>
      )}
      {text && (short || open ? <ReplyMarkdown>{text}</ReplyMarkdown> : <div className="agent-message-preview">{shortLine(text)}</div>)}
    </div>
  );
}

/** 打开会话时只渲染最后这么多轮，往上滚到接近顶部时每次再往前补这么多 */
const PAGE_TURNS = 20;

/** 最近的能竖着滚动的祖先（对话区） */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/**
 * 前面还有没渲染的轮时放在最上面：离对话区顶部不到一屏时调用 onReach。
 * count 变了（补过一批）重新开始观察，补完还在范围里（内容不满一屏）会接着补
 */
function EarlierTurns({ count, onReach }: { count: number; onReach: (scroller: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const reach = useRef(onReach);
  reach.current = onReach;
  useEffect(() => {
    const el = ref.current;
    const scroller = el && scrollParent(el);
    if (!el || !scroller) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && reach.current(scroller), {
      root: scroller,
      rootMargin: `${scroller.clientHeight}px 0px 0px 0px`,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [count]);
  return <div ref={ref} className="earlier-turns" aria-hidden />;
}

/** 要定位到的消息（侧边栏项目的「查找…」点了某条结果）：uuid 是会话记录里那条消息的，query 是查找的文字，seq 每次点都不同 */
export interface MessageFocus {
  uuid: string;
  query: string;
  seq: number;
}

/** 查找结果定位后，匹配的文字标出来多久 */
const SEARCH_HIGHLIGHT_MS = 8000;

/** 这一轮里有没有这条消息（开头的用户消息或过程、回复里的） */
const turnHas = (turn: Turn, uuid: string) => turn.user?.uuid === uuid || turn.body.some((item) => item.uuid === uuid);

/**
 * onFork：从某条消息（会话记录里的 uuid）分叉出新会话；不传不显示分叉按钮（新会话页）。
 * focus：滚动到这条消息并标出匹配的文字（那一轮没渲染的先补上、过程折叠着的展开、用户消息折叠着的展开）；
 * 滚动前调用 onReveal(true)，找不到这条消息时 onReveal(false)
 */
export function Messages({
  view,
  onFork,
  focus,
  onReveal,
}: {
  view: SessionView;
  onFork?: (messageId: string) => Promise<void>;
  focus?: MessageFocus | null;
  onReveal?: (found: boolean) => void;
}) {
  const turns = splitTurns(view.items, view.turnStartUuids);
  // 长会话打开时只渲染最后几轮，前面的往上滚时再补：Markdown、工具步骤都要渲染，一次全挂上要卡好一阵。
  // 记的是前面没渲染的轮数，之后新来的轮接在后面，不影响它
  const [hidden, setHidden] = useState(() => Math.max(0, turns.length - PAGE_TURNS));
  const start = Math.min(hidden, turns.length);
  // 往前补的时候保持看到的内容不动：记下补之前离底部的距离，渲染后按它设回 scrollTop
  const restore = useRef<{ scroller: HTMLElement; fromBottom: number } | null>(null);
  const showEarlier = (scroller: HTMLElement) => {
    if (restore.current) return;
    restore.current = { scroller, fromBottom: scroller.scrollHeight - scroller.scrollTop };
    setHidden(Math.max(0, start - PAGE_TURNS));
  };
  useLayoutEffect(() => {
    const r = restore.current;
    if (!r) return;
    restore.current = null;
    r.scroller.scrollTop = r.scroller.scrollHeight - r.fromBottom;
  }, [start]);
  // 定位到查找结果：所在的轮还没渲染的，从它开始渲染
  const rootRef = useRef<HTMLDivElement>(null);
  const focusTurn = focus ? turns.findIndex((turn) => turnHas(turn, focus.uuid)) : -1;
  useLayoutEffect(() => {
    if (focusTurn >= 0 && focusTurn < start) setHidden(focusTurn);
  }, [focus?.seq]);
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  const clearHighlight = useRef<() => void>(() => {});
  useEffect(() => () => clearHighlight.current(), []);
  // 等这条消息渲染出来（补轮、展开过程要再渲染一两次），滚到第一处匹配（找不到匹配的文字就滚到消息）放在中间，标出匹配的文字
  useEffect(() => {
    if (!focus) return;
    const { uuid, query } = focus;
    let frame = 0;
    let found = 0;
    let raf = 0;
    const tick = () => {
      const root = rootRef.current;
      const sel = CSS.escape(uuid);
      const targets = root ? [...root.querySelectorAll<HTMLElement>(`[data-msg-uuid="${sel}"], [${ANNOTATION_TARGET_ATTR}^="${sel}:"]`)] : [];
      // 找到后再等两帧：折叠着的用户消息、过程展开后位置才对
      if (targets.length && ++found > 2) {
        const ranges = findMatches(targets, query);
        clearHighlight.current();
        const clear = showHighlight(ranges);
        const timer = setTimeout(clear, SEARCH_HIGHLIGHT_MS);
        clearHighlight.current = () => {
          clearTimeout(timer);
          clear();
        };
        revealRef.current?.(true);
        const box = targets[0]!.closest<HTMLElement>(".msg-group, .assistant") ?? targets[0]!;
        const scroller = scrollParent(box);
        const rect = (ranges[0] ?? box).getBoundingClientRect();
        if (scroller) {
          const area = scroller.getBoundingClientRect();
          scroller.scrollTop += rect.top + rect.height / 2 - (area.top + scroller.clientHeight / 2);
        } else box.scrollIntoView({ block: "center" });
        flash(box);
        return;
      }
      if (++frame > 90) {
        revealRef.current?.(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [focus?.seq]);
  // 只有 running 算进行中：续接的会话在第一条消息之前一直是 starting（子进程等输入，init 要等发消息才来）
  const busy = view.state === "running";
  return (
    <div className="messages" ref={rootRef}>
      {start > 0 && <EarlierTurns count={start} onReach={showEarlier} />}
      {turns.slice(start).map((turn, i) => (
        <TurnView
          key={turn.key}
          turn={turn}
          view={view}
          live={busy && start + i === turns.length - 1 && !turn.result}
          onFork={onFork}
          reveal={focus && start + i === focusTurn ? focus : undefined}
        />
      ))}
      {/* 这一轮进行中发的、还没交给模型的消息：和普通消息一样显示，保持在最后，交给模型时才固定位置（见 SessionView.queued）；以 next 排队的列在输入框上面 */}
      {view.queued.map(
        (q) =>
          q.preview &&
          !q.next && (
            <section key={q.uuid} className="turn">
              <UserGroup item={q.preview} />
            </section>
          ),
      )}
      {/* 换了模型还没发消息：先临时显示，新模型回复后由那条消息补出正式的一行 */}
      {!busy && view.model && view.shownModel && view.model !== view.shownModel && <ModelLine from={view.shownModel} to={view.model} />}
      {view.state === "idle" && <BackgroundWorking tasks={view.backgroundTasks} noticePending={view.noticePending} />}
    </div>
  );
}

/**
 * 这一轮已经结束、还有后台任务（子代理、后台命令等）在跑：任务结束时的通知会唤起新的一轮，
 * 中间这段对话里没有别的动静，在最后显示一行运行中的任务，图标和「思考中…」一样呼吸。
 * 任务都结束了、通知还没交给模型（noticePending）时也显示一行，Claude Code 马上会拿通知开始新的一轮
 */
function BackgroundWorking({ tasks, noticePending }: { tasks: SessionView["backgroundTasks"]; noticePending: boolean }) {
  const running = tasks.filter((t) => t.status === "running");
  if (!running.length) {
    if (!noticePending) return null;
    return (
      <div className="working background-working">
        <ToolIcon icon={<SparkIcon />} running />
        <span className="working-label">后台任务已结束，结果正在交给模型</span>
      </div>
    );
  }
  const first = running[0]!;
  const label =
    running.length > 1
      ? `${running.length} 个后台任务运行中`
      : first.type === "local_agent"
        ? `子代理在后台运行：${shortLine(first.description)}`
        : `后台任务运行中：${shortLine(first.description)}`;
  const since = Math.min(...running.map((t) => t.startedAt));
  return (
    <div className="working background-working" title={running.map((t) => t.description).join("\n")}>
      <ToolIcon icon={<SparkIcon />} running />
      <span className="working-label">{label}</span>
      <span className="step-time">
        <Elapsed since={since} />
      </span>
    </div>
  );
}

const RETRY_ERRORS: Record<string, string> = {
  server_error: "服务器错误",
  overloaded: "服务过载",
  rate_limit: "请求太频繁",
  authentication_failed: "认证失败",
  billing_error: "计费错误",
  invalid_request: "请求无效",
  model_not_found: "找不到模型",
  unknown: "未知错误",
};

/**
 * 模型请求出错、Claude Code 正在重试（SessionView.retry）：代替「思考中…」，写明第几次重试、什么错误，
 * 计时是这次重试已经等了多久（每次重试换一个 key，Elapsed 从头算）
 */
function RetryLine({ retry }: { retry: ApiRetry }) {
  const cause =
    retry.waitedMs !== undefined
      ? `${Math.round(retry.waitedMs / 1000)} 秒没有响应`
      : [retry.status, RETRY_ERRORS[retry.error] ?? retry.error].filter((part) => part !== null && part !== "").join(" ");
  return (
    <div className="working" title={`api_retry：attempt ${retry.attempt}/${retry.maxRetries}，error_status ${retry.status ?? "无"}，error ${retry.error}`}>
      <ToolIcon icon={<SparkIcon />} running />
      <span className="working-label">
        模型接口出错（{cause}），第 {retry.attempt} 次重试（最多 {retry.maxRetries} 次）
      </span>
      <span className="step-time">
        <Elapsed since={retry.at} />
      </span>
    </div>
  );
}

/**
 * 进行中的计时，每秒刷新；从这一段开头那条消息的时间算起（重新打开会话、切回来时接着算），没有时间的从开始显示时算起。
 * 历史里的时间是网关那边的钟，和本机差得多的（晚于现在）也从开始显示时算
 */
function Elapsed({ since }: { since?: number }) {
  const [mounted] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const start = since !== undefined && since <= mounted ? since : mounted;
  return <>{formatShortDuration(now - start)}</>;
}

/**
 * 一轮的显示，参照 codex-app-server 的 TurnView（client/src/components/TurnView.tsx）：
 * 用户消息 → 中间过程（工具调用、中间说明）折叠在「用时 Xs」下面 → 最终回复。模型的思考不显示。
 * 进行中显示「已处理 Xs」并默认展开；结束后默认收起
 */
function TurnView({
  turn,
  view,
  live,
  onFork,
  reveal,
}: {
  turn: Turn;
  view: SessionView;
  live: boolean;
  onFork?: (messageId: string) => Promise<void>;
  /** 要定位到这一轮里的这条消息：在折叠的过程里时展开 */
  reveal?: MessageFocus;
}) {
  const [open, setOpen] = useState(false);
  const [liveCollapsed, setLiveCollapsed] = useState(false);
  const units = toUnits(turn.body, view.mcpApps);
  // 结束后最后一段文字是最终回复，不折叠；进行中全部算过程。历史里读回来的轮没有 result，不在进行中就算结束了
  // 本地命令的灰字、网关报错（kind: "item"）不算，跳过它们找最后一段
  const lastIdx = units.findLastIndex((u) => u.kind !== "item");
  const finalIdx = !live && units[lastIdx]?.kind === "text" ? lastIdx : -1;
  const final = finalIdx >= 0 ? units[finalIdx]! : null;
  // 网关报的错、目标达成这些不折叠；目标检查没通过的那几行算过程
  // 部件（show_widget）不折叠，按顺序显示在过程下面；调用出错的（参数是空的、被中断）还是过程里的一步
  // MCP Apps 的界面出错时照样显示（界面收到 tool-cancelled，出错原因写在界面下面）
  const shownWidget = (u: Unit) => u.kind === "widget" && (!!u.app || !view.toolResults[u.block.id]?.isError);
  const inProcess = (u: Unit) => !shownWidget(u) && (u.kind !== "item" || (u.item.kind === "goal" && u.item.event === "check"));
  const errors = units.filter((u) => u.kind === "item" && !inProcess(u));
  const widgets = units.filter(shownWidget);
  const process = units.filter((u, i) => i !== finalIdx && inProcess(u));
  const revealInProcess = !!reveal && process.some((u) => u.kind === "text" && u.uuid === reveal.uuid);
  useLayoutEffect(() => {
    if (!revealInProcess) return;
    setOpen(true);
    setLiveCollapsed(false);
  }, [reveal?.seq]);
  const streaming = live && view.streaming.text;
  // 正在生成参数的部件调用：参数完整、出现在消息里之前，在部件的位置显示 loading 提示
  const pendingWidget = live && view.streaming.widget && !widgets.some((u) => u.kind === "widget" && u.block.id === view.streaming.widget!.id) ? view.streaming.widget : null;
  // 正在生成参数的 MCP Apps 调用：界面先显示、收部分参数。key 和参数完整后的单元一样（app:工具调用 id），React 沿用同一个界面，不重新加载
  const streamingApp = live ? view.streaming.app : undefined;
  const pendingApp: Unit | null =
    streamingApp && view.mcpApps?.[streamingApp.name] && !widgets.some((u) => u.kind === "widget" && u.block.id === streamingApp.id)
      ? {
          kind: "widget",
          key: `app:${streamingApp.id}`,
          block: { type: "tool_use", id: streamingApp.id, name: streamingApp.name, input: parsePartialInput(streamingApp.json) },
          app: view.mcpApps[streamingApp.name],
          partial: true,
        }
      : null;
  const shownUnits = pendingApp ? [...widgets, pendingApp] : widgets;
  const hasProcess = process.length > 0;
  const duration = live ? null : turnDuration(turn);
  const expanded = live ? !liveCollapsed : open;
  // 工具正在执行时它的图标在转，不再另外显示「思考中…」
  const toolRunning = units.some((u) => u.kind === "steps" && u.tools.some((t) => !view.toolResults[t.id]));
  // 正在压缩、压缩后还没有新的步骤：只显示压缩的动画，不显示「已处理」和「思考中…」
  const compacting = turn.compact?.status === "running" && !hasProcess;
  // 空闲时手动压缩的一轮只有分界线、取消目标的一轮只有那一行：不显示「用时」
  const bareCompact = (Boolean(turn.compact?.manual) || turn.goal?.event === "cleared") && turn.body.length === 0;

  return (
    <section className="turn">
      {turn.task && <TaskLine task={turn.task} />}
      {turn.agent && (
        <div className="msg-group">
          <AgentMessage item={turn.agent} name={agentName(view, turn.agent.from)} />
          {turn.agent.text && (
            <MessageActions align="start">
              <CopyAction text={turn.agent.text} title="复制消息" />
            </MessageActions>
          )}
        </div>
      )}
      {turn.compact && <CompactLine item={turn.compact} />}
      {turn.goal && <GoalLine item={turn.goal} />}
      {turn.user && <UserGroup item={turn.user} reveal={reveal?.uuid === turn.user.uuid ? reveal.seq : undefined} />}
      {(hasProcess || live || duration !== null) && !compacting && !bareCompact && (
        <div className="process-wrap">
          <div className="process-toggle-row">
            <button
              className="process-toggle"
              onClick={() => (live ? setLiveCollapsed((c) => !c) : setOpen((o) => !o))}
              disabled={!hasProcess}
            >
              {live ? (
                <>
                  已处理 <Elapsed since={(turn.user ?? turn.task ?? turn.agent ?? turn.compact ?? turn.goal)?.at} />
                </>
              ) : duration !== null ? (
                `用时 ${formatShortDuration(duration)}`
              ) : (
                "处理过程"
              )}
              {hasProcess && <span className="step-caret">{expanded ? "▾" : "›"}</span>}
            </button>
            {/* 折叠时过程里各步返回的图片排在右边，展开后看各步行末的 */}
            {hasProcess && !expanded && <StepThumbs images={processImages(process, view)} />}
          </div>
          {hasProcess && expanded && (
            <div className="process">
              {process.map((u) => (
                <UnitView key={u.key} unit={u} view={view} />
              ))}
            </div>
          )}
          {live &&
            !streaming &&
            !pendingWidget &&
            !pendingApp &&
            !(expanded && toolRunning) &&
            (view.retry ? (
              <RetryLine key={view.retry.at} retry={view.retry} />
            ) : (
              <div className="working">
                <ToolIcon icon={<SparkIcon />} running />
                <span className="working-label">思考中…</span>
              </div>
            ))}
        </div>
      )}
      {shownUnits.map((u) => (
        <UnitView key={u.kind === "widget" && u.app ? `app:${u.block.id}` : u.key} unit={u} view={view} />
      ))}
      {pendingWidget && <WidgetPending json={pendingWidget.json} />}
      {final && (
        <div className="msg-group">
          <UnitView unit={final} view={view} />
          {final.kind === "text" && (
            <MessageActions align="start">
              <CopyAction text={final.text} title="复制回复" />
              {onFork && <ForkAction onFork={() => onFork(final.uuid)} />}
              {final.at !== undefined && <MessageTime at={final.at} />}
            </MessageActions>
          )}
        </div>
      )}
      {live && view.streaming.text && (
        <div className="assistant streaming">
          <ReplyMarkdown>{view.streaming.text}</ReplyMarkdown>
        </div>
      )}
      {errors.map((u) => (
        <UnitView key={u.key} unit={u} view={view} />
      ))}
      {/* 接口报错（余额不足、超出上下文等）时 result 是 success 加 is_error，没有文字，报错原文在前面那条 assistant 消息里 */}
      {turn.result?.isError && turn.result.text && <div className="result error">出错：{turn.result.text}</div>}
    </section>
  );
}

/** 过程里各步工具调用返回的图片（不含子代理里的） */
function processImages(units: Unit[], view: SessionView) {
  return units.flatMap((u) => (u.kind === "steps" ? u.tools.flatMap((t) => stepImages(t, view.toolResults[t.id])) : []));
}

/**
 * 渲染单元：同一次模型响应（messageId 相同）里的多个工具调用是并行的，合成一个 steps 显示成一组；
 * 一次一个、先后调用的（串行）各自一行
 */
type Unit =
  | { kind: "item"; key: string; item: Exclude<Item, { kind: "assistant" }> }
  /** uuid：所在的那条 assistant 消息（会话记录里一行一个内容块） */
  | { kind: "text"; key: string; uuid: string; at?: number; text: string }
  | { kind: "steps"; key: string; messageId?: string; tools: ToolUse[] }
  /**
   * 部件（show_widget）：单独一个单元，不和同一次响应里的其他工具调用合成一组。
   * app：MCP Apps 的工具（声明了界面资源的 MCP 工具），同样单独一个单元、不折叠，显示服务器给的界面
   */
  | { kind: "widget"; key: string; block: ToolUse; app?: McpAppTool; partial?: boolean };

function toUnits(items: Item[], apps: McpAppTools | null): Unit[] {
  const units: Unit[] = [];
  for (const item of items) {
    if (item.kind !== "assistant") {
      units.push({ kind: "item", key: item.uuid, item });
      continue;
    }
    item.blocks.forEach((block, i) => {
      const key = `${item.uuid}:${i}`;
      if (block.type === "text") units.push({ kind: "text", key, uuid: item.uuid, at: item.at, text: block.text });
      else if (block.name === SHOW_WIDGET_TOOL) units.push({ kind: "widget", key, block });
      else if (apps?.[block.name]?.resourceUri) units.push({ kind: "widget", key, block, app: apps[block.name] });
      else {
        const last = units.at(-1);
        if (last?.kind === "steps" && item.messageId && last.messageId === item.messageId) last.tools.push(block);
        else units.push({ kind: "steps", key, messageId: item.messageId, tools: [block] });
      }
    });
  }
  return units;
}

/** 子代理里的消息：不分轮，按顺序显示 */
function ItemList({ items, view }: { items: Item[]; view: SessionView }) {
  return (
    <>
      {toUnits(items, view.mcpApps).map((unit) => (
        <UnitView key={unit.key} unit={unit} view={view} />
      ))}
    </>
  );
}

function UnitView({ unit, view }: { unit: Unit; view: SessionView }) {
  const renderChildren = (children: Item[]) => <ItemList items={children} view={view} />;
  switch (unit.kind) {
    case "item":
      return <ItemView item={unit.item} />;
    case "text":
      return (
        <AnnotatableText messageId={unit.key}>
          <ReplyMarkdown>{unit.text}</ReplyMarkdown>
        </AnnotatableText>
      );
    case "widget": {
      if (unit.app) {
        return (
          <McpAppView
            toolUseId={unit.block.id}
            partial={unit.partial === true}
            toolName={unit.block.name}
            tool={unit.app}
            input={(unit.block.input ?? {}) as Record<string, unknown>}
            result={view.toolResults[unit.block.id]}
            raw={view.toolRaw[unit.block.id]}
          />
        );
      }
      const input = (unit.block.input ?? {}) as { widget_code?: unknown; title?: unknown; loading_messages?: unknown };
      // 出错的调用（参数是空的、被中断）显示成一步
      if (typeof input.widget_code !== "string" || !input.widget_code.trim() || view.toolResults[unit.block.id]?.isError)
        return <ToolStep block={unit.block} view={view} renderChildren={renderChildren} />;
      const loading = Array.isArray(input.loading_messages) ? input.loading_messages.filter((m): m is string => typeof m === "string") : undefined;
      // 工具结果还没到：网关在等这个部件的显示结果，显示后报告
      const reportId = view.toolResults[unit.block.id] ? undefined : unit.block.id;
      return <Widget code={input.widget_code} title={typeof input.title === "string" ? input.title : undefined} loadingMessages={loading} reportId={reportId} />;
    }
    case "steps":
      return unit.tools.length === 1 ? (
        <ToolStep block={unit.tools[0]!} view={view} renderChildren={renderChildren} />
      ) : (
        <StepGroup tools={unit.tools} view={view} renderChildren={renderChildren} />
      );
  }
}

/**
 * 用户消息：带的标注、正文气泡（只有标注时不画空气泡）和复制按钮；一轮的开头和排队中的消息都用它。
 * reveal：要定位到这条消息（值每次不同），太长折叠着的展开
 */
function UserGroup({ item, reveal }: { item: UserItem; reveal?: number }) {
  return (
    <div className="msg-group msg-group-user" data-msg-uuid={item.uuid}>
      {item.annotations && <SentNotesChip annotations={item.annotations} />}
      {(item.text || item.images.length > 0 || item.attachments.length > 0 || !item.annotations) && <ItemView item={item} reveal={reveal} />}
      {item.text && (
        <MessageActions align="end">
          <CopyAction text={item.text} title="复制消息" />
        </MessageActions>
      )}
    </div>
  );
}

/** 用户消息折叠后显示的行数 */
const USER_TEXT_LINES = 6;
/** 超过这么多行才折叠：只多出一两行的不折，免得展开后没多出什么 */
const USER_TEXT_FOLD_OVER = 8;

/**
 * 用户消息的文字：太长（粘贴的长链接、大段文字）时默认只显示前几行，下面有「展开」。
 * 按实际排出来的行数判断（长链接没有换行符也会占很多行），宽度、字号变了重新量；
 * 量之前先按字数和换行数猜一下，免得长消息先整条画出来再缩回去
 */
function UserText({ text, reveal }: { text: string; reveal?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(() => text.length > 600 || text.split("\n").length > USER_TEXT_FOLD_OVER);
  const [open, setOpen] = useState(false);
  // 查找结果定位到这条消息：展开，匹配的地方可能在折叠掉的部分里
  useLayoutEffect(() => {
    if (reveal !== undefined) setOpen(true);
  }, [reveal]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
      // 折叠着时 scrollHeight 也是全文的高度
      setLong(el.scrollHeight > lineHeight * USER_TEXT_FOLD_OVER + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  const clamped = long && !open;
  return (
    <>
      <div ref={ref} className={clamped ? "user-text clamped" : "user-text"} style={clamped ? { WebkitLineClamp: USER_TEXT_LINES } : undefined}>
        <MentionText text={text} compact />
      </div>
      {long && (
        <button
          className="user-text-more"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            // 收起时消息开头可能已经滚出去了，收起后滚回能看到的地方
            if (open) requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "nearest" }));
          }}
        >
          {open ? "收起" : "展开"}
        </button>
      )}
    </>
  );
}

/** 子进程异常结束的报错；SSH 连接断开引起的，那台主机之后又连上了就不再显示 */
function ErrorLine({ item }: { item: Extract<Item, { kind: "error" }> }) {
  const connections = useSshConnections();
  const host = item.host ? connections.find((c) => c.id === item.host) : undefined;
  if (host?.status === "ready" && (host.connectedAt ?? 0) > item.at) return null;
  return <div className="result error">{item.text}</div>;
}

/** reveal：用户消息要定位到（见 UserGroup） */
function ItemView({ item, reveal }: { item: Exclude<Item, { kind: "assistant" }>; reveal?: number }) {
  const cwd = useContext(FileLinkContext)?.cwd;
  switch (item.kind) {
    case "user": {
      // 拖进来的图片是消息末尾的 @绝对路径（会话所在机器上的），和上传的图片一样显示成缩略图（图片从网关按路径取）
      const { text, paths } = splitImageRefs(item.text);
      const images = [...item.images, ...paths.map((p) => api.rawFileUrl(sessionPathUri(cwd, p), ""))];
      return (
        <div className="user">
          {images.length > 0 && (
            <div className="user-images">
              {images.map((src, i) => (
                <ImageThumb key={i} src={src} />
              ))}
            </div>
          )}
          {item.attachments.length > 0 && <Attachments items={item.attachments} />}
          {text && <UserText text={text} reveal={reveal} />}
        </div>
      );
    }
    case "result":
      // 一轮的用时显示在过程的折叠条上；子代理里出现的 result 只在出错时显示
      return item.isError && item.text ? <div className="result error">出错：{item.text}</div> : null;
    case "error":
      return <ErrorLine item={item} />;
    case "notice":
      return <div className="notice-line">{item.text}</div>;
    case "interrupted":
      // 同换模型的提示：居中一行，两边是分割线
      return (
        <div className="model-line">
          <span>已中断</span>
        </div>
      );
    case "model":
      return <ModelLine from={item.from} to={item.to} />;
    case "task":
      return <TaskLine task={item} />;
    case "agent":
      return <AgentMessage item={item} />;
    case "compact":
      return <CompactLine item={item} />;
    case "goal":
      return <GoalLine item={item} />;
  }
}

/**
 * 目标的一行（见 Item 的 goal）：设定是一轮的开头，条件太长时折起来、点开看全文；取消同换模型的提示居中一行；
 * 检查没通过是过程里的灰字；达成、做不到在这一轮最后，带检查给的理由
 */
function GoalLine({ item }: { item: GoalItem }) {
  const [open, setOpen] = useState(false);
  if (item.event === "cleared") {
    return (
      <div className="model-line">
        <GoalIcon />
        <span>{item.condition ? `已取消目标：${shortLine(item.condition)}` : "已取消目标"}</span>
      </div>
    );
  }
  if (item.event === "check") return <div className="goal-check">目标检查未通过：{item.reason}</div>;
  if (item.event === "set") {
    const long = item.condition.length > 160 || item.condition.includes("\n");
    return (
      <div className="goal-line goal-set">
        <GoalIcon />
        <div className="goal-line-body">
          <div className="goal-line-head">设定目标</div>
          <div className={long && !open ? "goal-line-text clamped" : "goal-line-text"}>{item.condition}</div>
          {long && (
            <button className="goal-line-more" onClick={() => setOpen((o) => !o)}>
              {open ? "收起" : "展开"}
            </button>
          )}
        </div>
      </div>
    );
  }
  const met = item.event === "met";
  return (
    <div className={met ? "goal-line goal-met" : "goal-line goal-failed"}>
      <GoalIcon />
      <div className="goal-line-body">
        <div className="goal-line-head">
          {met ? "目标已达成" : "目标无法达成，已停止"}
          {met && item.iterations ? <span className="goal-line-meta">共检查 {item.iterations} 次</span> : null}
        </div>
        {item.reason && <div className="goal-line-reason">{item.reason}</div>}
      </div>
    </div>
  );
}

/**
 * 压缩上下文的分界线，参照 codex-app-server 的 CompactionLive：
 * 进行中两侧细线往中间收、图标里几条横线挤到一起再散开、文字上一道光扫过；做完后原地换成分界线
 */
function CompactLine({ item }: { item: CompactItem }) {
  if (item.status === "running") {
    return (
      <div className="compaction-live" role="status">
        <span className="compaction-icon" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="compaction-text">正在压缩上下文</span>
      </div>
    );
  }
  return (
    <div className="model-line compact-line">
      {/* 图标同 codex-app-server 的「压缩会话」（icons/compact.svg）：两条竖线之间夹着几条横线 */}
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 8h9M3.5 4.5h9M3.5 11.5h9M2 2v12M14 2v12" />
      </svg>
      <span>{item.status === "failed" ? "压缩上下文未完成" : "上下文已压缩"}</span>
    </div>
  );
}

/** 工具调用的一行摘要（权限确认卡片用） */
export function toolBrief(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string) => (typeof i[key] === "string" ? (i[key] as string) : "");
  switch (name) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return pick("file_path") || pick("notebook_path");
    case "Grep":
    case "Glob":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    case "Agent":
    case "Task":
      return pick("description");
    case "mcp__terminal__run_in_terminal":
      return pick("command");
    case "mcp__terminal__send_to_terminal":
      return pick("text");
    case "mcp__desktop__run":
      return desktopCommandLine(i);
    case "mcp__desktop__run_code":
      return pick("code");
    case "AskUserQuestion":
      return Array.isArray(i.questions) ? (i.questions as { question?: string }[]).map((q) => q.question ?? "").join("\n") : "";
    default:
      return "";
  }
}

/** 换模型的提示：居中一行，两边是分割线 */
function ModelLine({ from, to }: { from: string; to: string }) {
  return (
    <div className="model-line">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z" />
        <path d="M2.5 5 8 8.2 13.5 5M8 8.2v6" />
      </svg>
      <span>
        {from ? `模型已从 ${from} 更改为 ${to}。` : `模型已更改为 ${to}。`}
      </span>
    </div>
  );
}
