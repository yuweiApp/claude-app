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
