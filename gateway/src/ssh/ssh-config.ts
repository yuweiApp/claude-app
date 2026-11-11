import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SshConfigHost, SshConnectionInput } from "../shared/types.js";

/**
 * 连接参数交给本机 OpenSSH 解析（`ssh -G`）：~/.ssh/config 里的别名、HostName、User、Port、IdentityFile、ProxyJump 都按 ssh 自己的规则算，
 * 不自己解析。Windows 10 起、macOS、Linux 都自带 ssh；没有 ssh 时按 user@host 自己拆
 */
export interface ResolvedTarget {
  hostname: string;
  port: number;
  user: string;
  identityFiles: string[];
  /** 只用 identityFiles 里的密钥（IdentitiesOnly yes） */
  identitiesOnly: boolean;
  proxyJump?: string;
  proxyCommand?: string;
  knownHostsFiles: string[];
  /** known_hosts 里按这个名字记（HostKeyAlias） */
  hostKeyAlias?: string;
}

export const sshBin = () => process.env.SSH_BIN?.trim() || "ssh";

export const expandHome = (p: string) => (p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p);

function runSshG(input: SshConnectionInput): Promise<string | null> {
  const args = ["-G"];
  if (input.port) args.push("-p", String(input.port));
  if (input.identityFile) args.push("-i", expandHome(input.identityFile));
  args.push("--", input.host);
  return new Promise((resolve) => {
    execFile(sshBin(), args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function resolveTarget(input: SshConnectionInput): Promise<ResolvedTarget> {
  const out = await runSshG(input);
  if (out === null) {
    // 没有 ssh 命令：user@host
    const at = input.host.lastIndexOf("@");
    return {
      hostname: at === -1 ? input.host : input.host.slice(at + 1),
      user: at === -1 ? os.userInfo().username : input.host.slice(0, at),
      port: input.port ?? 22,
      identityFiles: input.identityFile ? [expandHome(input.identityFile)] : ["id_ed25519", "id_ecdsa", "id_rsa"].map((n) => path.join(os.homedir(), ".ssh", n)),
      identitiesOnly: Boolean(input.identityFile),
      knownHostsFiles: [path.join(os.homedir(), ".ssh", "known_hosts")],
    };
  }
  const values = new Map<string, string[]>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    values.set(key, [...(values.get(key) ?? []), m[2]!]);
  }
  const one = (k: string) => values.get(k)?.[0];
  const none = (v: string | undefined) => (!v || v.toLowerCase() === "none" ? undefined : v);
  // -i 指定的排在最前面（ssh 也是先用它）
  const identityFiles = [...new Set((values.get("identityfile") ?? []).map(expandHome))];
  return {
    hostname: one("hostname") ?? input.host,
    port: Number(one("port") ?? input.port ?? 22),
    user: one("user") ?? os.userInfo().username,
    identityFiles,
    identitiesOnly: one("identitiesonly") === "yes",
    proxyJump: none(one("proxyjump")),
    proxyCommand: none(one("proxycommand")),
    knownHostsFiles: (values.get("userknownhostsfile") ?? []).flatMap((v) => v.split(/\s+/)).map(expandHome),
    hostKeyAlias: none(one("hostkeyalias")),
  };
}

/** 本机 ~/.ssh/config 里的主机（跟着 Include 读，跳过带通配符的），设置页添加连接时可以直接选 */
export function configHosts(): SshConfigHost[] {
  const hosts = new Map<string, SshConfigHost>();
  const visited = new Set<string>();
  const sshDir = path.join(os.homedir(), ".ssh");
  const read = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    let text: string;
    try {
      if (!statSync(file).isFile()) return;
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    let current: SshConfigHost[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1]!.toLowerCase();
      const args = m[2]!.split(/\s+/).map((a) => a.replace(/^"|"$/g, ""));
      if (key === "include") {
        for (const pattern of args) for (const f of globFiles(path.isAbsolute(expandHome(pattern)) ? expandHome(pattern) : path.join(sshDir, pattern))) read(f);
      } else if (key === "host") {
        current = args.filter((a) => !/[!*?[\]]/.test(a)).map((alias) => hosts.get(alias) ?? { alias });
        for (const h of current) hosts.set(h.alias, h);
      } else if (key === "match") {
        current = [];
      } else if (key === "hostname") {
        for (const h of current) h.hostname ??= args[0];
      } else if (key === "user") {
        for (const h of current) h.user ??= args[0];
      } else if (key === "port") {
        for (const h of current) h.port ??= Number(args[0]) || undefined;
      }
    }
  };
  read(path.join(sshDir, "config"));
  return [...hosts.values()].filter((h) => (h.hostname ?? h.alias) !== "github.com");
}

/** Include 里的通配（只在最后一级） */
function globFiles(pattern: string): string[] {
  if (!/[*?]/.test(pattern)) return existsSync(pattern) ? [pattern] : [];
  const dir = path.dirname(pattern);
  const re = new RegExp(`^${path.basename(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  try {
    return readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}
