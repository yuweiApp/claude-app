import { config } from "../config.js";

const MAX_TITLE_LENGTH = 20;

/** 提问的第一行，截短：模型接口用不了时的标题 */
function fallbackTitle(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH)}…` : line;
}

/** 模型偶尔带上引号、括号：去掉这些符号，再去掉首尾的标点 */
function cleanTitle(text: string): string {
  return text
    .trim()
    .split("\n")[0]!
    .replace(/["'“”‘’「」《》【】\[\]]/g, "")
    .replace(/^[\s、，。,.:：;；!！?？]+|[\s、，。,.:：;；!！?？]+$/g, "")
    .slice(0, MAX_TITLE_LENGTH);
}

/** 请求模型接口，把第一条提问概括成简短标题（网关直接请求，不进会话）；失败时用提问的第一行 */
export async function generateTitle(message: string): Promise<string> {
  // 开头的 /技能名 不算内容
  const text = message.replace(/^\/\S+\s+/, "") || message;
  if (!config.model) return fallbackTitle(text);
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
  else if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
  const base = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const prompt = `用不超过 12 个字概括下面这条消息的主题，作为会话标题。不要回答消息本身，只输出标题，不要标点和引号。\n\n消息：\n${text.slice(0, 1000)}`;
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.model, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return fallbackTitle(text);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const title = cleanTitle(body.content?.find((block) => block.type === "text")?.text ?? "");
    return title || fallbackTitle(text);
  } catch {
    return fallbackTitle(text);
  }
}
