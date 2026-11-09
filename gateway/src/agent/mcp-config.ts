import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpHttpServerConfig, McpSSEServerConfig, McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import type { ConnectorRef, McpServerInput } from "../shared/types.js";

export type McpConfig = McpStdioServerConfig | McpHttpServerConfig | McpSSEServerConfig;

interface StoredServer {
  enabled: boolean;
  config: McpConfig;
  /** 从连接器目录添加的 */
  connector?: ConnectorRef;
}

/** 设置页添加的 MCP 服务器，存在 Claude Code 配置目录下；请求头、环境变量里可能有令牌，文件权限 600 */
const file = () => path.join(config.claudeConfigDir, "gateway-mcp-servers.json");

export function readMcpServers(): Record<string, StoredServer> {
  if (!existsSync(file())) return {};
  return JSON.parse(readFileSync(file(), "utf8")) as Record<string, StoredServer>;
}

function write(servers: Record<string, StoredServer>): void {
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(servers, null, 2), { mode: 0o600 });
  renameSync(tmp, file());
}

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

/** 添加，或用同样的名字覆盖；不传 connector 时保留原来记的（在设置页里改了请求头之类的，仍算那个连接器） */
export function saveMcpServer(input: McpServerInput, connector?: ConnectorRef): void {
  const servers = readMcpServers();
  const previous = servers[input.name];
  const ref = connector ?? previous?.connector;
  servers[input.name] = { enabled: previous?.enabled ?? true, config: toConfig(input), ...(ref ? { connector: ref } : {}) };
  write(servers);
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
