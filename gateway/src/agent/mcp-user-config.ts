import { execFile } from "node:child_process";
import path from "node:path";
import { agentEnv, config } from "../config.js";
import { readJson } from "../json-file.js";
import type { McpServerInput } from "../shared/types.js";
import { BadRequestError } from "../errors.js";
import { claudeExecutable } from "./plugin-market.js";

/**
 * Claude Code 用户范围（user scope）的 MCP 服务器：存在配置目录的 .claude.json 的 mcpServers 里，所有会话、终端里直接用 claude 都会加载，
 * 能力列表里 source 是 user。网关只读这个文件；改由 SDK 自带的 claude 命令行做（claude mcp remove / add-json -s user），
 * .claude.json 还存着 Claude Code 的其它状态，它自己写的时候有锁
 */

type RawConfig = Record<string, unknown>;

const file = () => path.join(config.claudeConfigDir, ".claude.json");

export function readUserMcpServers(): Record<string, RawConfig> {
  const servers = readJson<{ mcpServers?: unknown }>(file(), {}).mcpServers;
  return typeof servers === "object" && servers !== null && !Array.isArray(servers) ? (servers as Record<string, RawConfig>) : {};
}

const isRecord = (v: unknown): v is Record<string, string> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 编辑时填进表单的配置；没有这个服务器、或者类型不是 stdio / http / sse（如 ws）时返回 undefined */
export function readUserMcpServerInput(name: string): McpServerInput | undefined {
  const raw = readUserMcpServers()[name];
  if (!raw) return undefined;
  const type = raw.type ?? "stdio";
  if (type === "http" || type === "sse") {
    if (typeof raw.url !== "string") return undefined;
    return { name, type, url: raw.url, ...(isRecord(raw.headers) ? { headers: raw.headers } : {}) };
  }
  if (type !== "stdio" || typeof raw.command !== "string") return undefined;
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
  return { name, type: "stdio", command: raw.command, args, ...(isRecord(raw.env) ? { env: raw.env } : {}) };
}

/**
 * 表单的配置写回去：类型没变时保留原来配置里表单没有的项（如 oauth、timeout），表单里的项按表单的来（清空了的环境变量、请求头就去掉）；
 * 类型变了只用表单的
 */
function merge(previous: RawConfig, input: McpServerInput): RawConfig {
  const sameType = (previous.type ?? "stdio") === input.type;
  const { command: _c, args: _a, env: _e, url: _u, headers: _h, ...extra } = previous;
  const base = sameType ? extra : {};
  if (input.type === "stdio") {
    return { ...base, type: "stdio", command: input.command, args: input.args ?? [], ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}) };
  }
  return { ...base, type: input.type, url: input.url, ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}) };
}

/**
 * 跑 claude mcp …。add-json 的配置作为参数给：它的「-」（从标准输入读）在 Claude Code 会话里拉起时会被拒绝，
 * 网关从 Claude Code 的终端里起时环境里带着这个标记
 */
function cli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      claudeExecutable(),
      ["mcp", ...args],
      { env: agentEnv(), cwd: config.workspaceDir, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new BadRequestError(`claude mcp ${args[0]} 失败：${stderr.trim() || stdout.trim() || err.message}`)) : resolve(stdout)),
    );
    child.stdin?.end();
  });
}

const add = (name: string, cfg: RawConfig) => cli(["add-json", "-s", "user", name, JSON.stringify(cfg)]);
const remove = (name: string) => cli(["remove", "-s", "user", name]);

/**
 * 编辑用户范围的服务器，input.name 和 name 不同就是改名。taken 是别处（设置页添加的）已经占用的名字。
 * 同名：先删再加，加失败时把原来的加回去；改名：先加新的再删旧的，删失败时把新的删掉。
 * 原来的不存在返回 "missing"，新名字已被占用返回 "conflict"
 */
export async function updateUserMcpServer(name: string, input: McpServerInput, taken: (name: string) => boolean): Promise<"ok" | "missing" | "conflict"> {
  const servers = readUserMcpServers();
  const previous = servers[name];
  if (!previous) return "missing";
  if (input.name !== name && (servers[input.name] || taken(input.name))) return "conflict";
  const next = merge(previous, input);
  if (input.name === name) {
    await remove(name);
    try {
      await add(name, next);
    } catch (err) {
      await add(name, previous).catch(() => {});
      throw err;
    }
  } else {
    await add(input.name, next);
    try {
      await remove(name);
    } catch (err) {
      await remove(input.name).catch(() => {});
      throw err;
    }
  }
  return "ok";
}
