import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

// 按优先级从低到高覆盖：.env.local > .env > 系统环境变量
for (const file of [".env", ".env.local"]) {
  if (existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, "utf8")));
}

const env = process.env;
const gatewayRoot = path.resolve(import.meta.dirname, "..");

/**
 * 各平台放应用数据的目录：Windows 是 %LOCALAPPDATA%，macOS 是 ~/Library/Application Support，其他是 $XDG_DATA_HOME 或 ~/.local/share。
 * 普通会话的工作目录放在这里：不在临时目录（系统会清理，AI 产出的文件会丢，resume 时工作目录也没了），
 * 也不在网关的目录里（网关在 git 仓库里，Claude Code 会把仓库的 git 状态和最近提交放进系统提示）
 */
function userDataDir(): string {
  if (process.platform === "win32") return env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

function int(name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`环境变量 ${name} 必须是整数，当前为 "${raw}"`);
  return n;
}

function regex(name: string): RegExp | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  try {
    return new RegExp(raw, "i");
  } catch (err) {
    throw new Error(`环境变量 ${name} 不是有效的正则表达式："${raw}"（${(err as Error).message}）`);
  }
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

  /** 普通会话（没选文件夹）的工作目录都建在这下面，上传的附件也在这里，默认是用户数据目录下的 claude-app/workspace（见 userDataDir） */
  workspaceDir: path.resolve(env.WORKSPACE_DIR || path.join(userDataDir(), "claude-app", "workspace")),
  /** Claude Code 的配置目录（会话记录、settings、skills、memory），和本机自己用的 ~/.claude 分开 */
  claudeConfigDir: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(gatewayRoot, ".data", "claude-home")),
  /** 桌面操作（agent-desktop）的状态目录（快照、ref），传给它的 AGENT_DESKTOP_HOME，不用本机的 ~/.agent-desktop */
  agentDesktopHome: path.resolve(env.AGENT_DESKTOP_HOME || path.join(gatewayRoot, ".data", "agent-desktop")),

  /** 模型接口（newapi 等），不填是直连 Anthropic */
  baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
  /** 默认模型（新会话用它，模型菜单里排第一），不填时用 Claude Code 自己的默认（接第三方模型时必须填） */
  model: env.ANTHROPIC_MODEL?.trim() || undefined,
  /** 模型菜单只保留 id 匹配这个正则的（不区分大小写），例如 ^(gpt|deepseek|kimi)；不填时只按通用规则去掉非对话模型 */
  modelsFilter: regex("MODELS_FILTER"),
  /** 新会话的权限模式，默认完全访问（bypassPermissions，所有操作不询问） */
  defaultPermissionMode: permissionMode("DEFAULT_PERMISSION_MODE", "bypassPermissions"),
  /** 新会话和续接会话的推理强度，同 Claude 桌面版启动参数里的 --effort=high */
  defaultEffort: effortLevel("DEFAULT_EFFORT", "high"),
  /** 禁用的内置工具。WebSearch 是 Anthropic 服务端工具，第三方模型用不了 */
  disallowedTools: list("DISALLOWED_TOOLS", ["WebSearch"]),
  /** 追加到 Claude Code 系统提示后面的说明，不设或设成空串就不追加（为什么要加见 .env.example） */
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

  /** 对话日志：用户的原始内容和模型的实际响应，见 src/logging/conversation-log.ts */
  conversationLog: {
    enabled: env.LOG_ENABLED !== "0",
    dir: path.resolve(env.LOG_DIR || path.join(gatewayRoot, ".data", "logs")),
    maxFileBytes: int("LOG_MAX_FILE_MB", 20) * 1024 * 1024,
    maxTotalBytes: int("LOG_MAX_TOTAL_MB", 500) * 1024 * 1024,
    retentionDays: int("LOG_RETENTION_DAYS", 14),
    maxEntryBytes: int("LOG_MAX_ENTRY_KB", 512) * 1024,
  },
};

// listSessions() / getSessionMessages() 在网关进程里读会话文件，也按 CLAUDE_CONFIG_DIR 找目录
process.env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;

/** MCP 工具调用跑多久后自动转到后台（见 agentEnv），浏览器工具的说明里也用到 */
export const MCP_AUTO_BACKGROUND_MS = 20_000;

/**
 * 传给 claude 子进程的环境变量：继承网关的环境（ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 等原样透传），
 * 再固定配置目录、关掉非必要的外发流量。
 * 接第三方接口时，Claude Code 的 opus / sonnet / haiku 档位（后台小任务如生成标题、WebFetch 总结用 haiku）
 * 默认会请求 claude-* 模型，接口里没有，所以都指向默认模型（环境里自己设了的不覆盖）
 */
export function agentEnv(): Record<string, string | undefined> {
  const tiers =
    config.baseUrl && config.model
      ? Object.fromEntries(
          ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"].map((k) => [k, env[k] || config.model]),
        )
      : {};
  // 外部浏览器的扩展 token（以前写在 .env.local 的 Chrome、Edge 的，现在在设置页填，见 browser/browser-settings.ts）只给网关自己连浏览器用：模型拿到它就能在 Bash 里另起 Playwright
  // 不经提示操作用户的浏览器，绕过外部浏览器工具的权限卡片
  const { PLAYWRIGHT_MCP_EXTENSION_TOKEN: _token, PLAYWRIGHT_MCP_EDGE_EXTENSION_TOKEN: _edgeToken, ...inherited } = process.env;
  return {
    ...inherited,
    ...tiers,
    CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
    // 上下文多大（token）：只对 Claude Code 不认识的模型名（不是 claude- 开头的，如 gpt-6-luna、qwen）生效，
    // Claude 官方模型按它自己的模型表。没设时 Claude Code 也是按 200000 算，这里写明，要改在 .env.local 里设，
    // 要和模型实际支持的一致：设大了请求会在模型那边超限报错，而不是及时压缩上下文
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? "200000",
    CLAUDE_AGENT_SDK_CLIENT_APP: "claude-app-gateway/0.1.0",
    // 跑得久的工具调用自动转到后台（同 Claude Code 终端里的 Ctrl+B）：工具先返回「在后台运行」，这一轮接着走，
    // 模型可以先回复用户；跑完后结果以 task_notification 送回来，会话空闲时会自动开始新的一轮。
    // Claude Code 在非交互会话（SDK）里默认不自动转，要设 CLAUDE_AUTO_BACKGROUND_TASKS；它也管 Bash 和子代理。
    // MCP 调用（浏览器的 browser_run_code 等）多久后转由 CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS 定，默认 120 秒，这里改成 20 秒
    CLAUDE_AUTO_BACKGROUND_TASKS: env.CLAUDE_AUTO_BACKGROUND_TASKS ?? "1",
    CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS ?? String(MCP_AUTO_BACKGROUND_MS),
    ...(process.platform === "win32" ? windowsBashEnv(inherited.BASH_ENV) : {}),
  };
}

/**
 * Windows 上 Claude Code 的 Bash 工具跑的是 Git Bash，模型在里面调 powershell.exe、ipconfig 等原生程序时，
 * 它们按控制台代码页输出（中文系统是 936，GBK），Claude Code 按 UTF-8 读，中文全成了乱码。
 * 用 BASH_ENV 让每次起 bash 时先 chcp 65001，原生程序就输出 UTF-8（Claude Code 自己的 PowerShell 工具也是先 chcp 65001 再起 PowerShell）。
 * 环境里原来有 BASH_ENV 的，执行完再接着 source 它
 */
function windowsBashEnv(userBashEnv: string | undefined): Record<string, string> {
  const file = path.join(config.claudeConfigDir, "claude-app-bash-env.sh");
  if (!bashEnvWritten) {
    mkdirSync(config.claudeConfigDir, { recursive: true });
    // bash 读不了 CRLF，换行写死成 \n
    writeFileSync(
      file,
      [
        "# claude-app 网关生成（config.ts 的 windowsBashEnv），Bash 工具起 bash 时先执行：控制台代码页切到 UTF-8",
        'chcp.com 65001 >/dev/null 2>&1',
        'if [ -n "${CLAUDE_APP_USER_BASH_ENV:-}" ]; then . "$CLAUDE_APP_USER_BASH_ENV"; fi',
        "",
      ].join("\n"),
    );
    bashEnvWritten = true;
  }
  return {
    // Git Bash 认 C:/ 开头的路径，反斜杠换成正斜杠省得转义
    BASH_ENV: file.replaceAll("\\", "/"),
    ...(userBashEnv ? { CLAUDE_APP_USER_BASH_ENV: userBashEnv } : {}),
  };
}
let bashEnvWritten = false;
