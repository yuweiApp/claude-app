import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";

/**
 * 子代理跟着会话选的模型走：Agent 工具调用里模型自己填的 model（sonnet / opus / haiku / fable）去掉，
 * 子代理就继承会话当前的模型（模型菜单里中途切换的也算）。
 *
 * 只在接第三方接口时（配了 ANTHROPIC_BASE_URL 和 ANTHROPIC_MODEL）这样做：这时几个档位都指向默认模型（见 config.ts 的 agentEnv），
 * 填了 sonnet 的子代理会固定跑默认模型，而不是会话选的那个。直连 Anthropic 时档位是真的不同模型，照原样。
 * 子代理定义里自己写了 model 的（插件、.claude/agents 里的）不在这里管，仍按档位走。
 */
export function subagentModelHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  if (!config.baseUrl || !config.model) return undefined;
  return {
    PreToolUse: [
      {
        matcher: "^(Agent|Task)$",
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const toolInput = input.tool_input as Record<string, unknown> | null;
            if (!toolInput || typeof toolInput !== "object" || !("model" in toolInput)) return {};
            const { model: _model, ...rest } = toolInput;
            return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: rest } };
          },
        ],
      },
    ],
  };
}
