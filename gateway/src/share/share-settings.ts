import path from "node:path";
import { config } from "../config.js";
import { readJson, writeJson } from "../json-file.js";
import { getConnection } from "../ssh/connections.js";
import type { ShareSettingsInput } from "../shared/types.js";
import { BadRequestError } from "../errors.js";

/**
 * 设置页「公网分享」（见 docs/lan-share.md「公网分享」）：用「SSH 连接」里的哪个连接（地址、账号、密钥、跳板、主机密钥都按它的）、
 * 公网端口、链接里的地址。没选连接时没有公网分享。
 * 存在 $CLAUDE_CONFIG_DIR/gateway-share.json（600），密码也存（断线、网关重启后要自己重连），不回给网页
 */
const FILE = path.join(config.claudeConfigDir, "gateway-share.json");

export interface ShareServer {
  connectionId?: string;
  /** 这个连接用密钥、ssh-agent 登录不了时用的密码；不填时用这次在「SSH 连接」里输入过的 */
  password?: string;
  remotePort: number;
  /** 拼链接用的地址（有域名时填），没有时用连接解析出的主机 */
  publicHost?: string;
}

export interface ShareSettings {
  server: ShareServer;
}

const DEFAULTS: ShareSettings = { server: { remotePort: 8790 } };

let current: ShareSettings = readJson(FILE, DEFAULTS);
const listeners = new Set<() => void>();

export function shareSettings(): ShareSettings {
  return current;
}

/** 选了 SSH 连接（还在「SSH 连接」里）才有公网分享 */
export function shareConfigured(): boolean {
  const id = current.server.connectionId;
  return Boolean(id && getConnection(id));
}

export function onShareSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 按请求体算出要存的设置（还没存）：password 不传时沿用已存的。
 * 不选连接是不用公网分享（密码一起清掉）；requireServer（测试连接、开启 GatewayPorts）时必须选
 */
export function settingsFrom(input: ShareSettingsInput, requireServer = false): ShareSettings {
  const connectionId = input.connectionId.trim();
  if (connectionId && !getConnection(connectionId)) throw new BadRequestError("选的 SSH 连接不存在（可能已经在设置里删掉了）");
  if (!connectionId && requireServer) throw new BadRequestError("请选择 SSH 连接");
  const remotePort = Number(input.remotePort);
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new BadRequestError("公网端口要是 1–65535 的整数");
  const password = connectionId ? (input.password ?? current.server.password ?? "") : "";
  const publicHost = input.publicHost
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return {
    server: {
      ...(connectionId ? { connectionId } : {}),
      remotePort,
      ...(password ? { password } : {}),
      ...(publicHost ? { publicHost } : {}),
    },
  };
}

export function saveShareSettings(next: ShareSettings): void {
  current = next;
  writeJson(FILE, current);
  for (const listener of listeners) listener();
}
