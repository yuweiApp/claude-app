import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { ContextSettings, ContextUsage, SessionContextInfo } from "../shared/types.js";

/**
 * 上下文窗口和自动压缩阈值：按会话设（输入框的上下文弹层），也可以设成模型的默认；都没设时用网关的默认窗口
 * （.env.local 的 CLAUDE_CODE_MAX_CONTEXT_TOKENS）和 Claude Code 自己的阈值。
 * 两项都是启动 claude 子进程时的环境变量（CLAUDE_CODE_MAX_CONTEXT_TOKENS、CLAUDE_CODE_AUTO_COMPACT_WINDOW），
 * 会话中途改不了（applyFlagSettings 的 autoCompactWindow 实测不生效），改了要重启子进程。
 * 记在 claude-home/gateway-context.json，连同每个会话最后一次取到的用量（子进程回收、网关重启后弹层照样有数）
 */

/** Claude Code 的自动压缩窗口能设的范围（小于下限按下限算，大于上限按上限算） */
const MIN_AUTO_COMPACT_WINDOW = 100_000;
const MAX_AUTO_COMPACT_WINDOW = 1_000_000;
/** 窗口能设的范围 */
const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;
/**
 * 自动压缩窗口里留给回复和摘要的部分：阈值 = 压缩窗口 − 它（实测 33000）。取到用量后按实际的（压缩窗口 − 阈值）更新
 */
const DEFAULT_BUFFER = 33_000;

/** 直连 Anthropic 时的模型别名；接第三方接口时网关把它们都指向默认模型（config.ts 的 agentEnv） */
const ALIAS = /^(default|best|opus|sonnet|haiku|opusplan)(\[1m\])?$/i;

interface SessionRecord extends Partial<ContextSettings> {
  usage?: ContextUsage;
  /** 压缩窗口 − 阈值，见 DEFAULT_BUFFER */
  buffer?: number;
}

interface Store {
  sessions: Record<string, SessionRecord>;
  models: Record<string, Partial<ContextSettings>>;
}

const file = path.join(config.claudeConfigDir, "gateway-context.json");
const store: Store = load();
let writing = Promise.resolve();

function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Store>;
    return { sessions: raw.sessions ?? {}, models: raw.models ?? {} };
  } catch {
    return { sessions: {}, models: {} };
  }
}

function save(): void {
  const text = JSON.stringify(store, null, 2);
  writing = writing.then(() => mkdir(path.dirname(file), { recursive: true }).then(() => writeFile(file, text))).catch(() => undefined);
}

/** 子进程实际用的模型名：没指定用网关的默认模型；接第三方接口时别名也指向默认模型 */
export function launchModel(model: string | undefined): string | undefined {
  if (!model) return config.model;
  return config.baseUrl && ALIAS.test(model) ? config.model : model;
}

/** Claude Code 按设的窗口算的模型：它不认识的（不是 claude- 开头的）。Claude 官方模型和别名按它自己的模型表 */
export function adjustable(model: string | undefined): boolean {
  return Boolean(model) && !/^claude-/i.test(model!) && !ALIAS.test(model!);
}

const settingsOf = (r: Partial<ContextSettings> | undefined): ContextSettings => ({
  contextWindow: r?.contextWindow ?? null,
  autoCompactPercent: r?.autoCompactPercent ?? null,
});

/** 启动子进程时用的设置：窗口（第三方模型才有）和自动压缩窗口（没设阈值时 null，用 Claude Code 自己的） */
export interface LaunchContext {
  contextWindow: number | null;
  autoCompactWindow: number | null;
}

export function resolveLaunch(sessionId: string, model: string | undefined): LaunchContext {
  if (!adjustable(model)) return { contextWindow: null, autoCompactWindow: null };
  const session = store.sessions[sessionId];
  const byModel = store.models[model!];
  const window = session?.contextWindow ?? byModel?.contextWindow ?? config.defaultContextWindow;
  const percent = session?.autoCompactPercent ?? byModel?.autoCompactPercent ?? null;
  const buffer = session?.buffer ?? DEFAULT_BUFFER;
  const compact = percent === null ? null : Math.round((window * percent) / 100) + buffer;
  return {
    contextWindow: window,
    // 压缩窗口不小于窗口时等于没设
    autoCompactWindow: compact === null || compact >= window ? null : Math.max(MIN_AUTO_COMPACT_WINDOW, Math.min(MAX_AUTO_COMPACT_WINDOW, compact)),
  };
}

/** 子进程的环境变量里要覆盖的 */
export function contextEnv(launch: LaunchContext): Record<string, string> {
  return {
    ...(launch.contextWindow !== null ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(launch.contextWindow) } : {}),
    ...(launch.autoCompactWindow !== null ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(launch.autoCompactWindow) } : {}),
  };
}

export const sameLaunch = (a: LaunchContext, b: LaunchContext) => a.contextWindow === b.contextWindow && a.autoCompactWindow === b.autoCompactWindow;

/** 上次记下的用量是刚压缩过、模型还没回复过的（重启子进程后接着这么标，见 ContextUsage.compacted） */
export function compactedSinceReply(sessionId: string): boolean {
  return Boolean(store.sessions[sessionId]?.usage?.compacted);
}

/** 记下取到的用量；buffer 是这次的（压缩窗口 − 阈值） */
export function saveUsage(sessionId: string, usage: ContextUsage, buffer: number | null): void {
  const record = (store.sessions[sessionId] ??= {});
  record.usage = usage;
  if (buffer !== null && buffer > 0) record.buffer = buffer;
  save();
}

export function setSessionContext(sessionId: string, settings: ContextSettings): void {
  const { usage, buffer } = store.sessions[sessionId] ?? {};
  store.sessions[sessionId] = { ...clean(settings), usage, buffer };
  save();
}

/** 设成模型的默认：和网关默认一样的项不记 */
export function setModelContext(model: string, settings: ContextSettings): void {
  const next = clean({ ...settings, contextWindow: settings.contextWindow === config.defaultContextWindow ? null : settings.contextWindow });
  if (Object.keys(next).length) store.models[model] = next;
  else delete store.models[model];
  save();
}

export function forgetSession(sessionId: string): void {
  if (!(sessionId in store.sessions)) return;
  delete store.sessions[sessionId];
  save();
}

/** 分叉出的会话沿用原会话的设置 */
export function copySessionContext(from: string, to: string): void {
  const record = store.sessions[from];
  if (!record) return;
  // 用量不带：分叉出的会话只有到分叉点为止的消息
  store.sessions[to] = { contextWindow: record.contextWindow, autoCompactPercent: record.autoCompactPercent, buffer: record.buffer };
  save();
}

export function contextInfo(sessionId: string, model: string | undefined, applied: LaunchContext | null): SessionContextInfo {
  const record = store.sessions[sessionId];
  return {
    model: model ?? null,
    usage: record?.usage ?? null,
    adjustable: adjustable(model),
    session: settingsOf(record),
    modelDefault: settingsOf(model ? store.models[model] : undefined),
    defaultWindow: config.defaultContextWindow,
    applied,
    limits: { minWindow: MIN_WINDOW, maxWindow: MAX_WINDOW, minAutoCompactWindow: MIN_AUTO_COMPACT_WINDOW, maxAutoCompactWindow: MAX_AUTO_COMPACT_WINDOW },
    buffer: record?.buffer ?? DEFAULT_BUFFER,
  };
}

/** 校验并去掉 null 项；超出范围的报错 */
function clean(settings: ContextSettings): Partial<ContextSettings> {
  const out: Partial<ContextSettings> = {};
  if (settings.contextWindow !== null) {
    if (!Number.isInteger(settings.contextWindow) || settings.contextWindow < MIN_WINDOW || settings.contextWindow > MAX_WINDOW) {
      throw Object.assign(new Error(`窗口大小要在 ${MIN_WINDOW} 到 ${MAX_WINDOW} 之间`), { statusCode: 400 });
    }
    out.contextWindow = settings.contextWindow;
  }
  if (settings.autoCompactPercent !== null) {
    if (!(settings.autoCompactPercent > 0 && settings.autoCompactPercent <= 100)) {
      throw Object.assign(new Error("自动压缩的百分比要在 1 到 100 之间"), { statusCode: 400 });
    }
    out.autoCompactPercent = settings.autoCompactPercent;
  }
  return out;
}
