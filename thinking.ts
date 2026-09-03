/**
 * thinking.ts — apply discovered thinking styles to Pi model configs and
 * request payloads. Pairs with thinking-style.ts (which classifies /props
 * data); this module owns the application side:
 *
 *  • per-style model config (reasoning, thinkingLevelMap, compat kwargs)
 *  • thinking_budget_tokens injection for the request body
 *
 * The metadata store (llama-metadata.json) persists the discovered style per
 * server:model and dispatches into these apply functions on sync.
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { buildEffortLevelMap, type EffortStyle } from "./thinking-style";

// Thinking budget (tokens) mapped from Pi thinking levels.
// Injected as thinking_budget_tokens in the request body for llama-cpp providers.
// off: no budget injection (thinking disabled)
// max: unrestricted (server default -1, no budget injection)
// Only a few tiers are mapped on purpose; unmapped levels (e.g. medium)
// intentionally fall back to the server's default budget (no injection).
const THINKING_BUDGET_MAP: Record<string, number | undefined> = {
  off: undefined,
  low: 512,
  high: 8192,
  max: undefined,
};

// Qwen-style: chat_template_kwargs.enable_thinking (boolean toggle).
// Pi's qwen-chat-template format sends enable_thinking based on reasoning effort.
// String values expose levels in UI; Pi sends enable_thinking: false for off level.
// Granularity is controlled by thinking_budget_tokens injection in before_provider_request hook.
export const TOGGLE_THINKING_LEVEL_MAP = {
  off: "off",
  minimal: null,
  low: "on",
  medium: null,
  high: "on",
  xhigh: null,
  max: "on",
} satisfies NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

/** Apply enable_thinking thinking (boolean toggle via chat_template_kwargs).
 *  Generic Jinja variable — works for Qwen, Gemma4, DeepSeek V3.1, or any
 *  template that reads enable_thinking. */
export function applyEnableThinkingSupport(model: Record<string, any>): void {
  model.reasoning = true;
  model.thinkingLevelMap = TOGGLE_THINKING_LEVEL_MAP;
  model.compat = {
    ...model.compat,
    thinkingFormat: "chat-template",
    chatTemplateKwargs: {
      "enable_thinking": { "$var": "thinking.enabled" },
      "preserve_thinking": true,
    },
  };
}

/** Apply effort-style thinking support (reasoning_effort / reasoning_strength effort string).
 *  Emit only the variable names the template actually references (parsed from the
 *  template text); fall back to both names when detection was caps-only (no text).
 *  Off → "none" (server disables reasoning), only when the template
 *  gates on enable_thinking — otherwise off is hidden (channel has no off path). */
export function applyEffortThinkingSupport(model: Record<string, any>, effort: EffortStyle): void {
  model.reasoning = true;
  model.thinkingLevelMap = buildEffortLevelMap(effort);
  const effortVars = effort.varNames ?? ["reasoning_effort", "reasoning_strength"];
  model.compat = {
    ...model.compat,
    thinkingFormat: "chat-template",
    chatTemplateKwargs: {
      ...(effort.off ? { "enable_thinking": { "$var": "thinking.enabled" } } : {}),
      ...Object.fromEntries(effortVars.map((name) => [name, { "$var": "thinking.effort" }])),
    },
  };
}

/**
 * Decide thinking_budget_tokens for a request payload, or undefined to
 * inject nothing:
 *  • non-reasoning models → never
 *  • effort-style models (consume reasoning_effort/reasoning_strength, not
 *    a budget) → never
 *  • unmapped levels (off, max, medium) → server default
 */
export function thinkingBudgetFor(model: Record<string, any>, level: string): number | undefined {
  if (!model?.reasoning) return undefined;
  const kwargs = model?.compat?.chatTemplateKwargs;
  if (kwargs?.reasoning_effort || kwargs?.reasoning_strength) return undefined;
  return THINKING_BUDGET_MAP[level];
}
