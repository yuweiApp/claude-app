import path from "node:path";
import type { McpHttpServerConfig, McpSSEServerConfig, McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { readJson, writeJson } from "../json-file.js";
import type { ConnectorRef, McpServerInput } from "../shared/types.js";

export type McpConfig = McpStdioServerConfig | McpHttpServerConfig | McpSSEServerConfig;

interface StoredServer {
  enabled: boolean;
  config: McpConfig;
  /** 从连接器市场添加的 */
  connector?: ConnectorRef;
}

/** 设置页添加的 MCP 服务器，存在 Claude Code 配置目录下；请求头、环境变量里可能有令牌，文件权限 600 */
const file = () => path.join(config.claudeConfigDir, "gateway-mcp-servers.json");

export const readMcpServers = (): Record<string, StoredServer> => readJson(file(), {});

const write = (servers: Record<string, StoredServer>) => writeJson(file(), servers);

/** 传给 query 的 mcpServers：启用的服务器 */
export function enabledMcpServers(): Record<string, McpConfig> {
  return Object.fromEntries(
    Object.entries(readMcpServers())
      .filter(([, server]) => server.enabled)
      .map(([name, server]) => [name, server.config]),
  );
}

function toConfig(input: McpServerInput): McpConfig {
  if (input.type === "stdio") return { type: "stdio", command: input.command!, args: input.args ?? [], env: input.env };
  return { type: input.type, url: input.url!, headers: input.headers };
}

/** 添加，或用同样的名字覆盖（设置页手动添加的重名由接口先拒绝）；不传 connector 时保留原来记的 */
export function saveMcpServer(input: McpServerInput, connector?: ConnectorRef): void {
  const servers = readMcpServers();
  const previous = servers[input.name];
  const ref = connector ?? previous?.connector;
  servers[input.name] = { enabled: previous?.enabled ?? true, config: toConfig(input), ...(ref ? { connector: ref } : {}) };
  write(servers);
}

/** 设置页编辑时填进表单的配置；不是设置页添加的返回 undefined */
export function readMcpServerInput(name: string): McpServerInput | undefined {
  const config = readMcpServers()[name]?.config;
  if (!config) return undefined;
  if (config.type === "http" || config.type === "sse") return { name, type: config.type, url: config.url, ...(config.headers ? { headers: config.headers } : {}) };
  return { name, type: "stdio", command: config.command, args: config.args ?? [], ...(config.env ? { env: config.env } : {}) };
}

/**
 * 编辑设置页添加的服务器：换成新配置，启停状态和连接器市场的来源跟着走；input.name 和原来不同就是改名，旧名字删掉。
 * taken 是别处（用户范围）已经占用的名字。原来的不存在返回 "missing"，新名字已被占用返回 "conflict"
 */
export function updateMcpServer(name: string, input: McpServerInput, taken: (name: string) => boolean): "ok" | "missing" | "conflict" {
  const servers = readMcpServers();
  const previous = servers[name];
  if (!previous) return "missing";
  if (input.name !== name && (servers[input.name] || taken(input.name))) return "conflict";
  // 改名时保持原来的顺序（设置页按这个顺序列出）
  const next = Object.fromEntries(
    Object.entries(servers).map(([key, server]) =>
      key === name ? [input.name, { enabled: previous.enabled, config: toConfig(input), ...(previous.connector ? { connector: previous.connector } : {}) }] : [key, server],
    ),
  );
  write(next);
  return "ok";
}

export function setMcpServerEnabled(name: string, enabled: boolean): boolean {
  const servers = readMcpServers();
  if (!servers[name]) return false;
  servers[name].enabled = enabled;
  write(servers);
  return true;
}

export function removeMcpServer(name: string): boolean {
  const servers = readMcpServers();
  if (!servers[name]) return false;
  delete servers[name];
  write(servers);
  return true;
}
