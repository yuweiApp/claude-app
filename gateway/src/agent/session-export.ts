import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { saveTextAttachment, type SessionExport } from "./attachments.js";

/**
 * 引用会话（侧边栏的会话拖进输入框，消息里写成 @session[标题](session:会话 id)）：发送时把会话导出成一份 Markdown，存成附件，随消息发给模型。
 * 只留用户消息和回复的文字；工具调用写名称和参数的开头，工具结果、思考、子代理的消息不写，压缩上下文后的摘要单独标出
 */

/** 消息里的会话引用：@session[标题](session:会话 id)，前面是空白或开头（网页的输入框发送时写成这样） */
export const SESSION_MENTION = /(?:^|\s)@session\[[^\]\n]*\]\(session:([\w-]+)\)/g;

/** 工具参数只写开头这么多字 */
const TOOL_INPUT_CHARS = 300;

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** 运行时消息上还带着这些（SDK 的类型定义里没有） */
interface RuntimeFields {
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
}

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function toolLine(block: Block): string {
  let input = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
  if (input.length > TOOL_INPUT_CHARS) input = `${input.slice(0, TOOL_INPUT_CHARS)}…`;
  return `> 调用工具 ${block.name ?? "?"}：${input.replace(/\n/g, " ")}`;
}

/** Claude Code 自己写进记录的 user 消息（本地命令的输出、命令说明），不是用户说的话 */
const LOCAL_COMMAND = /^<(local-command-stdout|local-command-stderr|local-command-caveat|command-name)>/;

const timeOf = (m: SessionMessage) => {
  const t = (m as RuntimeFields).timestamp;
  return t ? ` · ${new Date(t).toLocaleString("zh-CN", { hour12: false })}` : "";
};

export function sessionMarkdown(info: { sessionId: string; title: string; cwd: string | null }, messages: SessionMessage[]): string {
  const out: string[] = [
    `# 会话记录：${info.title}`,
    "",
    `- 会话 id：${info.sessionId}`,
    ...(info.cwd ? [`- 工作目录：${info.cwd}`] : []),
    `- 导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `- 内容：用户消息和回复的文字；工具调用只有名称和参数的开头（超过 ${TOOL_INPUT_CHARS} 字截断），没有工具结果、思考过程和子代理的消息`,
  ];
  // 连续的回复（Claude Code 把一次回复的每个内容块记成一条）合成一段
  let lastRole: "user" | "assistant" | null = null;
  for (const m of messages) {
    if (m.parent_tool_use_id || (m as RuntimeFields).isMeta) continue;
    const blocks = blocksOf(m.message);
    if (m.type === "user") {
      const texts = blocks.flatMap((b) => (b.type === "text" && b.text?.trim() && !LOCAL_COMMAND.test(b.text.trim()) ? [b.text.trim()] : b.type === "image" ? ["[图片]"] : []));
      if (!texts.length) continue;
      const heading = (m as RuntimeFields).isCompactSummary ? "上下文压缩后的摘要" : "用户";
      out.push("", `## ${heading}${timeOf(m)}`, "", texts.join("\n\n"));
      lastRole = "user";
    } else if (m.type === "assistant") {
      const parts = blocks.flatMap((b) => (b.type === "text" && b.text?.trim() ? [b.text.trim()] : b.type === "tool_use" ? [toolLine(b)] : []));
      if (!parts.length) continue;
      if (lastRole !== "assistant") out.push("", `## 回复${timeOf(m)}`);
      out.push("", parts.join("\n\n"));
      lastRole = "assistant";
    }
  }
  return `${out.join("\n")}\n`;
}

/** 导出成附件，文件名是「会话-标题.md」 */
export async function exportSession(info: { sessionId: string; title: string; cwd: string | null }, messages: SessionMessage[]): Promise<SessionExport> {
  const name = `会话-${info.title.replace(/[\\/:*?"<>|\n]/g, " ").trim().slice(0, 80) || info.sessionId}.md`;
  return { ...(await saveTextAttachment(name, sessionMarkdown(info, messages))), sessionId: info.sessionId };
}
