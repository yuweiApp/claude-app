import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Item, SessionView, TaskItem } from "../state/session";
import { Attachments } from "./Attachments";
import { ImageThumb } from "./ImageThumb";
import { CopyAction, MessageActions } from "./MessageActions";
import { StepGroup, ToolStep, type ToolUse } from "./Steps";

type UserItem = Extract<Item, { kind: "user" }>;
type ResultItem = Extract<Item, { kind: "result" }>;

/** 一轮：用户消息（或自动开始这一轮的后台任务通知）开头，到 result（这一轮结束）为止 */
interface Turn {
  key: string;
  user: UserItem | null;
  task: TaskItem | null;
  body: Item[];
  result: ResultItem | null;
}

function splitTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  const results: ResultItem[] = [];
  for (const item of items) {
    if (item.kind === "result") results.push(item);
    else if (item.kind === "user" || item.kind === "task" || !turns.length) {
      turns.push({
        key: item.uuid,
        user: item.kind === "user" ? item : null,
        task: item.kind === "task" ? item : null,
        body: item.kind === "user" || item.kind === "task" ? [] : [item],
        result: null,
      });
    } else turns.at(-1)!.body.push(item);
  }
  // 历史消息（getSessionMessages）里没有 result，事件流回放的 result 排在最后：按 SDK 的 user_message_uuid 挂回所属的那一轮。
  // 后台任务开始的轮没有 user_message_uuid，事件缓冲也可能只剩最近几轮的 result：从后往前，挂到前面最近一个还没有 result 的轮
  let limit = turns.length;
  for (const r of results.toReversed()) {
    let i = r.userMessageUuid ? turns.findIndex((t) => t.user?.uuid === r.userMessageUuid) : -1;
    if (i < 0) i = turns.findLastIndex((t, j) => j < limit && !t.result);
    if (i < 0) continue;
    turns[i]!.result = r;
    limit = i;
  }
  return turns;
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
  const name = /"(.+)"/.exec(task.text)?.[1] ?? task.text;
  const label = name ? `${status}：${name}` : status;
  return exit ? `${label}（退出码 ${exit}）` : label;
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
    </div>
  );
}

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** 进行中的计时，每秒刷新；从开始显示时算起 */
function Elapsed() {
  const [start] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(now - start)}</>;
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
  const expanded = live ? !liveCollapsed : open;
  // 工具正在执行时它的图标在转，不再另外显示「思考中…」
  const toolRunning = units.some((u) => u.kind === "steps" && u.tools.some((t) => !view.toolResults[t.id]));

  return (
    <section className="turn">
      {turn.task && (
        <div className={`task-line${turn.task.status === "failed" && !taskExitCode(turn.task) ? " error" : ""}`} title={turn.task.text}>
          {taskLabel(turn.task)}
        </div>
      )}
      {turn.user && (
        <div className="msg-group msg-group-user">
          <ItemView item={turn.user} />
          {turn.user.text && (
            <MessageActions align="end">
              <CopyAction text={turn.user.text} title="复制消息" />
            </MessageActions>
          )}
        </div>
      )}
      {(hasProcess || live) && (
        <div className="process-wrap">
          <button
            className="process-toggle"
            onClick={() => (live ? setLiveCollapsed((c) => !c) : setOpen((o) => !o))}
            disabled={!hasProcess}
          >
            {live ? (
              <>
                已处理 <Elapsed />
              </>
            ) : turn.result ? (
              `用时 ${formatDuration(turn.result.durationMs)}`
            ) : (
              "处理过程"
            )}
            {hasProcess && <span className="step-caret">{expanded ? "▾" : "›"}</span>}
          </button>
          {hasProcess && expanded && (
            <div className="process">
              {process.map((u) => (
                <UnitView key={u.key} unit={u} view={view} />
              ))}
            </div>
          )}
          {live && !streaming && !(expanded && toolRunning) && <div className="working">思考中…</div>}
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
          <Markdown remarkPlugins={[remarkGfm]}>{view.streaming.text}</Markdown>
        </div>
      )}
      {errors.map((u) => (
        <UnitView key={u.key} unit={u} view={view} />
      ))}
      {turn.result?.isError && <div className="result error">出错：{turn.result.text}</div>}
    </section>
  );
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
        <div className="assistant">
          <Markdown remarkPlugins={[remarkGfm]}>{unit.text}</Markdown>
        </div>
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
    case "user":
      return (
        <div className="user">
          {item.images.length > 0 && (
            <div className="user-images">
              {item.images.map((src, i) => (
                <ImageThumb key={i} src={src} />
              ))}
            </div>
          )}
          {item.attachments.length > 0 && <Attachments items={item.attachments} />}
          {item.text}
        </div>
      );
    case "result":
      // 一轮的用时显示在过程的折叠条上；子代理里出现的 result 只在出错时显示
      return item.isError ? <div className="result error">出错：{item.text}</div> : null;
    case "error":
      return <div className="result error">{item.text}</div>;
    case "notice":
      return <div className="notice-line">{item.text}</div>;
    case "task":
      return <div className="task-line">{taskLabel(item)}</div>;
  }
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
    default:
      return "";
  }
}
