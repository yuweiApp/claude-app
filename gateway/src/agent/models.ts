import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, config } from "../config.js";

let cached: Promise<ModelInfo[]> | null = null;

async function* noInput(): AsyncGenerator<never> {
  await new Promise(() => {});
}

/**
 * 可选的模型：Claude Code 自己的模型列表（Query.supportedModels()，default / opus / sonnet / haiku 等别名，
 * 按 ANTHROPIC_DEFAULT_*_MODEL 解析到实际模型，带支持的推理强度）。
 * 新会话还没有子进程，起一个不发消息、不落盘的临时 query 读一次（约 1 秒，不调模型接口），之后用缓存
 */
export function listModels(): Promise<ModelInfo[]> {
  cached ??= (async () => {
    const q = query({
      prompt: noInput(),
      options: { cwd: config.workspaceDir, env: agentEnv(), persistSession: false, settingSources: ["user"] },
    });
    try {
      return await q.supportedModels();
    } finally {
      q.close();
    }
  })().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}
