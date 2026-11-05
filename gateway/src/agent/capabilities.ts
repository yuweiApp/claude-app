import { setTimeout as sleep } from "node:timers/promises";
import { query, type McpServerStatus, type Query } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "../config.js";
import type { Capabilities, McpServerInfo } from "../shared/types.js";
import { disabledSkills, importedPluginNames, importedPlugins, importedSkills } from "./extensions.js";
import { enabledMcpServers, readMcpServers, type McpConfig } from "./mcp-config.js";
import { noInput } from "./models.js";

const CACHE_MS = 60_000;
/** 等 MCP 服务器连上的最长时间，超过还没连上的显示连接中 */
const MCP_CONNECT_MS = 8_000;
const cache = new Map<string, { at: number; value: Capabilities }>();

export function clearCapabilitiesCache(): void {
  cache.clear();
}

/** 刚起的 query 里 MCP 服务器还在连接，等到都有结果 */
async function settledMcpStatus(q: Query, first: McpServerStatus[]): Promise<McpServerStatus[]> {
  let servers = first;
  const deadline = Date.now() + MCP_CONNECT_MS;
  while (servers.some((server) => server.status === "pending") && Date.now() < deadline) {
    await sleep(200);
    servers = await q.mcpServerStatus();
  }
  return servers;
}

/** 传给 query 的 skills：SDK 只有启用名单，所以是全部技能减去停用的；没有停用时不传，用 Claude Code 的默认行为 */
export async function enabledSkillNames(cwd: string): Promise<string[] | undefined> {
  if (disabledSkills().length === 0) return undefined;
  const { skills } = await listCapabilities(cwd);
  return skills.filter((skill) => skill.enabled).map((skill) => skill.name);
}

const target = (config: McpConfig) => ("url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" "));

/**
 * 工作目录下可用的技能、插件和 MCP 服务器：起一个不发消息、不落盘的临时 query 读一次（不调模型接口，会连一下 MCP 服务器）。
 * 按工作目录缓存：项目里的 .claude/skills 只在那个目录下有
 */
export async function listCapabilities(cwd: string): Promise<Capabilities> {
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const q = query({
    prompt: noInput(),
    options: { cwd, env: agentEnv(), persistSession: false, settingSources: ["user", "project", "local"], mcpServers: enabledMcpServers(), plugins: importedPlugins() },
  });
  try {
    const { skills } = await q.reloadSkills();
    const reloaded = await q.reloadPlugins();
    const { plugins } = reloaded;
    const mcpServers = await settledMcpStatus(q, reloaded.mcpServers);
    const stored = readMcpServers();
    const live = new Map(mcpServers.map((server) => [server.name, server]));
    // 设置页添加的（含停用的，临时 query 里没有）在前，其余是插件或配置文件带来的，只显示
    const managed: McpServerInfo[] = Object.entries(stored).map(([name, { enabled, config }]) => {
      const server = live.get(name);
      return {
        name,
        enabled,
        managed: true,
        type: config.type ?? "stdio",
        target: target(config),
        status: enabled ? (server?.status ?? "pending") : "disabled",
        error: server?.error,
        tools: (server?.tools ?? []).map(({ name, description }) => ({ name, description })),
      };
    });
    const others: McpServerInfo[] = mcpServers
      .filter((server) => !stored[server.name])
      .map((server) => ({
        name: server.name,
        enabled: server.status !== "disabled",
        managed: false,
        status: server.status,
        error: server.error,
        source: server.source,
        tools: (server.tools ?? []).map(({ name, description }) => ({ name, description })),
      }));
    const value: Capabilities = {
      skills: skills.map(({ name, description }) => ({
        name,
        description,
        managed: importedSkills().includes(name),
        enabled: !disabledSkills().includes(name),
      })),
      plugins: plugins.map(({ name, source, version }) => ({ name, source, version, managed: importedPluginNames().includes(name) })),
      mcpServers: [...managed, ...others],
    };
    cache.set(cwd, { at: Date.now(), value });
    return value;
  } finally {
    q.close();
  }
}
