import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "../config.js";
import type { BrowserEntry, BrowserLogo, BrowserSettingsView } from "../shared/types.js";
import { INSTALL_URL, KNOWN_BROWSERS, listProfiles, locateKnown, looksChromium, resolveExecutable } from "./catalog.js";

/**
 * 设置页「浏览器」的设置：哪些外部浏览器启用、用哪个配置、扩展 token、连接时建不建标签页组，还有手动添加的浏览器。
 * 存在 Claude Code 配置目录下（同 gateway-mcp-servers.json）；有 token，文件权限 600
 */
const file = () => path.join(config.claudeConfigDir, "gateway-browsers.json");

interface StoredBrowser {
  /** 手动开关过才有；没有时按默认（检测到的装了扩展才启用，手动添加的启用） */
  enabled?: boolean;
  profile?: string;
  token?: string;
}

interface CustomBrowser {
  id: string;
  name: string;
  executablePath: string;
  userDataDir?: string;
}

interface Stored {
  tabGroup?: boolean;
  browsers?: Record<string, StoredBrowser>;
  custom?: CustomBrowser[];
}

export class BrowserSettingsError extends Error {}

function read(): Stored {
  if (!existsSync(file())) return {};
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Stored;
  } catch {
    return {};
  }
}

function write(stored: Stored): void {
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  renameSync(tmp, file());
}

/** Playwright 按通道找可执行文件（表里的路径都没找到时的后备，chrome、msedge 这些它认识的） */
const registry = (createRequire(import.meta.url)("playwright-core/lib/coreBundle") as {
  registry: { registry: { findExecutable(name: string): { executablePath(): string | undefined } | undefined } };
}).registry.registry;

function findChannel(channel: string): string | undefined {
  try {
    return registry.findExecutable(channel)?.executablePath() || undefined;
  } catch {
    return undefined;
  }
}

/** 连接一个浏览器要用的：BrowserEntry 加上 token（只在网关里用，不给界面） */
export interface ResolvedBrowser extends BrowserEntry {
  token?: string;
  /** 连接时传给浏览器的 --profile-directory；undefined 是不传（浏览器自己选） */
  profileDir?: string;
}

const LETTER_COLORS = ["#4c8bf5", "#9b59b6", "#16a085", "#e67e22", "#e84393", "#2d98da"];

/** 现在的全部浏览器：表里检测到的（装了的）和手动添加的，按设置算出启用状态和连接用的配置 */
export function listBrowsers(): ResolvedBrowser[] {
  const stored = read();
  const result: ResolvedBrowser[] = [];
  const add = (
    base: { id: string; name: string; logo: BrowserLogo; custom: boolean; executablePath: string; userDataDir?: string; installed: boolean; chromium: boolean },
    legacy?: { token: string; profile: string },
  ) => {
    const s = stored.browsers?.[base.id] ?? {};
    const profiles = listProfiles(base.userDataDir);
    const extension = profiles.some((p) => p.extension);
    const legacyProfile = legacy ? process.env[legacy.profile] : undefined;
    const profile = s.profile ?? legacyProfile;
    // 选了的配置不在了（被删了）就当没选
    const chosen = profile !== undefined && (profiles.some((p) => p.dir === profile) || !profiles.length) ? profile : undefined;
    const fallback = profiles.find((p) => p.extension) ?? undefined;
    const profileDir = chosen ?? (fallback ? fallback.dir : undefined);
    const token = s.token || (legacy ? process.env[legacy.token] : undefined) || undefined;
    result.push({
      ...base,
      profiles,
      extension,
      ...(chosen !== undefined ? { profile: chosen } : {}),
      enabled: base.installed && (s.enabled ?? (base.custom || extension)),
      hasToken: !!token,
      ...(token ? { token } : {}),
      // dir 为空（Opera 那种）时不传 --profile-directory
      ...(profileDir ? { profileDir } : {}),
    });
  };
  for (const known of KNOWN_BROWSERS) {
    const found = locateKnown(known, findChannel);
    if (!found) continue;
    add({ id: known.id, name: known.name, logo: known.logo, custom: false, ...found, installed: true, chromium: true }, known.legacyEnv);
  }
  (stored.custom ?? []).forEach((c, i) => {
    const exe = resolveExecutable(c.executablePath);
    add({
      id: c.id,
      name: c.name,
      logo: { kind: "letter", color: LETTER_COLORS[i % LETTER_COLORS.length] },
      custom: true,
      executablePath: exe ?? c.executablePath,
      ...(c.userDataDir ? { userDataDir: c.userDataDir } : {}),
      installed: !!exe,
      chromium: exe ? looksChromium(exe) : false,
    });
  });
  return result;
}

/** 设置页用：去掉 token */
export function browserSettingsView(): BrowserSettingsView {
  return {
    tabGroup: tabGroupEnabled(),
    installUrl: INSTALL_URL,
    browsers: listBrowsers().map(({ token: _token, profileDir: _dir, ...entry }) => entry),
  };
}

/** 连接时扩展建不建标签页组，默认不建：扩展每连一次建一个新组，Chrome 会把组保存下来固定到书签栏，网关重启几次书签栏上就是一排同名的组 */
export function tabGroupEnabled(): boolean {
  return read().tabGroup === true;
}

export function setTabGroup(enabled: boolean): void {
  write({ ...read(), tabGroup: enabled });
}

/** 改一个浏览器的设置；token 传空字符串或 null 是清掉 */
export function updateBrowser(id: string, patch: { enabled?: boolean; profile?: string | null; token?: string | null }): void {
  if (!listBrowsers().some((b) => b.id === id)) throw new BrowserSettingsError("没有这个浏览器");
  const stored = read();
  const current = { ...stored.browsers?.[id] };
  if (patch.enabled !== undefined) current.enabled = patch.enabled;
  if (patch.profile !== undefined) {
    if (patch.profile === null) delete current.profile;
    else current.profile = patch.profile;
  }
  if (patch.token !== undefined) {
    const token = patch.token?.trim();
    if (token) current.token = token;
    else delete current.token;
  }
  write({ ...stored, browsers: { ...stored.browsers, [id]: current } });
}

/** 手动添加浏览器，返回它的 id 和是不是看着像 Chromium 内核 */
export function addCustomBrowser(input: { name: string; executablePath: string; userDataDir?: string }): { id: string; chromium: boolean } {
  const name = input.name.trim();
  if (!name) throw new BrowserSettingsError("请填写名字");
  if (/[[\]()@\n]/.test(name)) throw new BrowserSettingsError("名字里不能有 @、方括号和圆括号");
  const exe = resolveExecutable(input.executablePath);
  if (!exe) throw new BrowserSettingsError("找不到这个可执行文件（路径是网关这台电脑上的）");
  const userDataDir = input.userDataDir?.trim() || undefined;
  if (userDataDir && !existsSync(userDataDir)) throw new BrowserSettingsError("找不到这个用户数据目录");
  const stored = read();
  const custom = stored.custom ?? [];
  const taken = new Set([...KNOWN_BROWSERS.map((b) => b.id), ...custom.map((c) => c.id)]);
  if ([...KNOWN_BROWSERS, ...custom].some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new BrowserSettingsError("已经有同名的浏览器");
  let n = 1;
  while (taken.has(`custom${n}`)) n++;
  const id = `custom${n}`;
  write({ ...stored, custom: [...custom, { id, name, executablePath: input.executablePath.trim(), ...(userDataDir ? { userDataDir } : {}) }] });
  return { id, chromium: looksChromium(exe) };
}

export function removeCustomBrowser(id: string): void {
  const stored = read();
  if (!stored.custom?.some((c) => c.id === id)) throw new BrowserSettingsError("没有这个手动添加的浏览器");
  const { [id]: _removed, ...browsers } = stored.browsers ?? {};
  write({ ...stored, custom: stored.custom.filter((c) => c.id !== id), browsers });
}
