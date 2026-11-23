import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 网关自己的 JSON 文件（设置页的设置、会话的附带记录，都在 Claude Code 配置目录下）。
 * 读：没有这个文件、读不了、不是 JSON 时给 fallback。
 * 写：先写同一个文件夹里的临时文件再改名，写到一半（磁盘满、进程被杀）不会留下坏文件；
 * 权限 600（有的存着令牌、密码），新建的临时文件改名过去，已经存在的文件也就成了 600
 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
