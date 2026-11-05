import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../agent/session-manager.js";
import type { ProjectEntry } from "../../shared/types.js";

const run = promisify(execFile);
const LIMIT = 50;
/** 不是 git 仓库时自己遍历，跳过这些文件夹，最多收这么多个文件 */
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target", ".cache"]);
const MAX_FILES = 20000;
/** 输入 @ 后每敲一个字都会来查，文件列表缓存一会儿 */
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; entries: Promise<ProjectEntry[]> }>();

/**
 * GET /files?cwd=&q=：输入框里 @ 引用文件用。
 * q 为空列项目文件夹第一层；q 以 / 结尾且是文件夹时列这个文件夹；否则在整个项目里搜（git 仓库按 .gitignore 过滤）
 */
export function fileRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { cwd?: string; q?: string } }>("/files", async (req) => {
    const cwd = req.query.cwd;
    if (!cwd || !path.isAbsolute(cwd)) throw new BadRequestError("缺少项目文件夹");
    const q = (req.query.q ?? "").trim();
    if (!q || q.endsWith("/")) {
      const dir = path.resolve(cwd, q);
      if (dir === cwd || dir.startsWith(cwd + path.sep)) {
        const listed = await listDir(cwd, dir);
        if (listed) return { entries: listed };
      }
    }
    return { entries: search(await projectEntries(cwd), q) };
  });
}

/** 一个文件夹的直接子项，文件夹在前；不是文件夹时返回 null */
async function listDir(cwd: string, dir: string): Promise<ProjectEntry[] | null> {
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!dirents) return null;
  return dirents
    .filter((d) => d.name !== ".git")
    .map((d) => {
      const rel = path.relative(cwd, path.join(dir, d.name)).split(path.sep).join("/");
      const isDir = d.isDirectory();
      return { path: isDir ? `${rel}/` : rel, dir: isDir };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
}

function projectEntries(cwd: string): Promise<ProjectEntry[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries;
  const entries = listFiles(cwd).then(withDirs);
  cache.set(cwd, { at: Date.now(), entries });
  entries.catch(() => cache.delete(cwd));
  return entries;
}

/** 项目里的文件（相对路径，/ 分隔）：git 仓库用 git ls-files（含未跟踪、不含忽略的），否则自己遍历 */
async function listFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split("\0").filter(Boolean);
  } catch {
    const files: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      const dirents = await readdir(path.join(cwd, rel), { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        if (files.length >= MAX_FILES) return;
        const child = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (!SKIP.has(d.name)) await walk(child);
        } else files.push(child);
      }
    };
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new BadRequestError(`文件夹不存在：${cwd}`);
    await walk("");
    return files;
  }
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
function search(entries: ProjectEntry[], q: string): ProjectEntry[] {
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
