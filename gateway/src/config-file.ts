import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/** gateway/config.yml：功能上的配置（部署相关的在 .env.local，见 config.ts），启动时读一次 */
const file = path.resolve(import.meta.dirname, "..", "config.yml");
const configFile = existsSync(file) ? parse(readFileSync(file, "utf8")) : null;

/** 常驻的 MCP 工具全名（config.yml 的 tools.alwaysLoad） */
const alwaysLoad: string[] = configFile?.tools?.alwaysLoad ?? [];

export const isAlwaysLoad = (fullName: string) => alwaysLoad.includes(fullName);

/** MCP 工具的常驻标记：tools/list 里的 _meta（SDK 的 tool({ alwaysLoad }) 也是写这个） */
export const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

/** 外部浏览器（用户自己的 Chrome、Edge，经 Playwright 扩展连接）：config.yml 的 externalBrowser.enabled，默认开（只有写成 false 才关），见 browser/external.ts */
export const externalBrowserEnabled: boolean = configFile?.externalBrowser?.enabled !== false;

/**
 * 外部浏览器连接时扩展建不建标签页组（config.yml 的 externalBrowser.tabGroup），默认不建（只有写成 true 才建）：
 * 扩展每连一次建一个新组，Chrome 会把组保存下来固定到书签栏，网关重启几次书签栏上就是一排同名的组
 */
export const externalBrowserTabGroup: boolean = configFile?.externalBrowser?.tabGroup === true;

/** 桌面操作（agent-desktop，操作网关所在电脑上的原生应用）：config.yml 的 desktop.enabled，默认关（只有写成 true 才开），见 desktop/tool.ts */
export const desktopEnabled: boolean = configFile?.desktop?.enabled === true;


/** 连接器市场：MCP 注册表的地址和不搜索时列出的推荐连接器（config.yml 的 connectors），见 agent/connectors.ts */
export const connectorRegistry: string = (configFile?.connectors?.registry ?? "https://registry.modelcontextprotocol.io").replace(/\/+$/, "");
export const featuredConnectors: string[] = configFile?.connectors?.featured ?? [];

/**
 * 插件市场（设置页「插件」→「插件市场」）：config.yml 的 plugins.marketplaces，git 仓库地址，
 * 或 Claude Code 内置市场的名称（anthropic-plugin-directory），见 agent/plugin-market.ts
 */
export const pluginMarketplaces: string[] = configFile?.plugins?.marketplaces ?? [
  "https://github.com/anthropics/claude-plugins-official.git",
  "anthropic-plugin-directory",
];
