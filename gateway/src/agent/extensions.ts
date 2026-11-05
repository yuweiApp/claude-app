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

/** 设置页停用的技能 */
const disabledFile = () => path.join(config.claudeConfigDir, "gateway-disabled-skills.json");

export function disabledSkills(): string[] {
  return existsSync(disabledFile()) ? (JSON.parse(readFileSync(disabledFile(), "utf8")) as string[]) : [];
}

export function setSkillEnabled(name: string, enabled: boolean): void {
  const disabled = new Set(disabledSkills());
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  writeFileSync(disabledFile(), JSON.stringify([...disabled], null, 2));
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

/** 传给 query 的 plugins */
export const importedPlugins = () => importedPluginNames().map((name) => ({ type: "local" as const, path: path.join(pluginsDir(), name) }));

/** 技能详情：导入的和项目里的技能读 SKILL.md；内置技能没有文件，只有列表里的描述 */
export async function readSkill(name: string, cwd: string): Promise<SkillDetail | null> {
  // 插件里的技能叫 插件名:技能名
  const [first, second] = name.split(":");
  if (!first || !VALID_NAME.test(first) || (second !== undefined && !VALID_NAME.test(second))) return null;
  const files = second
    ? [path.join(pluginsDir(), first, "skills", second, "SKILL.md")]
    : [path.join(skillsDir(), first, "SKILL.md"), path.join(cwd, ".claude", "skills", first, "SKILL.md")];
  for (const file of files) {
    const content = await readFile(file, "utf8").catch(() => null);
    if (content !== null) return { name, path: file, content };
  }
  return null;
}
