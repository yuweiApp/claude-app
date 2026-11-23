/** 网关的 MCP 工具（终端、浏览器、桌面、对话里的部件）共用的：返回结果的写法、调用附带的信息、后台调用的结果 */

export const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

export const errorResult = (text: string) => ({ ...textResult(text), isError: true });

/** 结果前面加一段说明（应用重启过、别的会话动过桌面等），空行隔开；没有说明时原样 */
export const withNotice = (notice: string | null | undefined, body: string) => (notice ? (body ? `${notice}\n\n${body}` : notice) : body);

/** 文字和图片的输出（浏览器、桌面的代码运行结果） */
export interface ToolOutput {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
}

/** 转成 MCP 的结果：文字（有的话）在前，图片在后 */
export function outputResult(output: ToolOutput) {
  return {
    content: [
      ...(output.text ? [{ type: "text" as const, text: output.text }] : []),
      ...output.images.map((img) => ({ type: "image" as const, ...img })),
    ],
    ...(output.isError ? { isError: true } : {}),
  };
}

/** 这次调用的 tool_use_id：Claude Code 调 MCP 工具时放在 _meta["claudecode/toolUseId"] 里；拿不到是 undefined */
export function toolUseIdOf(extra: unknown): string | undefined {
  const id = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["claudecode/toolUseId"];
  return typeof id === "string" ? id : undefined;
}

/** 这次调用的取消信号（模型那边取消了工具调用） */
export const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal;

/**
 * 工具调用的结果，按 tool_use_id 记：调用跑久了会被 Claude Code 转到后台，结果只交给模型，
 * 网关在 task_notification 里按 tool_use_id 取出来发给网页（task_result 事件），失败时显示原因。只留最近的一些
 */
const toolResults = new Map<string, { text: string; isError: boolean }>();
const MAX_TOOL_RESULTS = 50;

export function rememberResult(extra: unknown, text: string, isError: boolean): void {
  const id = toolUseIdOf(extra);
  if (!id) return;
  toolResults.set(id, { text, isError });
  if (toolResults.size > MAX_TOOL_RESULTS) toolResults.delete(toolResults.keys().next().value as string);
}

/** 取出（并删掉）一次工具调用的结果；不是记了结果的网关工具（浏览器、桌面、终端）、或者已经被挤掉了返回 undefined */
export function takeToolResult(toolUseId: string): { text: string; isError: boolean } | undefined {
  const result = toolResults.get(toolUseId);
  toolResults.delete(toolUseId);
  return result;
}
