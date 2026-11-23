import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { readJson, writeJson } from "../json-file.js";
import type { ShareEntry } from "../shared/types.js";

/**
 * 分享的记录（见 docs/lan-share.md）：一个会话一条，局域网、公网两种分享共用一个令牌，存在 gateway-shares.json，网关重启后照旧有效。
 * 变化时通知监听者（入口据此开关监听、断开停掉的分享的连接，公网隧道据此连上、断开服务器）
 */
const FILE = path.join(config.claudeConfigDir, "gateway-shares.json");

type Listener = () => void;

/** 分享到哪：局域网（SHARE_PORT 的入口）、公网（到服务器的 SSH 反向转发连的入口） */
export type ShareScope = "lan" | "public";

export class ShareStore {
  private shares: ShareEntry[] = readJson<{ shares: ShareEntry[] }>(FILE, { shares: [] }).shares;
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

  /** 开分享，已经有这个会话的分享时沿用它的令牌 */
  add(sessionId: string, scope: ShareScope): ShareEntry {
    const existing = this.bySession(sessionId);
    if (existing) {
      if (!existing[scope]) {
        existing[scope] = true;
        this.save();
      }
      return existing;
    }
    const entry: ShareEntry = {
      sessionId,
      token: randomBytes(24).toString("base64url"),
      createdAt: new Date().toISOString(),
      lan: scope === "lan",
      public: scope === "public",
    };
    this.shares.push(entry);
    this.save();
    return entry;
  }

  /** 停止一种分享；两种都停了就删掉这条记录（令牌作废） */
  removeScope(sessionId: string, scope: ShareScope): void {
    const entry = this.bySession(sessionId);
    if (!entry?.[scope]) return;
    const other: ShareScope = scope === "lan" ? "public" : "lan";
    if (!entry[other]) return this.remove(sessionId);
    entry[scope] = false;
    this.save();
  }

  /** 停止这个会话的所有分享；没有分享时什么也不做 */
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
    writeJson(FILE, { shares: this.shares });
    for (const listener of this.listeners) listener();
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
