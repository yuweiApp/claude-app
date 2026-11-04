import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "../config.js";
import type { Capabilities } from "../shared/types.js";
import { noInput } from "./models.js";

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: Capabilities }>();

/**
 * 工作目录下可用的技能和插件：起一个不发消息、不落盘的临时 query 读一次（不调模型接口）。
 * 按工作目录缓存：项目里的 .claude/skills 只在那个目录下有
 */
export async function listCapabilities(cwd: string): Promise<Capabilities> {
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const q = query({
    prompt: noInput(),
    options: { cwd, env: agentEnv(), persistSession: false, settingSources: ["user", "project", "local"] },
  });
  try {
    const { skills } = await q.reloadSkills();
    const { plugins } = await q.reloadPlugins();
    const value: Capabilities = {
      skills: skills.map(({ name, description }) => ({ name, description })),
      plugins: plugins.map(({ name, source, version }) => ({ name, source, version })),
    };
    cache.set(cwd, { at: Date.now(), value });
    return value;
  } finally {
    q.close();
  }
}
