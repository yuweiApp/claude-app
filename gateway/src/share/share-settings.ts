import path from "node:path";
import { config } from "../config.js";
import { readJson, writeJson } from "../json-file.js";
import { getConnection } from "../ssh/connections.js";
import type { ShareSettingsInput } from "../shared/types.js";
import { BadRequestError } from "../errors.js";

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

const DEFAULTS: ShareSettings = { server: { host: "", sshPort: 22, username: "", remotePort: 8790 } };

let current: ShareSettings = readJson(FILE, DEFAULTS);
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
  const connectionId = (input.connectionId ?? "").trim();
  if (connectionId && !getConnection(connectionId)) throw new BadRequestError("选的 SSH 连接不存在（可能已经在设置里删掉了）");
  const host = connectionId ? "" : input.host.trim();
  const username = connectionId ? "" : input.username.trim();
  const sshPort = connectionId ? 22 : port(input.sshPort, "SSH 端口");
  const remotePort = port(input.remotePort, "公网端口");
  const off = !connectionId && !host && !username;
  if (!connectionId && (!off || requireServer)) {
    if (!host) throw new BadRequestError("请填服务器地址");
    if (/[\s/@]/.test(host)) throw new BadRequestError("服务器地址只填 IP 或域名，用户名、端口填在各自的框里");
    if (!username) throw new BadRequestError("请填用户名");
  }
  const password = off ? "" : (input.password ?? prev.password ?? "");
  const identityFile = input.identityFile.trim();
  const publicHost = input.publicHost
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
  writeJson(FILE, current);
  for (const listener of listeners) listener();
}

/** 第一次连上服务器时记下主机密钥指纹（不算改设置，不通知） */
export function rememberFingerprint(host: string, sshPort: number, fingerprint: string): void {
  if (current.server.connectionId || current.server.host !== host || current.server.sshPort !== sshPort || current.server.fingerprint) return;
  current = { ...current, server: { ...current.server, fingerprint } };
  writeJson(FILE, current);
}

function port(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new BadRequestError(`${name}要是 1–65535 的整数`);
  return n;
}
