import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

/**
 * 普通会话（没选文件夹）的工作目录，同 Claude 桌面版的 scratch-workspaces：每个会话新建一个 workspace/scratch-日期-随机串，
 * AI 下载、写的文件各归各的，不混在一起。之前的普通会话工作目录就是 workspace 本身，照样算普通会话
 */
const SCRATCH = /^scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/;

/** 新建一个普通会话的工作目录 */
export async function createScratchDir(): Promise<string> {
  const now = new Date();
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  const dir = path.join(config.workspaceDir, `scratch-${date}-${randomBytes(3).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 是不是普通会话的工作目录：workspace 本身（旧会话），或者 workspace 下的 scratch-… */
export function isChatCwd(cwd: string | undefined): boolean {
  if (!cwd) return true;
  const dir = path.resolve(cwd);
  return dir === config.workspaceDir || (path.dirname(dir) === config.workspaceDir && SCRATCH.test(path.basename(dir)));
}

/** 会话记录（jsonl）所在的文件夹：Claude Code 按工作目录放在 projects/<目录名>/ 下；删会话前先找出来 */
export async function sessionRecordDir(sessionId: string): Promise<string | undefined> {
  const projects = path.join(config.claudeConfigDir, "projects");
  const dirs = await readdir(projects).catch(() => []);
  for (const name of dirs) {
    const dir = path.join(projects, name);
    if (await access(path.join(dir, `${sessionId}.jsonl`)).then(() => true, () => false)) return dir;
  }
  return undefined;
}

/**
 * 删普通会话之后：它的 scratch 目录是空的就一起删掉，里面有文件（AI 下载、写的）就留着，不替用户删文件；
 * 会话记录的文件夹（一个 scratch 目录只有这一个会话）空了也删掉。rmdir 只删空目录
 */
export async function removeScratchDirIfEmpty(cwd: string | undefined, recordDir: string | undefined): Promise<void> {
  if (!cwd || path.resolve(cwd) === config.workspaceDir || !isChatCwd(cwd)) return;
  await rmdir(cwd).catch(() => undefined);
  if (recordDir) await rmdir(recordDir).catch(() => undefined);
}
