import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, config } from "../config.js";

interface OpenAIModelEntry {
  id: string;
  owned_by?: string;
  supported_endpoint_types?: string[];
}

/** id 里出现这些词的通常不是对话模型（同 codex-app-server 的 codex/provider-models.ts，另加 newapi 上的 3D、文档解析、专用工具模型） */
const NON_CHAT_ID =
  /image|video|tts|speech|audio|voice|lipsync|avatar|upscal|3d|embed|bge|rerank|whisper|transcri|dall-e|edit|cleanup|visuals|background|style-transfer|blend|sequential|decomposition|web-search|moderation|realtime|tripo|easydoc|-fetch-|auto-review|^auto$/i;

function isChatModel(m: OpenAIModelEntry): boolean {
  if (m.owned_by === "task plugin") return false;
  if (m.supported_endpoint_types?.includes("image-generation")) return false;
  // 带 / 的是 newapi 里的图片、视频任务（alibaba/wan-2.7/text-to-video 这类）
  if (m.id.includes("/") || NON_CHAT_ID.test(m.id)) return false;
  return config.modelsFilter?.test(m.id) ?? true;
}

const EFFORTS: ModelInfo["supportedEffortLevels"] = ["low", "medium", "high", "xhigh", "max"];

/** newapi 返回的模型转成 SDK 的 ModelInfo（value 就是模型 id，网页的模型菜单按这个格式显示） */
const toModelInfo = (id: string): ModelInfo => ({ value: id, resolvedModel: id, displayName: id, description: "", supportsEffort: true, supportedEffortLevels: EFFORTS });

const CACHE_MS = 5 * 60_000;
let cache: { at: number; models: Promise<ModelInfo[]> } | null = null;

/**
 * 可选的模型。配了 ANTHROPIC_BASE_URL（newapi）时读它的 GET /v1/models，去掉图片、视频、语音、向量等不是对话的模型，
 * 可用 MODELS_FILTER 正则再筛，默认模型排第一；缓存 5 分钟。
 * 没配时（直连 Anthropic）用 Claude Code 自己的模型列表（Query.supportedModels()）
 */
export function listModels(): Promise<ModelInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.models;
  const models = (config.baseUrl ? fromProvider(config.baseUrl) : fromClaudeCode()).catch((err: unknown) => {
    cache = null;
    throw err;
  });
  cache = { at: Date.now(), models };
  return models;
}

async function fromProvider(baseUrl: string): Promise<ModelInfo[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const headers: Record<string, string> = {};
  if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
  else if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${url} 返回 ${res.status}`);
  const body = (await res.json()) as { data?: OpenAIModelEntry[] };
  if (!Array.isArray(body.data)) throw new Error(`GET ${url} 的响应里没有 data 数组`);
  const ids = [...new Set(body.data.filter(isChatModel).map((m) => m.id))].sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
  // 默认模型排第一（接口里没有也放上，方便切回来）
  const ordered = config.model ? [config.model, ...ids.filter((id) => id !== config.model)] : ids;
  return ordered.map(toModelInfo);
}

export async function* noInput(): AsyncGenerator<never> {
  await new Promise(() => {});
}

/** Claude Code 自己的模型列表：起一个不发消息、不落盘的临时 query 读一次（约 1 秒，不调模型接口） */
async function fromClaudeCode(): Promise<ModelInfo[]> {
  const q = query({
    prompt: noInput(),
    options: { cwd: config.workspaceDir, env: agentEnv(), persistSession: false, settingSources: ["user"] },
  });
  try {
    return await q.supportedModels();
  } finally {
    q.close();
  }
}
