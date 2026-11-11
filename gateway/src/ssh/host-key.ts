import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * 主机密钥：第一次连接时没有记录，用户在设置页看过指纹、点了信任才连，记在连接的配置里；之后密钥变了就不连，重新确认。
 * 本机 ~/.ssh/known_hosts 里已经有这台主机、密钥也一样（用 ssh 连过）的，直接信任
 */
export interface HostKey {
  type: string;
  /** 同 ssh-keygen -l：SHA256:base64（不带 =） */
  fingerprint: string;
}

export function hostKeyOf(blob: Buffer): HostKey {
  const len = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const type = len > 0 && len < 64 && blob.length >= 4 + len ? blob.subarray(4, 4 + len).toString("ascii") : "unknown";
  return { type, fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` };
}

export class HostKeyError extends Error {
  constructor(readonly key: HostKey, readonly changed: boolean) {
    super(changed ? "主机密钥和上次信任的不一样，确认是同一台主机后再信任" : "第一次连接这台主机，确认指纹后信任");
  }
}

/** known_hosts 里这台主机记的是不是这把密钥；name 是 HostKeyAlias 或主机名，非 22 端口写成 [host]:port */
export async function knownHostsHas(files: string[], hostname: string, port: number, blob: Buffer): Promise<boolean> {
  const name = port === 22 ? hostname : `[${hostname}]:${port}`;
  const key = blob.toString("base64");
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      // @cert-authority、@revoked 这类标记不处理
      if (parts[0]!.startsWith("@")) continue;
      const [patterns, , b64] = parts;
      if (b64 === key && patterns && matches(patterns, name)) return true;
    }
  }
  return false;
}

function matches(patterns: string, name: string): boolean {
  if (patterns.startsWith("|1|")) {
    const [, , salt, hash] = patterns.split("|");
    if (!salt || !hash) return false;
    return createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest("base64") === hash;
  }
  let hit = false;
  for (const p of patterns.split(",")) {
    const negate = p.startsWith("!");
    const re = new RegExp(`^${(negate ? p.slice(1) : p).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    if (re.test(name)) {
      if (negate) return false;
      hit = true;
    }
  }
  return hit;
}
