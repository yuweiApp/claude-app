import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getConnection } from "../ssh/connections.js";
import type { ShareSettingsInput } from "../shared/types.js";

/**
 * 设置页「公网分享」（见 docs/lan-share.md「公网分享」）：用「SSH 连接」里的哪个连接，或者手动填的服务器地址、账号；公网端口。
 * 没配置（没选连接、地址和用户名都空）时没有公网分享。
 * 存在 $CLAUDE_CONFIG_DIR/gateway-share.json（600），密码也存（断线、网关重启后要自己重连），不回给网页
 */
const FILE = path.join(config.claudeConfigDir, "gateway-share.json");

export interface ShareServer {
  /** 设置「SSH 连接」里的连接：地址、账号、密钥、跳板、主机密钥都按它的，下面的 host、username、fingerprint 不用 */
  connectionId?: string;
  host: string;
  sshPort: number;
  username: string;
  password?: string;
  identityFile?: string;
  remotePort: number;
  publicHost?: string;
  fingerprint?: string;
}

export interface ShareSettings {
  server: ShareServer;
}

export class ShareSettingsError extends Error {}

const DEFAULTS: ShareSettings = { server: { host: "", sshPort: 22, username: "", remotePort: 8790 } };

let current: ShareSettings = load();
const listeners = new Set<() => void>();

export function shareSettings(): ShareSettings {
  return current;
}

/** 选了 SSH 连接，或者填了服务器地址和用户名，才有公网分享 */
export function shareConfigured(): boolean {
  const s = current.server;
  return s.connectionId ? Boolean(getConnection(s.connectionId)) : Boolean(s.host && s.username);
}

export function onShareSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 按请求体算出要存的设置（还没存）：password 不传时沿用已存的；地址、端口换了就忘掉记下的指纹。
 * 地址、用户名都空是不用公网分享（密码一起清掉）；requireServer（测试连接）时必须填
 */
export function settingsFrom(input: ShareSettingsInput, requireServer = false): ShareSettings {
  const prev = current.server;
  const connectionId = String(input.connectionId ?? "").trim();
  if (connectionId && !getConnection(connectionId)) throw new ShareSettingsError("选的 SSH 连接不存在（可能已经在设置里删掉了）");
  const host = connectionId ? "" : String(input.host ?? "").trim();
  const username = connectionId ? "" : String(input.username ?? "").trim();
  const sshPort = connectionId ? 22 : port(input.sshPort, "SSH 端口");
  const remotePort = port(input.remotePort, "公网端口");
  const off = !connectionId && !host && !username;
  if (!connectionId && (!off || requireServer)) {
    if (!host) throw new ShareSettingsError("请填服务器地址");
    if (/[\s/@]/.test(host)) throw new ShareSettingsError("服务器地址只填 IP 或域名，用户名、端口填在各自的框里");
    if (!username) throw new ShareSettingsError("请填用户名");
  }
  const password = off ? "" : (input.password ?? prev.password ?? "");
  const identityFile = String(input.identityFile ?? "").trim();
  const publicHost = String(input.publicHost ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const sameHost = !connectionId && !prev.connectionId && host === prev.host && sshPort === prev.sshPort;
  const fingerprint = input.forgetFingerprint || !sameHost ? undefined : prev.fingerprint;
  return {
    server: {
      ...(connectionId ? { connectionId } : {}),
      host,
      sshPort,
      username,
      remotePort,
      ...(password ? { password } : {}),
      ...(identityFile ? { identityFile } : {}),
      ...(publicHost ? { publicHost } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    },
  };
}

export function saveShareSettings(next: ShareSettings): void {
  current = next;
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
  for (const listener of listeners) listener();
}

/** 第一次连上服务器时记下主机密钥指纹（不算改设置，不通知） */
export function rememberFingerprint(host: string, sshPort: number, fingerprint: string): void {
  if (current.server.connectionId || current.server.host !== host || current.server.sshPort !== sshPort || current.server.fingerprint) return;
  current = { ...current, server: { ...current.server, fingerprint } };
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
}

function port(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ShareSettingsError(`${name}要是 1–65535 的整数`);
  return n;
}

function load(): ShareSettings {
  try {
    if (!existsSync(FILE)) return DEFAULTS;
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<ShareSettings>;
    const s = (raw.server ?? {}) as Partial<ShareServer>;
    return {
      server: {
        ...(typeof s.connectionId === "string" && s.connectionId ? { connectionId: s.connectionId } : {}),
        host: typeof s.host === "string" ? s.host : "",
        sshPort: Number.isInteger(s.sshPort) ? s.sshPort! : 22,
        username: typeof s.username === "string" ? s.username : "",
        remotePort: Number.isInteger(s.remotePort) ? s.remotePort! : 8790,
        ...(typeof s.password === "string" && s.password ? { password: s.password } : {}),
        ...(typeof s.identityFile === "string" && s.identityFile ? { identityFile: s.identityFile } : {}),
        ...(typeof s.publicHost === "string" && s.publicHost ? { publicHost: s.publicHost } : {}),
        ...(typeof s.fingerprint === "string" && s.fingerprint ? { fingerprint: s.fingerprint } : {}),
      },
    };
  } catch {
    return DEFAULTS;
  }
}
