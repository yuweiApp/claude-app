import { useEffect, useState } from "react";
import { api } from "../api";
import type { Item, SessionView, TaskItem } from "../state/session";
import { Attachments } from "./Attachments";
import { ImageThumb } from "./ImageThumb";
import { CopyAction, MessageActions } from "./MessageActions";
import { StepGroup, stepImages, ToolIcon, ToolStep, type ToolUse } from "./Steps";
import { StepThumbs } from "./StepThumbs";
import { formatShortDuration } from "./TasksPopover";
import { MentionText, splitImageRefs } from "./MentionText";
import { AnnotatableText, SentNotesChip } from "./ResponseAnnotations";
import { ReplyMarkdown } from "./ReplyMarkdown";

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
  /** 这一段从压缩上下文开始 */
  compact: CompactItem | null;
  body: Item[];
  result: ResultItem | null;
  /** 接着上一段（这条用户消息是进行中插入的） */
  continued: boolean;
  /** 下一段（插入的消息）开始的时间，这一段的用时算到这里 */
  nextAt?: number;
}

function splitTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  const results: ResultItem[] = [];
  // result 的 user_message_uuid 指向的用户消息开始了自己的一轮，不是插进上一轮的：有工具在跑时发的消息（now），
  // Claude Code 有时先结束这一轮（result 的 stop_reason 是 tool_use）再用它开新的一轮。历史里它也紧跟在工具结果后面，光看位置分不出来
  const turnStarts = new Set(items.flatMap((item) => (item.kind === "result" && item.userMessageUuid ? [item.userMessageUuid] : [])));
  // 这一轮是不是停在工具调用上（还没结束）：此时来的用户消息是中途插入的。
  // 历史记录里插入的消息排在它被读到的那个工具结果后面，实时发的也是在工具执行时发出，两边都是跟在以工具调用结尾的 assistant 消息后面
  let midTool = false;
  for (const item of items) {
    if (item.kind === "result") {
      results.push(item);
      midTool = false;
    } else if (item.kind === "user" || item.kind === "task" || item.kind === "compact" || !turns.length) {
      const continued = (item.kind === "user" && midTool && !turnStarts.has(item.uuid)) || (item.kind === "compact" && turns.length > 0);
      if (continued) turns.at(-1)!.nextAt = item.at;
      turns.push({
        key: item.uuid,
        user: item.kind === "user" ? item : null,
        task: item.kind === "task" ? item : null,
        compact: item.kind === "compact" ? item : null,
        body: item.kind === "user" || item.kind === "task" || item.kind === "compact" ? [] : [item],
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
  // 都找不到（事件缓冲从某一轮中间开始）：从后往前，挂到前面最近一个还没有 result 的轮
  const startOf = (uuid: string | undefined) => (uuid ? turns.findIndex((t) => (t.user ?? t.task)?.uuid === uuid) : -1);
  let limit = turns.length;
  for (const r of results.toReversed()) {
    let i = startOf(r.userMessageUuid);
    if (i < 0) i = startOf(r.startUuid);
    if (i >= 0) i = lastSegment(i);
    if (i < 0) i = turns.findLastIndex((t, j) => j < limit && !t.result && !turns[j + 1]?.continued);
    if (i < 0) continue;
    turns[i]!.result = r;
    limit = i;
  }
  return turns;
}

/**
 * 这一轮的用时：有 result 用它的；插入过消息的最后一段和历史里没有 result 的（网关重启过、这一轮没跑完），
 * 按这一段开头那条消息到下一段开始、result 到达或最后一条消息的时间算
 */
function turnDuration(turn: Turn): number | null {
  if (turn.result) {
    // 插入过消息的一轮，result 的用时是整轮的，最后一段只算它自己那部分
    if (!turn.continued) return turn.result.durationMs;
  }
  const start = (turn.user ?? turn.task ?? turn.compact)?.at;
  const end = turn.nextAt ?? turn.result?.at ?? turn.body.findLast((item) => item.kind === "assistant")?.at;
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
  const label = name ? `${status}：${name}` : status;
  return exit ? `${label}（退出码 ${exit}）` : label;
}

/** 失败的后台任务的原因：结果原文的第一行（浏览器工具出错时是 Playwright 的报错），太长截断；全文在悬停提示里 */
function taskReason(task: TaskItem): string | undefined {
  if (task.status !== "failed" || !task.detail) return undefined;
  const line = task.detail.split("\n").map((l) => l.trim()).find(Boolean);
  return line && (line.length > 200 ? `${line.slice(0, 200)}…` : line);
}

/** 后台任务的一行。失败也用灰色、不标红：模型接下来的回复里通常已经说明了原因，红色太扎眼 */
function TaskLine({ task }: { task: TaskItem }) {
  const reason = taskReason(task);
  return (
    <div className="task-line" title={task.detail ?? task.text}>
      {taskLabel(task)}
      {reason && <div className="task-reason">{reason}</div>}
    </div>
  );
}

export function Messages({ view }: { view: SessionView }) {
  const turns = splitTurns(view.items);
  // 只有 running 算进行中：续接的会话在第一条消息之前一直是 starting（子进程等输入，init 要等发消息才来）
  const busy = view.state === "running";
  return (
    <div className="messages">
      {turns.map((turn, i) => (
        <TurnView key={turn.key} turn={turn} view={view} live={busy && i === turns.length - 1 && !turn.result} />
      ))}
      {/* 这一轮进行中发的、还没交给模型的消息：和普通消息一样显示，保持在最后，交给模型时才固定位置（见 SessionView.queued） */}
      {view.queued.map(
        (q) =>
          q.preview && (
            <section key={q.uuid} className="turn">
              <div className="msg-group msg-group-user">
                <ItemView item={q.preview} />
              </div>
            </section>
          ),
      )}
      {/* 换了模型还没发消息：先临时显示，新模型回复后由那条消息补出正式的一行 */}
      {!busy && view.model && view.shownModel && view.model !== view.shownModel && <ModelLine from={view.shownModel} to={view.model} />}
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
function TurnView({ turn, view, live }: { turn: Turn; view: SessionView; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [liveCollapsed, setLiveCollapsed] = useState(false);
  const units = toUnits(turn.body);
  // 结束后最后一段文字是最终回复，不折叠；进行中全部算过程。历史里读回来的轮没有 result，不在进行中就算结束了
  // 本地命令的灰字、网关报错（kind: "item"）不算，跳过它们找最后一段
  const lastIdx = units.findLastIndex((u) => u.kind !== "item");
  const finalIdx = !live && units[lastIdx]?.kind === "text" ? lastIdx : -1;
  const final = finalIdx >= 0 ? units[finalIdx]! : null;
  // 网关报的错不折叠
  const errors = units.filter((u) => u.kind === "item");
  const process = units.filter((u, i) => i !== finalIdx && u.kind !== "item");
  const streaming = live && view.streaming.text;
  const hasProcess = process.length > 0;
  const duration = live ? null : turnDuration(turn);
  const expanded = live ? !liveCollapsed : open;
  // 工具正在执行时它的图标在转，不再另外显示「思考中…」
  const toolRunning = units.some((u) => u.kind === "steps" && u.tools.some((t) => !view.toolResults[t.id]));
  // 正在压缩、压缩后还没有新的步骤：只显示压缩的动画，不显示「已处理」和「思考中…」
  const compacting = turn.compact?.status === "running" && !hasProcess;

  return (
    <section className="turn">
      {turn.task && <TaskLine task={turn.task} />}
      {turn.compact && <CompactLine item={turn.compact} />}
      {turn.user && (
        <div className="msg-group msg-group-user">
          {turn.user.annotations && <SentNotesChip annotations={turn.user.annotations} />}
          {(turn.user.text || turn.user.images.length > 0 || turn.user.attachments.length > 0 || !turn.user.annotations) && <ItemView item={turn.user} />}
          {turn.user.text && (
            <MessageActions align="end">
              <CopyAction text={turn.user.text} title="复制消息" />
            </MessageActions>
          )}
        </div>
      )}
      {(hasProcess || live || duration !== null) && !compacting && (
        <div className="process-wrap">
          <div className="process-toggle-row">
            <button
              className="process-toggle"
              onClick={() => (live ? setLiveCollapsed((c) => !c) : setOpen((o) => !o))}
              disabled={!hasProcess}
            >
              {live ? (
                <>
                  已处理 <Elapsed since={(turn.user ?? turn.task ?? turn.compact)?.at} />
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
          {live && !streaming && !(expanded && toolRunning) && (
            <div className="working">
              <ToolIcon icon="✳" running />
              <span className="working-label">思考中…</span>
            </div>
          )}
        </div>
      )}
      {final && (
        <div className="msg-group">
          <UnitView unit={final} view={view} />
          {final.kind === "text" && (
            <MessageActions align="start">
              <CopyAction text={final.text} title="复制回复" />
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
      {turn.result?.isError && <div className="result error">出错：{turn.result.text}</div>}
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
  | { kind: "text"; key: string; text: string }
  | { kind: "steps"; key: string; messageId?: string; tools: ToolUse[] };

function toUnits(items: Item[]): Unit[] {
  const units: Unit[] = [];
  for (const item of items) {
    if (item.kind !== "assistant") {
      units.push({ kind: "item", key: item.uuid, item });
      continue;
    }
    item.blocks.forEach((block, i) => {
      const key = `${item.uuid}:${i}`;
      if (block.type === "text") units.push({ kind: "text", key, text: block.text });
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
      {toUnits(items).map((unit) => (
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
    case "steps":
      return unit.tools.length === 1 ? (
        <ToolStep block={unit.tools[0]!} view={view} renderChildren={renderChildren} />
      ) : (
        <StepGroup tools={unit.tools} view={view} renderChildren={renderChildren} />
      );
  }
}

function ItemView({ item }: { item: Exclude<Item, { kind: "assistant" }> }) {
  switch (item.kind) {
    case "user": {
      // 拖进来的图片是消息末尾的 @绝对路径，和上传的图片一样显示成缩略图（图片从网关按路径取）
      const { text, paths } = splitImageRefs(item.text);
      const images = [...item.images, ...paths.map((p) => api.rawFileUrl(p, ""))];
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
          {text && <MentionText text={text} compact />}
        </div>
      );
    }
    case "result":
      // 一轮的用时显示在过程的折叠条上；子代理里出现的 result 只在出错时显示
      return item.isError ? <div className="result error">出错：{item.text}</div> : null;
    case "error":
      return <div className="result error">{item.text}</div>;
    case "notice":
      return <div className="notice-line">{item.text}</div>;
    case "interrupted":
      return <div className="interrupted-line">已中断</div>;
    case "model":
      return <ModelLine from={item.from} to={item.to} />;
    case "task":
      return <TaskLine task={item} />;
    case "compact":
      return <CompactLine item={item} />;
  }
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
