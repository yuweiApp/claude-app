import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { SkillDetail } from "../shared/types.js";

export class ExtensionError extends Error {}

/** Claude Code 自己会发现这个目录下的技能 */
const skillsDir = () => path.join(config.claudeConfigDir, "skills");
/** 导入的插件，通过 options.plugins 加载 */
const pluginsDir = () => path.join(config.claudeConfigDir, "gateway-plugins");

const VALID_NAME = /^[\w-][\w.-]*$/;

function checkName(name: string): void {
  if (!VALID_NAME.test(name)) throw new ExtensionError(`名称不合法：${name}`);
}

async function checkSource(source: string): Promise<string> {
  if (!path.isAbsolute(source)) throw new ExtensionError(`请选择绝对路径：${source}`);
  const dir = path.resolve(source);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new ExtensionError(`文件夹不存在：${dir}`);
  return dir;
}

/** 复制到目标目录；已经有同名的不覆盖，要先删除 */
async function install(source: string, root: string, name: string): Promise<void> {
  checkName(name);
  const target = path.join(root, name);
  if (existsSync(target)) throw new ExtensionError(`已经有同名的「${name}」，请先删除`);
  if (`${source}${path.sep}`.startsWith(`${root}${path.sep}`)) throw new ExtensionError("这个文件夹已经在导入目录里了");
  await mkdir(root, { recursive: true });
  await cp(source, target, { recursive: true });
}

/** SKILL.md 开头 --- 之间的字段 */
function frontmatter(content: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  const pairs = block.split(/\r?\n/).map((line) => /^([\w-]+):\s*(.*)$/.exec(line)).filter((m) => m !== null);
  return Object.fromEntries(pairs.map((m) => [m[1]!, m[2]!.replace(/^["']|["']$/g, "")]));
}

/** 导入技能：文件夹里要有 SKILL.md，名称取 SKILL.md 的 name，没有时取文件夹名 */
export async function importSkill(source: string): Promise<string> {
  const dir = await checkSource(source);
  const content = await readFile(path.join(dir, "SKILL.md"), "utf8").catch(() => null);
  if (content === null) throw new ExtensionError("这个文件夹里没有 SKILL.md");
  const name = frontmatter(content).name || path.basename(dir);
  await install(dir, skillsDir(), name);
  return name;
}

/** 导入插件：文件夹里要有 .claude-plugin/plugin.json，名称取它的 name */
export async function importPlugin(source: string): Promise<string> {
  const dir = await checkSource(source);
  const text = await readFile(path.join(dir, ".claude-plugin", "plugin.json"), "utf8").catch(() => null);
  if (text === null) throw new ExtensionError("这个文件夹里没有 .claude-plugin/plugin.json");
  let manifest: { name?: unknown };
  try {
    manifest = JSON.parse(text) as { name?: unknown };
  } catch {
    throw new ExtensionError("plugin.json 不是有效的 JSON");
  }
  const name = typeof manifest.name === "string" && manifest.name ? manifest.name : path.basename(dir);
  await install(dir, pluginsDir(), name);
  return name;
}

async function remove(root: string, name: string): Promise<boolean> {
  checkName(name);
  const target = path.join(root, name);
  if (!existsSync(target)) return false;
  await rm(target, { recursive: true });
  return true;
}

/** 停用记录一起清掉，否则以后导入同名技能一进来就是停用的 */
export async function removeSkill(name: string): Promise<boolean> {
  const removed = await remove(skillsDir(), name);
  if (removed) setSkillEnabled(name, true);
  return removed;
}
export const removePlugin = (name: string) => remove(pluginsDir(), name);

/** 设置页停用的技能、子代理：各存一个名字列表 */
const disabledSkillsFile = () => path.join(config.claudeConfigDir, "gateway-disabled-skills.json");
const disabledAgentsFile = () => path.join(config.claudeConfigDir, "gateway-disabled-agents.json");

const readNames = (file: string): string[] => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : []);

function setListed(file: string, name: string, listed: boolean): void {
  const names = new Set(readNames(file));
  if (listed) names.add(name);
  else names.delete(name);
  writeFileSync(file, JSON.stringify([...names], null, 2));
}

export const disabledSkills = () => readNames(disabledSkillsFile());
export const setSkillEnabled = (name: string, enabled: boolean) => setListed(disabledSkillsFile(), name, !enabled);

/** 停用的子代理：会话的 disallowedTools 里写成 Agent(名字)，模型看不到、也调用不了 */
export const disabledAgents = () => readNames(disabledAgentsFile());
export const setAgentEnabled = (name: string, enabled: boolean) => setListed(disabledAgentsFile(), name, !enabled);

/** 文件夹下（含子文件夹）的 .md 文件；dirs 是从 root 到文件所在文件夹的各级名字 */
function markdownFiles(root: string, dirs: string[] = []): { file: string; dirs: string[] }[] {
  const dir = path.join(root, ...dirs);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return markdownFiles(root, [...dirs, entry.name]);
    return entry.isFile() && entry.name.endsWith(".md") ? [{ file: path.join(dir, entry.name), dirs }] : [];
  });
}

/** 子代理的名字：文件开头的 name 字段，没有时取文件名 */
function agentName(file: string): string {
  try {
    return frontmatter(readFileSync(file, "utf8")).name || path.basename(file, ".md");
  } catch {
    return path.basename(file, ".md");
  }
}

/**
 * 子代理的定义文件，按名字对上。Claude Code 的命名（实测 2.1.322）：项目的 .claude/agents 和用户的 ~/.claude/agents 里，
 * 名字是 name 字段（没有时取文件名），子文件夹不算进名字；插件的 agents/ 里是「插件名:子文件夹:名字」。同名时项目的优先
 */
export function agentFiles(cwd: string, plugins: { name: string; path?: string }[]): Map<string, string> {
  const found = new Map<string, string>();
  const add = (name: string, file: string) => {
    if (!found.has(name)) found.set(name, file);
  };
  for (const root of [path.join(cwd, ".claude", "agents"), path.join(config.claudeConfigDir, "agents")]) {
    for (const { file } of markdownFiles(root)) add(agentName(file), file);
  }
  for (const plugin of plugins) {
    if (!plugin.path) continue;
    for (const { file, dirs } of markdownFiles(path.join(plugin.path, "agents"))) add([plugin.name, ...dirs, agentName(file)].join(":"), file);
  }
  return found;
}

function subdirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** 导入的技能的名称 */
export const importedSkills = () => subdirectories(skillsDir());
export const importedPluginNames = () => subdirectories(pluginsDir());

/** 插件 .claude-plugin/plugin.json 里的描述和作者（author 可以是字符串或 { name }）；读不到时为空 */
export function pluginManifest(dir: string): { description?: string; author?: string } {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { description?: unknown; author?: unknown };
    const author = typeof manifest.author === "string" ? manifest.author : (manifest.author as { name?: unknown } | undefined)?.name;
    return {
      ...(typeof manifest.description === "string" && manifest.description ? { description: manifest.description } : {}),
      ...(typeof author === "string" && author ? { author } : {}),
    };
  } catch {
    return {};
  }
}

/** 传给 query 的 plugins */
export const importedPlugins = () => importedPluginNames().map((name) => ({ type: "local" as const, path: path.join(pluginsDir(), name) }));

/** 插件放技能的文件夹：plugin.json 的 skills（字符串或数组，相对插件根目录）和默认的 skills/ */
function pluginSkillRoots(pluginDir: string): string[] {
  let declared: unknown;
  try {
    declared = (JSON.parse(readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as { skills?: unknown }).skills;
  } catch {
    declared = undefined;
  }
  const custom = (Array.isArray(declared) ? declared : [declared]).filter((entry): entry is string => typeof entry === "string" && entry !== "");
  return [...new Set([...custom, "skills"].map((entry) => path.resolve(pluginDir, entry)))];
}

/** 技能文件夹里的 SKILL.md：文件夹名就是技能名，或 SKILL.md 的 name 是技能名；skills 也可以直接指向一个技能文件夹 */
async function findSkillFile(roots: string[], skill: string): Promise<{ file: string; content: string } | null> {
  for (const root of roots) {
    const candidates = [path.join(root, skill, "SKILL.md"), path.join(root, "SKILL.md"), ...subdirectories(root).map((dir) => path.join(root, dir, "SKILL.md"))];
    for (const file of candidates) {
      const content = await readFile(file, "utf8").catch(() => null);
      if (content === null) continue;
      const direct = file === path.join(root, skill, "SKILL.md");
      if (direct || frontmatter(content).name === skill || (file === path.join(root, "SKILL.md") && path.basename(root) === skill)) return { file, content };
    }
  }
  return null;
}

/**
 * 技能详情：导入的、项目里的和插件里的技能读 SKILL.md；内置技能没有文件，只有列表里的描述。
 * 插件里的技能叫 插件名:技能名，pluginDir 是这个插件所在的文件夹（导入的插件不传也能找到）
 */
export async function readSkill(name: string, cwd: string, pluginDir?: string): Promise<SkillDetail | null> {
  const [first, second] = name.split(":");
  if (!first || !VALID_NAME.test(first) || (second !== undefined && !VALID_NAME.test(second))) return null;
  const roots = second
    ? pluginSkillRoots(pluginDir ?? path.join(pluginsDir(), first))
    : [skillsDir(), path.join(cwd, ".claude", "skills")];
  const found = await findSkillFile(roots, second ?? first);
  return found && { name, path: found.file, content: found.content };
}
