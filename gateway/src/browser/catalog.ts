import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserLogo, BrowserProfile } from "../shared/types.js";

/**
 * 外部浏览器的候选表和检测：网关这台电脑上装了哪些 Chromium 内核的浏览器、各自的配置里装没装 Playwright 扩展。
 * 都是同步的文件检查（几十次 stat、读几个 JSON），会话启动时（buildOptions）和设置页打开时各检测一次，不缓存
 */

/** Playwright Extension 在 Chrome 应用商店里的 id；Edge 等也从 Chrome 应用商店装，id 一样（连接页的地址写死了这个 id） */
export const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
export const INSTALL_URL = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`;

type Platform = "win32" | "darwin" | "linux";

interface Paths {
  /** 可执行文件的候选，第一个存在的就是 */
  exe: string[];
  /** 用户数据目录（下面是 Default、Profile 1 这些配置；Opera 没有这一层，配置直接在这里） */
  userData: string;
}

export interface KnownBrowser {
  /** 也是 MCP 服务器名和引用里的来源：mcp__brave__browser_run_code、@brave[标题](网址)。只用小写字母和数字 */
  id: string;
  name: string;
  logo: BrowserLogo;
  /** Playwright 认识的通道（chrome、msedge 这些），找可执行文件时作为后备 */
  channel?: string;
  paths: Partial<Record<Platform, Paths>>;
  /** 环境变量里的旧配置（以前写在 .env.local），设置页没填时用 */
  legacyEnv?: { token: string; profile: string };
}

const home = os.homedir();
const env = process.env;
const pf = env.ProgramFiles || "C:\\Program Files";
const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
const roaming = env.APPDATA || path.join(home, "AppData", "Roaming");
const macSupport = path.join(home, "Library", "Application Support");
const linuxConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");

const win = (dirs: string[], rel: string, userData: string): Paths => ({ exe: dirs.map((d) => path.join(d, rel)), userData });
/** macOS 的应用：/Applications 和 ~/Applications 下的 .app 里的可执行文件 */
const mac = (app: string, exe: string, userData: string): Paths => ({
  exe: ["/Applications", path.join(home, "Applications")].map((d) => path.join(d, `${app}.app`, "Contents", "MacOS", exe)),
  userData: path.join(macSupport, userData),
});
const linux = (exe: string[], userData: string): Paths => ({ exe, userData: path.join(linuxConfig, userData) });

const CHROME: BrowserLogo = { kind: "chrome" };
const EDGE: BrowserLogo = { kind: "edge" };
const letter = (color: string): BrowserLogo => ({ kind: "letter", color });

/** 常见的 Chromium 内核浏览器。要加一个就加一行；装在别处、表里没有的，用户在设置页手动添加 */
export const KNOWN_BROWSERS: KnownBrowser[] = [
  {
    id: "chrome",
    name: "Chrome",
    logo: CHROME,
    channel: "chrome",
    legacyEnv: { token: "PLAYWRIGHT_MCP_EXTENSION_TOKEN", profile: "PLAYWRIGHT_MCP_PROFILE_DIR_NAME" },
    paths: {
      win32: win([pf, pf86, local], "Google\\Chrome\\Application\\chrome.exe", path.join(local, "Google", "Chrome", "User Data")),
      darwin: mac("Google Chrome", "Google Chrome", "Google/Chrome"),
      linux: linux(["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"], "google-chrome"),
    },
  },
  {
    id: "chromebeta",
    name: "Chrome Beta",
    logo: CHROME,
    channel: "chrome-beta",
    paths: {
      win32: win([pf, pf86, local], "Google\\Chrome Beta\\Application\\chrome.exe", path.join(local, "Google", "Chrome Beta", "User Data")),
      darwin: mac("Google Chrome Beta", "Google Chrome Beta", "Google/Chrome Beta"),
      linux: linux(["/opt/google/chrome-beta/chrome", "/usr/bin/google-chrome-beta"], "google-chrome-beta"),
    },
  },
  {
    id: "chromedev",
    name: "Chrome Dev",
    logo: CHROME,
    channel: "chrome-dev",
    paths: {
      win32: win([pf, pf86, local], "Google\\Chrome Dev\\Application\\chrome.exe", path.join(local, "Google", "Chrome Dev", "User Data")),
      darwin: mac("Google Chrome Dev", "Google Chrome Dev", "Google/Chrome Dev"),
      linux: linux(["/opt/google/chrome-unstable/chrome", "/usr/bin/google-chrome-unstable"], "google-chrome-unstable"),
    },
  },
  {
    id: "chromecanary",
    name: "Chrome Canary",
    logo: CHROME,
    channel: "chrome-canary",
    paths: {
      win32: win([local], "Google\\Chrome SxS\\Application\\chrome.exe", path.join(local, "Google", "Chrome SxS", "User Data")),
      darwin: mac("Google Chrome Canary", "Google Chrome Canary", "Google/Chrome Canary"),
    },
  },
  {
    id: "edge",
    name: "Edge",
    logo: EDGE,
    channel: "msedge",
    legacyEnv: { token: "PLAYWRIGHT_MCP_EDGE_EXTENSION_TOKEN", profile: "PLAYWRIGHT_MCP_EDGE_PROFILE_DIR_NAME" },
    paths: {
      win32: win([pf86, pf, local], "Microsoft\\Edge\\Application\\msedge.exe", path.join(local, "Microsoft", "Edge", "User Data")),
      darwin: mac("Microsoft Edge", "Microsoft Edge", "Microsoft Edge"),
      linux: linux(["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge-stable", "/usr/bin/microsoft-edge"], "microsoft-edge"),
    },
  },
  {
    id: "edgebeta",
    name: "Edge Beta",
    logo: EDGE,
    channel: "msedge-beta",
    paths: {
      win32: win([pf86, pf, local], "Microsoft\\Edge Beta\\Application\\msedge.exe", path.join(local, "Microsoft", "Edge Beta", "User Data")),
      darwin: mac("Microsoft Edge Beta", "Microsoft Edge Beta", "Microsoft Edge Beta"),
      linux: linux(["/opt/microsoft/msedge-beta/msedge", "/usr/bin/microsoft-edge-beta"], "microsoft-edge-beta"),
    },
  },
  {
    id: "edgedev",
    name: "Edge Dev",
    logo: EDGE,
    channel: "msedge-dev",
    paths: {
      win32: win([pf86, pf, local], "Microsoft\\Edge Dev\\Application\\msedge.exe", path.join(local, "Microsoft", "Edge Dev", "User Data")),
      darwin: mac("Microsoft Edge Dev", "Microsoft Edge Dev", "Microsoft Edge Dev"),
      linux: linux(["/opt/microsoft/msedge-dev/msedge", "/usr/bin/microsoft-edge-dev"], "microsoft-edge-dev"),
    },
  },
  {
    id: "edgecanary",
    name: "Edge Canary",
    logo: EDGE,
    channel: "msedge-canary",
    paths: {
      win32: win([local], "Microsoft\\Edge SxS\\Application\\msedge.exe", path.join(local, "Microsoft", "Edge SxS", "User Data")),
      darwin: mac("Microsoft Edge Canary", "Microsoft Edge Canary", "Microsoft Edge Canary"),
    },
  },
  {
    id: "brave",
    name: "Brave",
    logo: letter("#fb542b"),
    paths: {
      win32: win([pf, pf86, local], "BraveSoftware\\Brave-Browser\\Application\\brave.exe", path.join(local, "BraveSoftware", "Brave-Browser", "User Data")),
      darwin: mac("Brave Browser", "Brave Browser", "BraveSoftware/Brave-Browser"),
      linux: linux(["/opt/brave.com/brave/brave", "/usr/bin/brave-browser", "/usr/bin/brave"], "BraveSoftware/Brave-Browser"),
    },
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    logo: letter("#ef3939"),
    paths: {
      win32: win([local, pf, pf86], "Vivaldi\\Application\\vivaldi.exe", path.join(local, "Vivaldi", "User Data")),
      darwin: mac("Vivaldi", "Vivaldi", "Vivaldi"),
      linux: linux(["/opt/vivaldi/vivaldi", "/usr/bin/vivaldi-stable", "/usr/bin/vivaldi"], "vivaldi"),
    },
  },
  {
    id: "opera",
    name: "Opera",
    logo: letter("#ff1b2d"),
    paths: {
      win32: win([path.join(local, "Programs"), pf, pf86], "Opera\\opera.exe", path.join(roaming, "Opera Software", "Opera Stable")),
      darwin: mac("Opera", "Opera", "com.operasoftware.Opera"),
      linux: linux(["/usr/bin/opera", "/usr/lib/x86_64-linux-gnu/opera/opera"], "opera"),
    },
  },
  {
    id: "operagx",
    name: "Opera GX",
    logo: letter("#fa1e4e"),
    paths: {
      win32: win([path.join(local, "Programs"), pf, pf86], "Opera GX\\opera.exe", path.join(roaming, "Opera Software", "Opera GX Stable")),
      darwin: mac("Opera GX", "Opera", "com.operasoftware.OperaGX"),
    },
  },
  {
    id: "arc",
    name: "Arc",
    logo: letter("#3139fb"),
    paths: { darwin: mac("Arc", "Arc", "Arc/User Data") },
  },
  {
    id: "yandex",
    name: "Yandex",
    logo: letter("#fc3f1d"),
    paths: {
      win32: win([local], "Yandex\\YandexBrowser\\Application\\browser.exe", path.join(local, "Yandex", "YandexBrowser", "User Data")),
      darwin: mac("Yandex", "Yandex", "Yandex/YandexBrowser"),
      linux: linux(["/opt/yandex/browser/yandex-browser", "/usr/bin/yandex-browser"], "yandex-browser"),
    },
  },
  {
    id: "chromium",
    name: "Chromium",
    logo: letter("#4c8bf5"),
    paths: {
      win32: win([local, pf, pf86], "Chromium\\Application\\chrome.exe", path.join(local, "Chromium", "User Data")),
      darwin: mac("Chromium", "Chromium", "Chromium"),
      linux: linux(["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"], "chromium"),
    },
  },
  {
    id: "chrome360",
    name: "360 极速浏览器",
    logo: letter("#20a53a"),
    paths: { win32: win([local], "360Chrome\\Chrome\\Application\\360chrome.exe", path.join(local, "360Chrome", "Chrome", "User Data")) },
  },
  {
    id: "chrome360x",
    name: "360 极速浏览器 X",
    logo: letter("#20a53a"),
    paths: { win32: win([local], "360ChromeX\\Chrome\\Application\\360ChromeX.exe", path.join(local, "360ChromeX", "Chrome", "User Data")) },
  },
  {
    id: "se360",
    name: "360 安全浏览器",
    logo: letter("#2ba245"),
    paths: { win32: win([roaming], "360se6\\Application\\360se.exe", path.join(roaming, "360se6", "User Data")) },
  },
  {
    id: "qqbrowser",
    name: "QQ 浏览器",
    logo: letter("#1e9fff"),
    paths: { win32: win([pf86, pf], "Tencent\\QQBrowser\\QQBrowser.exe", path.join(local, "Tencent", "QQBrowser", "User Data")) },
  },
];

const platform = process.platform as Platform;

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** 表里这个浏览器在这台电脑上的可执行文件和用户数据目录；没装返回 null。findChannel 是 Playwright 按通道找的后备 */
export function locateKnown(browser: KnownBrowser, findChannel: (channel: string) => string | undefined): { executablePath: string; userDataDir?: string } | null {
  const paths = browser.paths[platform];
  const exe = paths?.exe.find(isFile) ?? (browser.channel ? findChannel(browser.channel) : undefined);
  if (!exe) return null;
  return { executablePath: exe, userDataDir: paths?.userData };
}

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** 这个配置里装没装扩展：扩展目录在，或者 Preferences 里有它的记录（解压加载的） */
function hasExtension(profileDir: string): boolean {
  if (existsSync(path.join(profileDir, "Extensions", EXTENSION_ID))) return true;
  return ["Preferences", "Secure Preferences"].some((file) => {
    const record = readJson(path.join(profileDir, file))?.extensions?.settings?.[EXTENSION_ID];
    return !!record && typeof record === "object" && Object.keys(record).length > 0;
  });
}

/**
 * 用户数据目录下的配置：Default、Profile 1…，最近用过的（Local State 的 profile.last_used）排最前，名字取 Local State 里用户起的。
 * 没有这一层（Opera）而目录本身就是配置时，返回一个 dir 为空的
 */
export function listProfiles(userDataDir: string | undefined): BrowserProfile[] {
  if (!userDataDir) return [];
  let entries: string[];
  try {
    entries = readdirSync(userDataDir);
  } catch {
    return [];
  }
  const localState = readJson(path.join(userDataDir, "Local State"));
  const rank = (p: string) => (p === "Default" ? -1 : Number(p.slice("Profile ".length)));
  const dirs = entries.filter((e) => e === "Default" || /^Profile \d+$/.test(e)).sort((a, b) => rank(a) - rank(b));
  const lastUsed = localState?.profile?.last_used;
  const ordered = typeof lastUsed === "string" && dirs.includes(lastUsed) ? [lastUsed, ...dirs.filter((d) => d !== lastUsed)] : dirs;
  if (!ordered.length) {
    if (!entries.includes("Preferences") && !entries.includes("Extensions")) return [];
    return [{ dir: "", name: "默认", extension: hasExtension(userDataDir) }];
  }
  return ordered.map((dir) => {
    const name = localState?.profile?.info_cache?.[dir]?.name;
    return { dir, name: typeof name === "string" && name ? name : dir, extension: hasExtension(path.join(userDataDir, dir)) };
  });
}

/**
 * 手动添加的浏览器：路径是 macOS 的 .app 时换成里面的可执行文件（Info.plist 的 CFBundleExecutable）。
 * 返回 null 是文件不存在
 */
export function resolveExecutable(input: string): string | null {
  const p = input.trim();
  if (p.endsWith(".app") || p.endsWith(".app/")) {
    const plist = (() => {
      try {
        return readFileSync(path.join(p, "Contents", "Info.plist"), "utf8");
      } catch {
        return "";
      }
    })();
    const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    const exe = name ? path.join(p, "Contents", "MacOS", name) : "";
    return exe && isFile(exe) ? exe : null;
  }
  return isFile(p) ? p : null;
}

/**
 * 看着像不像 Chromium 内核：Windows、Linux 是可执行文件所在目录或下一层（Windows 的版本号目录）里有 .pak 资源包；
 * macOS 是 .app 的 Contents/Frameworks 里有 xxx Framework.framework。只用来提示，不拦着
 */
export function looksChromium(executablePath: string): boolean {
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  try {
    executablePath = realpathSync(executablePath);
  } catch {
    // 不存在的话下面也找不到什么
  }
  if (platform === "darwin") {
    const contents = path.resolve(executablePath, "..", "..");
    return list(path.join(contents, "Frameworks")).some((e) => e.name.endsWith("Framework.framework"));
  }
  const dir = path.dirname(executablePath);
  const entries = list(dir);
  if (entries.some((e) => e.isFile() && e.name.endsWith(".pak"))) return true;
  return entries.some((e) => e.isDirectory() && list(path.join(dir, e.name)).some((f) => f.isFile() && f.name.endsWith(".pak")));
}
