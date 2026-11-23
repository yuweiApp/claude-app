import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { withAlwaysLoad } from "../config-file.js";
import type { MarketPlugin } from "../shared/types.js";
import { searchMarketPlugins } from "./plugin-market.js";

/** MCP 服务器名：工具全名是 mcp__plugins__search_plugins */
export const PLUGINS_SERVER = "plugins";
export const SEARCH_PLUGINS_TOOL = `mcp__${PLUGINS_SERVER}__search_plugins`;
/** 只读，不弹权限卡片（options.allowedTools） */
export const PLUGINS_TOOLS = [SEARCH_PLUGINS_TOOL];

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** 简介超过这么长的截断 */
const MAX_DESCRIPTION = 500;

/**
 * 只描述事实（CLAUDE.md「约定」）：搜的是哪些插件、怎么匹配、返回什么、装插件在哪里、装上之后什么时候生效。
 * 市场名称在建会话时从 config.yml 读（改配置要重启网关，所以不会变）
 */
function description(marketplaces: string[]): string {
  return [
    "搜索 Claude Code 插件市场里的插件。插件可以带技能、斜杠命令、子代理、MCP 服务器和 hook。",
    `搜的是用户的 claude-app 配置的插件市场：${marketplaces.join("、")}（anthropic-plugin-directory 是 Claude Code 内置的插件目录，其余是 git 仓库形式的市场）。` +
      "同名的插件只留一个（已经安装的那个，都没装时取排在前面的市场的）。插件代码大多在第三方仓库，多数未经审核。",
    "匹配：每个关键词不分大小写，在插件名、显示名称、简介、分类、作者里按子串匹配，命中任意一个关键词就算匹配。" +
      "结果按命中的关键词个数从多到少排，个数相同的按上面市场的顺序，同一个市场里有安装次数的按安装次数。插件的名称和简介大多是英文。",
    `结果是 JSON：total 是匹配的总数，plugins 是从 offset 起的最多 limit 个（默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}）。每个插件：` +
      "id（插件名@市场名），name，title（显示名称，和 name 不同时才有），description（超过 " +
      `${MAX_DESCRIPTION} 字截断），marketplace，category，author，review（anthropic 或 partner：Anthropic 或合作伙伴审核过；没有这一项是未审核或市场不提供），` +
      "installCount（市场给的安装次数，只有部分市场有），link（主页或代码仓库），installed（是否已经装在用户的 claude-app 上）。",
    "这个工具只搜索，不安装。安装、卸载、更新在用户界面的设置页「插件」→「插件市场」里，由用户操作。" +
      "装上的插件对之后新开的会话和子进程重启后的会话生效，当前会话里不会出现。",
    "插件列表在 claude-app 里缓存 10 分钟；还没有缓存时（claude-app 启动后的第一次查询）要先克隆 git 市场、下载内置目录，可能要几十秒。",
  ].join("\n");
}

function summary(p: MarketPlugin) {
  const link = p.homepage ?? p.repository;
  return {
    id: p.id,
    name: p.name,
    ...(p.title ? { title: p.title } : {}),
    description: p.description.length > MAX_DESCRIPTION ? `${p.description.slice(0, MAX_DESCRIPTION)}…` : p.description,
    marketplace: p.marketplace,
    ...(p.category ? { category: p.category } : {}),
    ...(p.author ? { author: p.author } : {}),
    ...(p.review ? { review: p.review } : {}),
    ...(p.installCount !== undefined ? { installCount: p.installCount } : {}),
    ...(link ? { link } : {}),
    installed: p.installed,
  };
}

/** 模型搜插件市场（agent/plugin-market.ts 的列表，和设置页「插件市场」是同一份）；只给本机会话，远程会话不加载插件 */
export function pluginsServer(marketplaces: string[]): McpSdkServerConfigWithInstance {
  const search = tool(
    "search_plugins",
    description(marketplaces),
    {
      keywords: z.array(z.string().min(1).max(64)).min(1).max(8).describe("关键词，1–8 个"),
      marketplace: z.string().optional().describe(`只搜这个市场：${marketplaces.join("、")}；不传是全部`),
      offset: z.number().int().min(0).optional().describe("跳过前面多少个，默认 0"),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`最多返回多少个，默认 ${DEFAULT_LIMIT}`),
    },
    async ({ keywords, marketplace, offset, limit }) => {
      if (marketplace && !marketplaces.includes(marketplace)) {
        return { content: [{ type: "text" as const, text: `没有这个市场：${marketplace}。配置的市场是 ${marketplaces.join("、")}。` }], isError: true };
      }
      try {
        const start = offset ?? 0;
        const result = await searchMarketPlugins({ keywords, ...(marketplace ? { marketplace } : {}), offset: start, limit: limit ?? DEFAULT_LIMIT });
        const text = JSON.stringify({ total: result.total, offset: start, plugins: result.plugins.map(summary) });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `取插件列表失败：${(err as Error).message}` }], isError: true };
      }
    },
  );
  return createSdkMcpServer({
    name: PLUGINS_SERVER,
    version: "1.0.0",
    instructions: "search_plugins 按关键词搜索用户的 claude-app 配置的 Claude Code 插件市场；只读，安装在用户界面的设置页里由用户操作。",
    tools: [withAlwaysLoad(PLUGINS_SERVER, search)],
  });
}
