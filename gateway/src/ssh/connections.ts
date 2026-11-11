import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { SshConnectionInput } from "../shared/types.js";
import { configHosts } from "./ssh-config.js";

/** 连上过之后记下的远端信息：会话列表在没连上时也要认出远端的普通会话（scratch 目录在远端用户目录下） */
export interface RemoteFacts {
  /** darwin-arm64、linux-x64 这样，和 SDK 的平台包名一致 */
  platform: string;
  home: string;
}

/** 网关记下的、连接以后才有的信息 */
interface Learned {
  /** 用户确认信任过的主机密钥 */
  hostKey?: { type: string; fingerprint: string };
  facts?: RemoteFacts;
}

/** 一个 SSH 连接：设置页添加的（存在 gateway-ssh-connections.json），或者本机 ~/.ssh/config 里的主机（fromConfig） */
export interface SshConnection extends SshConnectionInput, Learned {
  id: string;
  /** 来自 ~/.ssh/config：不存配置，设置页里只能连接、断开，要改就改那个文件 */
  fromConfig?: boolean;
  /** ~/.ssh/config 里写的 user@hostname:port */
  address?: string;
}

interface FileShape {
  connections: SshConnection[];
  /** ~/.ssh/config 里的主机（按别名）连接后记下的信息 */
  configHosts?: Record<string, Learned>;
}

const FILE = path.join(config.claudeConfigDir, "gateway-ssh-connections.json");
/** ~/.ssh/config 每次都读太频繁（会话列表里每个远程会话都要查连接），缓存一会儿 */
const CONFIG_CACHE_MS = 5_000;

export class SshConfigError extends Error {}

let cache: FileShape | null = null;
let configCache: { at: number; hosts: ReturnType<typeof configHosts> } | null = null;

function load(): FileShape {
  if (!cache) {
    try {
      const parsed = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Partial<FileShape>) : {};
      cache = { connections: Array.isArray(parsed.connections) ? parsed.connections : [], configHosts: parsed.configHosts ?? {} };
    } catch {
      cache = { connections: [], configHosts: {} };
    }
  }
  return cache;
}

function save(next: FileShape): void {
  cache = next;
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // 已经存在的文件 writeFile 不改权限
  chmodSync(FILE, 0o600);
}

function sshConfigHosts() {
  if (!configCache || Date.now() - configCache.at > CONFIG_CACHE_MS) configCache = { at: Date.now(), hosts: configHosts() };
  return configCache.hosts;
}

/** ~/.ssh/config 里的主机的 id：按别名算，固定不变（会话的工作目录 ssh://<id>/… 里用它） */
const configId = (alias: string) => `c${createHash("sha1").update(alias).digest("hex").slice(0, 7)}`;

/**
 * 所有连接：设置页添加的在前，然后是 ~/.ssh/config 里的主机（同 Codex 桌面版、Claude 桌面版，不用再添加一遍）。
 * 设置页已经添加了同一个别名的，配置文件里的不重复列
 */
export function listConnections(): SshConnection[] {
  const { connections: saved, configHosts: learned = {} } = load();
  const used = new Set(saved.map((c) => c.host));
  const fromConfig = sshConfigHosts()
    .filter((h) => !used.has(h.alias))
    .map((h): SshConnection => ({
      id: configId(h.alias),
      name: h.alias,
      host: h.alias,
      fromConfig: true,
      address: `${h.user ? `${h.user}@` : ""}${h.hostname ?? h.alias}${h.port ? `:${h.port}` : ""}`,
      ...learned[h.alias],
    }));
  return [...saved, ...fromConfig];
}

export function getConnection(id: string): SshConnection | undefined {
  return listConnections().find((c) => c.id === id);
}

/** 检查、整理用户填的内容 */
export function normalizeInput(input: Partial<SshConnectionInput>): SshConnectionInput {
  const host = String(input.host ?? "").trim();
  if (!host || /\s/.test(host) || host.startsWith("-")) throw new SshConfigError("主机不能为空，也不能有空格（user@host、host 或 ~/.ssh/config 里的别名）");
  const port = input.port === undefined || input.port === null || String(input.port) === "" ? undefined : Number(input.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new SshConfigError("端口要是 1–65535 的整数");
  const identityFile = input.identityFile?.trim() || undefined;
  const startDirectory = input.startDirectory?.trim() || undefined;
  if (startDirectory && !startDirectory.startsWith("/") && !startDirectory.startsWith("~") && !/^[A-Za-z]:[\\/]/.test(startDirectory)) {
    throw new SshConfigError("默认目录要是绝对路径或 ~ 开头");
  }
  return {
    name: input.name?.trim() || host,
    host,
    ...(port ? { port } : {}),
    ...(identityFile ? { identityFile } : {}),
    ...(startDirectory ? { startDirectory } : {}),
  };
}

export function addConnection(input: Partial<SshConnectionInput>): SshConnection {
  const conn: SshConnection = { id: randomBytes(6).toString("hex").slice(0, 8).replace(/^[0-9]/, "s"), ...normalizeInput(input) };
  const file = load();
  save({ ...file, connections: [...file.connections, conn] });
  return conn;
}

function savedOnly(id: string): SshConnection {
  const conn = getConnection(id);
  if (!conn) throw new SshConfigError("SSH 连接不存在");
  if (conn.fromConfig) throw new SshConfigError(`「${conn.name}」来自本机的 ~/.ssh/config，要改、要删请改那个文件`);
  return conn;
}

/** 改了主机、端口就是另一台机器：信任过的密钥和远端信息作废 */
export function updateConnection(id: string, input: Partial<SshConnectionInput>): SshConnection {
  const old = savedOnly(id);
  const next = normalizeInput({ ...old, ...input });
  const moved = next.host !== old.host || next.port !== old.port;
  const conn: SshConnection = { id, ...next, ...(!moved && old.hostKey ? { hostKey: old.hostKey } : {}), ...(!moved && old.facts ? { facts: old.facts } : {}) };
  const file = load();
  save({ ...file, connections: file.connections.map((c) => (c.id === id ? conn : c)) });
  return conn;
}

export function removeConnection(id: string): void {
  savedOnly(id);
  const file = load();
  save({ ...file, connections: file.connections.filter((c) => c.id !== id) });
}

/** 记下连接后才知道的信息：设置页添加的写进它自己那一项，~/.ssh/config 里的按别名另外记 */
export function patchConnection(id: string, patch: Learned): void {
  const conn = getConnection(id);
  if (!conn) return;
  const file = load();
  if (conn.fromConfig) {
    const learned = file.configHosts ?? {};
    save({ ...file, configHosts: { ...learned, [conn.host]: { ...learned[conn.host], ...patch } } });
  } else {
    save({ ...file, connections: file.connections.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  }
}
