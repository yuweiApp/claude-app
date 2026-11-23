import type { SshConnectionInfo } from "../shared/types.js";
import { getConnection, listConnections } from "./connections.js";
import { SshHost } from "./host.js";
import { BadRequestError } from "../errors.js";

/** 每个 SSH 连接一个 SshHost，用到时才建 */
const hosts = new Map<string, SshHost>();

export function sshHost(id: string): SshHost {
  let host = hosts.get(id);
  if (!host) {
    if (!getConnection(id)) throw new BadRequestError("SSH 连接不存在（可能已经在设置里删掉了）");
    host = new SshHost(id);
    hosts.set(id, host);
  }
  return host;
}

/** 连上、准备好（第一次要在远端装 Claude Code）；连不上时报 400，带上原因 */
export async function readyHost(id: string): Promise<SshHost> {
  const host = sshHost(id);
  try {
    await host.ensureReady();
  } catch (err) {
    throw new BadRequestError(`连接远程主机「${host.connection.name}」失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return host;
}

/** 已经建过的（不新建） */
export function existingHost(id: string): SshHost | undefined {
  return hosts.get(id);
}

export function connectionInfos(): SshConnectionInfo[] {
  return listConnections().map((c) => sshHost(c.id).info());
}

/** 删连接、改了主机地址时：断开，下次用时按新配置连 */
export function dropHost(id: string): void {
  hosts.get(id)?.disconnect("连接配置改了或删了");
  hosts.delete(id);
}

export function disconnectAll(): void {
  for (const host of hosts.values()) host.disconnect("网关退出");
}
