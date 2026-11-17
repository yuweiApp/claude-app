import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { ShareEntry } from "../shared/types.js";

/**
 * 局域网分享的记录（见 docs/lan-share.md）：一个会话一条，存在 gateway-shares.json，网关重启后照旧有效。
 * 变化时通知监听者（局域网入口据此开关监听、断开停掉的分享的连接）
 */
const FILE = path.join(config.claudeConfigDir, "gateway-shares.json");

type Listener = () => void;

export class ShareStore {
  private shares: ShareEntry[] = load();
  private readonly listeners = new Set<Listener>();

  list(): ShareEntry[] {
    return [...this.shares];
  }

  byToken(token: string | undefined | null): ShareEntry | undefined {
    return token ? this.shares.find((s) => s.token === token) : undefined;
  }

  bySession(sessionId: string): ShareEntry | undefined {
    return this.shares.find((s) => s.sessionId === sessionId);
  }

  /** 开分享，已经分享了就返回原来的 */
  add(sessionId: string): ShareEntry {
    const existing = this.bySession(sessionId);
    if (existing) return existing;
    const entry: ShareEntry = { sessionId, token: randomBytes(24).toString("base64url"), createdAt: new Date().toISOString() };
    this.shares.push(entry);
    this.save();
    return entry;
  }

  /** 停止分享；没有分享时什么也不做 */
  remove(sessionId: string): void {
    const next = this.shares.filter((s) => s.sessionId !== sessionId);
    if (next.length === this.shares.length) return;
    this.shares = next;
    this.save();
  }

  /** 会话清空后换了 id：分享跟到新的 id，令牌不变（访客的链接还能用） */
  move(from: string, to: string): void {
    const entry = this.bySession(from);
    if (!entry) return;
    entry.sessionId = to;
    this.save();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private save(): void {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ shares: this.shares }, null, 2), { mode: 0o600 });
    for (const listener of this.listeners) listener();
  }
}

function load(): ShareEntry[] {
  try {
    if (!existsSync(FILE)) return [];
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as { shares?: unknown };
    if (!Array.isArray(parsed.shares)) return [];
    return parsed.shares.filter(
      (s): s is ShareEntry => typeof s?.sessionId === "string" && typeof s?.token === "string" && typeof s?.createdAt === "string",
    );
  } catch {
    return [];
  }
}

/** 本机的局域网 IPv4 地址（拼分享链接用），去掉回环和虚拟网卡常见的 169.254.x.x */
export function lanAddresses(): string[] {
  const result: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === "IPv4" && !addr.internal && !addr.address.startsWith("169.254.")) result.push(addr.address);
    }
  }
  return result;
}
