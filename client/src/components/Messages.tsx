import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block, Item, SessionView } from "../state/session";
import { Attachments } from "./Attachments";

export function Messages({ view }: { view: SessionView }) {
  return (
    <div className="messages">
      {view.items.map((item) => (
        <ItemView key={item.uuid} item={item} view={view} />
      ))}
      {view.streaming.thinking && <div className="thinking streaming">{view.streaming.thinking}</div>}
      {view.streaming.text && (
        <div className="assistant streaming">
          <Markdown remarkPlugins={[remarkGfm]}>{view.streaming.text}</Markdown>
        </div>
      )}
      {view.state === "running" && !view.streaming.text && <div className="working">正在处理…</div>}
    </div>
  );
}

function ItemView({ item, view }: { item: Item; view: SessionView }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="user">
          {item.attachments.length > 0 && <Attachments items={item.attachments} />}
          {item.text}
        </div>
      );
    case "assistant":
      return (
        <>
          {item.blocks.map((block, i) => (
            <BlockView key={i} block={block} view={view} />
          ))}
        </>
      );
    case "result":
      return (
        <div className={item.isError ? "result error" : "result"}>
          {item.isError ? `出错：${item.text}` : `完成 · ${(item.durationMs / 1000).toFixed(1)}s`}
        </div>
      );
    case "error":
      return <div className="result error">{item.text}</div>;
  }
}

function BlockView({ block, view }: { block: Block; view: SessionView }) {
  if (block.type === "text") {
    return (
      <div className="assistant">
        <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>
      </div>
    );
  }
  if (block.type === "thinking") {
    return (
      <details className="thinking">
        <summary>思考</summary>
        {block.thinking}
      </details>
    );
  }
  const result = view.toolResults[block.id];
  const children = view.children[block.id];
  const status = result ? (result.isError ? "failed" : "done") : "pending";
  return (
    <details className={`tool ${status}`}>
      <summary>
        <span className="tool-name">{block.name}</span>
        <span className="tool-brief">{toolBrief(block.name, block.input)}</span>
      </summary>
      <pre className="tool-input">{JSON.stringify(block.input, null, 2)}</pre>
      {children && (
        <div className="subagent">
          {children.map((item) => (
            <ItemView key={item.uuid} item={item} view={view} />
          ))}
        </div>
      )}
      {result && <pre className="tool-result">{result.text}</pre>}
    </details>
  );
}

/** 工具调用折叠时显示的一行摘要 */
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
