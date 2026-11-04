import { useState, type ReactNode } from "react";
import type { Block, Item, SessionView, ToolResult } from "../state/session";
import { ImageThumb } from "./ImageThumb";
import { formatDuration } from "./TasksPopover";

export type ToolUse = Extract<Block, { type: "tool_use" }>;

/** 跑命令、只读查看类的工具（相当于 codex 的 commandExecution），一组里全是这些时标题叫「运行了命令」 */
const COMMAND_TOOLS = ["Bash", "Read", "Grep", "Glob", "LS"];

/** 行首图标 + 动词 + 对象，参照 codex-app-server 的 ToolLine（client/src/components/ItemView.tsx） */
function toolLabel(block: ToolUse, running: boolean): { icon: string; verb: string; target: string } {
  const i = (block.input ?? {}) as Record<string, unknown>;
  const s = (key: string) => (typeof i[key] === "string" ? (i[key] as string) : "");
  const v = (doing: string, done: string) => (running ? doing : done);
  switch (block.name) {
    case "Bash":
      return { icon: "⌘", verb: v("正在运行", "已运行"), target: s("command") };
    case "Read":
      return { icon: "⌘", verb: v("正在读取", "已读取"), target: s("file_path") };
    case "Grep":
      return { icon: "⌕", verb: v("正在搜索", "已搜索"), target: s("pattern") };
    case "Glob":
      return { icon: "⌕", verb: v("正在查找", "已查找"), target: s("pattern") };
    case "Edit":
    case "NotebookEdit":
      return { icon: "✎", verb: v("正在编辑", "已编辑"), target: s("file_path") || s("notebook_path") };
    case "Write":
      return { icon: "✎", verb: v("正在写入", "已写入"), target: s("file_path") };
    case "WebFetch":
      return { icon: "⌕", verb: v("正在获取", "已获取"), target: s("url") };
    case "Agent":
    case "Task":
      return { icon: "✳", verb: v("子代理运行中", "子代理"), target: s("description") };
    default:
      return { icon: "⚙", verb: v("正在调用", "已调用"), target: block.name };
  }
}

/** 复制的内容：工具名、传入参数和结果 */
function copyText(block: ToolUse, result: ToolResult | undefined): string {
  return [
    `工具：${block.name}`,
    `参数：\n${JSON.stringify(block.input, null, 2)}`,
    `结果：\n${result ? result.text : "（还没有结果）"}`,
  ].join("\n\n");
}

/** 复制按钮：点击后短暂显示"已复制"或失败 */
function CopyButton({ getText }: { getText: () => string }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      setState("done");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 1500);
  };
  return (
    <button className={`copy-btn copy-${state}`} onClick={() => void onClick()} title="复制传入参数和结果" aria-label="复制传入参数和结果">
      {state === "done" ? "✓ 已复制" : state === "error" ? "复制失败" : "⧉ 复制"}
    </button>
  );
}

function ToolIcon({ icon, running }: { icon: string; running: boolean }) {
  return (
    <span className={`step-icon${running ? " step-icon-running" : ""}`}>
      <span className="step-icon-glyph">{icon}</span>
    </span>
  );
}

function ShellBox({ command, output, meta }: { command: string; output: string | null; meta?: string }) {
  return (
    <div className="shell">
      <div className="shell-head">
        <span>Shell</span>
        {meta && <span className="shell-meta">{meta}</span>}
      </div>
      <pre className="shell-body">
        <span className="shell-prompt">$ </span>
        {command}
        {"\n"}
        {output === null ? "（运行中…）" : output || "（无输出）"}
      </pre>
    </div>
  );
}

/** Edit 的 old_string / new_string 显示成 -/+ 两段 */
function EditDiff({ input }: { input: Record<string, unknown> }) {
  const lines = (text: unknown, sign: string) =>
    typeof text === "string" ? text.split("\n").map((l, i) => <div key={sign + i} className={sign === "+" ? "diff-add" : "diff-del"}>{sign} {l}</div>) : [];
  return <pre className="diff">{[...lines(input.old_string, "-"), ...lines(input.new_string, "+")]}</pre>;
}

function ToolDetail({ block, result, children }: { block: ToolUse; result?: ToolResult; children?: ReactNode }) {
  const input = (block.input ?? {}) as Record<string, unknown>;
  if (block.name === "Bash") {
    return <ShellBox command={String(input.command ?? "")} output={result ? result.text : null} meta={typeof input.description === "string" ? input.description : undefined} />;
  }
  return (
    <>
      {block.name === "Edit" && typeof input.old_string === "string" ? (
        <EditDiff input={input} />
      ) : (
        <pre className="output">{JSON.stringify(block.input, null, 2)}</pre>
      )}
      {children && <div className="subagent">{children}</div>}
      {result && (result.text || !result.images.length) && (
        <pre className={result.isError ? "output output-error" : "output"}>{result.text || "（无输出）"}</pre>
      )}
      {result && result.images.length > 0 && (
        <div className="user-images">
          {result.images.map((src, i) => (
            <ImageThumb key={i} src={src} />
          ))}
        </div>
      )}
    </>
  );
}

/** 工具耗时：一分钟内保留一位小数（0.7秒），更长的同一轮的用时 */
function toolDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}秒` : formatDuration(ms);
}

/** 一次工具调用：一行摘要，点击展开详情，鼠标移上去出现复制按钮 */
export function ToolStep({ block, view, renderChildren }: { block: ToolUse; view: SessionView; renderChildren: (items: Item[]) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const result = view.toolResults[block.id];
  const running = !result && view.state === "running";
  const label = toolLabel(block, running);
  const children = view.children[block.id];
  return (
    <div className="step">
      <div className="step-row">
        <button className="step-line" onClick={() => setOpen((o) => !o)}>
          <ToolIcon icon={label.icon} running={running} />
          <span className="step-label">
            {label.verb} <code className="step-target">{label.target}</code>
          </span>
          {result?.isError && <span className="step-bad">失败</span>}
          {result?.durationMs !== undefined && <span className="step-time">{toolDuration(result.durationMs)}</span>}
          <span className="step-caret">{open ? "▾" : "›"}</span>
        </button>
        <CopyButton getText={() => copyText(block, result)} />
      </div>
      {open && (
        <div className="step-detail">
          <ToolDetail block={block} result={result}>
            {children && renderChildren(children)}
          </ToolDetail>
        </div>
      )}
    </div>
  );
}

/** 同一次响应里并行的多个工具调用合成一组「运行了命令 N」/「调用了工具 N」，可以整组折叠 */
export function StepGroup({ tools, view, renderChildren }: { tools: ToolUse[]; view: SessionView; renderChildren: (items: Item[]) => ReactNode }) {
  const [open, setOpen] = useState(true);
  const running = view.state === "running" && tools.some((b) => !view.toolResults[b.id]);
  const commands = tools.every((b) => COMMAND_TOOLS.includes(b.name));
  const title = commands ? (running ? "正在运行命令" : "运行了命令") : running ? "正在调用工具" : "调用了工具";
  return (
    <div className="step-group">
      <div className="step-row">
        <button className="step-line" onClick={() => setOpen((o) => !o)}>
          <ToolIcon icon={commands ? "⌘" : "⚙"} running={running} />
          <span className="step-label">
            {title}
            <span className="step-count">{tools.length}</span>
          </span>
          <span className="step-caret">{open ? "▾" : "›"}</span>
        </button>
      </div>
      {open && (
        <div className="step-group-body">
          {tools.map((b) => (
            <ToolStep key={b.id} block={b} view={view} renderChildren={renderChildren} />
          ))}
        </div>
      )}
    </div>
  );
}
