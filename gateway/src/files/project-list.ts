import type { ProjectEntry } from "../shared/types.js";
import { BadRequestError } from "../errors.js";
import { IMAGE_TYPES } from "./content.js";
import type { InProject } from "./project-path.js";

/** 项目里的文件列表：右侧面板文件树的一层、输入框 @ 引用时的搜索 */

/** 搜索最多返回这么多个 */
const LIMIT = 50;
/** 不是 git 仓库时自己遍历，跳过这些文件夹，最多收这么多个文件 */
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target", ".cache"]);
const MAX_FILES = 20000;
/** 输入 @ 后每敲一个字都会来查，文件列表缓存一会儿 */
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; entries: Promise<ProjectEntry[]> }>();

/** 项目里的文件变了（新建、删除、改名、上传）：下次搜索重新列 */
export const forgetProjectFiles = (key: string) => cache.delete(key);

/** 一个文件夹的直接子项，文件夹在前；不是文件夹时返回 null。withImageInfo：图片文件带上大小和修改时间（目录树的缩略图用） */
export async function listDir({ fs, p, root }: InProject, dir: string, withImageInfo = false): Promise<ProjectEntry[] | null> {
  const dirents = await fs.readdir(dir).catch(() => null);
  if (!dirents) return null;
  const entries = await Promise.all(
    dirents
      .filter((d) => d.name !== ".git")
      .map(async (d): Promise<ProjectEntry> => {
        const abs = p.join(dir, d.name);
        const rel = p.relative(root, abs).split(p.sep).join("/");
        if (d.isDirectory) return { path: `${rel}/`, dir: true };
        if (withImageInfo && IMAGE_TYPES[p.extname(d.name).toLowerCase()]) {
          const info = await fs.stat(abs).catch(() => null);
          if (info) return { path: rel, dir: false, size: info.size, mtimeMs: info.mtimeMs };
        }
        return { path: rel, dir: false };
      }),
  );
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
}

export function projectEntries(at: InProject): Promise<ProjectEntry[]> {
  const hit = cache.get(at.key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries;
  const entries = listFiles(at).then(withDirs);
  cache.set(at.key, { at: Date.now(), entries });
  entries.catch(() => cache.delete(at.key));
  return entries;
}

/** 项目里的文件（相对路径，/ 分隔）：git 仓库用 git ls-files（含未跟踪、不含忽略的），否则自己遍历 */
async function listFiles({ fs, p, root }: InProject): Promise<string[]> {
  const git = await fs.gitFiles(root);
  if (git) return git;
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const dirents = await fs.readdir(p.join(root, rel)).catch(() => []);
    for (const d of dirents) {
      if (files.length >= MAX_FILES) return;
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory) {
        if (!SKIP.has(d.name)) await walk(child);
      } else files.push(child);
    }
  };
  if (!(await fs.stat(root).catch(() => null))?.isDirectory) throw new BadRequestError(`文件夹不存在：${root}`);
  await walk("");
  return files;
}

/** 文件列表补上中间的文件夹 */
function withDirs(files: string[]): ProjectEntry[] {
  const dirs = new Set<string>();
  for (const file of files) {
    for (let i = file.indexOf("/"); i !== -1; i = file.indexOf("/", i + 1)) dirs.add(file.slice(0, i + 1));
  }
  return [...[...dirs].map((p) => ({ path: p, dir: true })), ...files.map((p) => ({ path: p, dir: false }))];
}

/** 按名字匹配排序：名字相同 > 名字开头 > 名字包含 > 路径包含 > 名字按顺序含这些字；同档短路径在前 */
export function search(entries: ProjectEntry[], q: string): ProjectEntry[] {
  const needle = q.toLowerCase();
  const scored: { entry: ProjectEntry; score: number }[] = [];
  for (const entry of entries) {
    const full = entry.path.toLowerCase();
    const trimmed = entry.dir ? full.slice(0, -1) : full;
    const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    const score =
      name === needle ? 0
      : name.startsWith(needle) ? 1
      : name.includes(needle) ? 2
      : full.includes(needle) ? 3
      : isSubsequence(needle, name) ? 4
      : -1;
    if (score >= 0) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, LIMIT)
    .map((s) => s.entry);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
}
