import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

// 按优先级从低到高覆盖：.env.local > .env > 系统环境变量
for (const file of [".env", ".env.local"]) {
  if (existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, "utf8")));
}

const env = process.env;
const gatewayRoot = path.resolve(import.meta.dirname, "..");

function int(name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`环境变量 ${name} 必须是整数，当前为 "${raw}"`);
  return n;
}

function list(name: string, fallback: string[] = []): string[] {
  const raw = env[name];
  if (raw === undefined) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const permissionModes: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

function permissionMode(name: string, fallback: PermissionMode): PermissionMode {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!permissionModes.includes(raw as PermissionMode)) {
    throw new Error(`环境变量 ${name} 只能是 ${permissionModes.join(" / ")}，当前为 "${raw}"`);
  }
  return raw as PermissionMode;
}

const effortLevels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function effortLevel(name: string, fallback: EffortLevel): EffortLevel {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!effortLevels.includes(raw as EffortLevel)) throw new Error(`环境变量 ${name} 只能是 ${effortLevels.join(" / ")}，当前为 "${raw}"`);
  return raw as EffortLevel;
}

export const config = {
  host: env.HOST || "127.0.0.1",
  port: int("PORT", 8788),
  /** 设置后所有接口要求 Authorization: Bearer <token>（SSE 用 ?token=） */
  apiToken: env.API_TOKEN?.trim() || undefined,

  /** 智能体的工作目录，默认 gateway/.data/workspace */
  workspaceDir: path.resolve(env.WORKSPACE_DIR || path.join(gatewayRoot, ".data", "workspace")),
  /** Claude Code 的配置目录（会话记录、settings、skills、memory），和本机自己用的 ~/.claude 分开 */
  claudeConfigDir: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(gatewayRoot, ".data", "claude-home")),

  /** 主模型，不填时用 Claude Code 自己的默认（接第三方模型时必须填） */
  model: env.ANTHROPIC_MODEL?.trim() || undefined,
  defaultPermissionMode: permissionMode("DEFAULT_PERMISSION_MODE", "default"),
  /** 新会话和续接会话的推理强度，同 Claude 桌面版启动参数里的 --effort=high */
  defaultEffort: effortLevel("DEFAULT_EFFORT", "high"),
  /** 禁用的内置工具。WebSearch 是 Anthropic 服务端工具，第三方模型用不了 */
  disallowedTools: list("DISALLOWED_TOOLS", ["WebSearch"]),
  /** 追加到 Claude Code 系统提示后面的说明 */
  appendSystemPrompt: env.APPEND_SYSTEM_PROMPT?.trim() || undefined,

  /** 活跃会话空闲多久后关闭子进程，下次发消息时 resume */
  sessionIdleMs: int("SESSION_IDLE_MS", 30 * 60_000),
  /** 同时活跃的会话上限，超过时先关最久没用的空闲会话 */
  maxActiveSessions: int("MAX_ACTIVE_SESSIONS", 8),
  /** 权限请求多久没回复就自动拒绝 */
  permissionTimeoutMs: int("PERMISSION_TIMEOUT_MS", 10 * 60_000),
  /** 每个会话事件频道保留的事件数（断线续传用） */
  eventBufferSize: int("EVENT_BUFFER_SIZE", 5000),

  /** 单个上传文件的大小上限（MB） */
  maxUploadMb: int("MAX_UPLOAD_MB", 20),
};

// listSessions() / getSessionMessages() 在网关进程里读会话文件，也按 CLAUDE_CONFIG_DIR 找目录
process.env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;

/**
 * 传给 claude 子进程的环境变量：继承网关的环境（ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN、
 * ANTHROPIC_DEFAULT_*_MODEL 等原样透传），再固定配置目录、关掉非必要的外发流量
 */
export function agentEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "claude-app-gateway/0.1.0",
  };
}
