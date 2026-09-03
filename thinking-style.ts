/**
 * Thinking-style classification for llama.cpp chat templates.
 *
 * Pure string logic over /props data (chat_template + chat_template_caps),
 * no pi or server dependencies — kept separate so it can be unit-tested.
 *
 * Style priority:
 *   1. "effort" — template consumes reasoning_effort / reasoning_strength
 *                  (effort string; server binds one value to both names)
 *   2. "toggle" — enable_thinking boolean toggle only
 *
 * Note: real DeepSeek templates gate on `thinking` in `{% if ... %}` form and
 * are classified as toggle (V3.1) or effort (V4+, via reasoning_effort) —
 * they never reference `{{ thinking }}`, so no dedicated style is needed.
 *
 * Tiers (which effort levels a model honors) are NOT exposed by the API.
 * Strict templates self-document and are parsed:
 *   not in ('xhigh', 'medium', 'low')                → level list
 *   raise_exception('... Supported types are ...')   → level list (fallback)
 *   if x == 'high' → set x = 'xhigh'                 → alias
 * Free-form templates (e.g. Muse Glimmer) validate nothing → generic set.
 */

/** Pi thinking levels in display order. */
export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Generic tier set for free-form effort templates that don't validate values:
 * the standard effort vocabulary, excluding pi-only extremities (minimal/max).
 */
export const GENERIC_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];

/** Known effort vocabulary — sanity filter for tier lists parsed from templates. */
const EFFORT_VOCABULARY = new Set([
  "minimal", "low", "medium", "high", "xhigh", "max", "none", "off", "on",
]);

export interface EffortStyle {
  /** Parsed valid tiers; undefined → generic set. */
  levels?: string[];
  /** Template aliases, e.g. { high: "xhigh" }. */
  aliases?: Record<string, string>;
  /** Template gates on enable_thinking → "off" is expressible. */
  off: boolean;
  /**
   * Variable names the template actually references (subset of
   * ["reasoning_effort", "reasoning_strength"]); undefined → unknown
   * (caps-only detection, no template text) → send both.
   */
  varNames?: string[];
}

export interface ThinkingStyle {
  style: "effort" | "toggle" | "none";
  effort?: EffortStyle;
}

/**
 * Parse tier info from an effort-style chat template.
 * All patterns are scoped to effort-vocabulary literals so unrelated
 * template logic (tool names, modality tuples, ...) can't false-positive.
 */
export function parseEffortTemplate(ct: string): EffortStyle {
  let levels: string[] | undefined;

  // 1) Membership tuple: not in ('xhigh', 'medium', 'low')
  for (const m of ct.matchAll(/not\s+in\s+\(([^)]*)\)/g)) {
    const values = [...m[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((x) => x[1]);
    if (
      values.length >= 2 &&
      values.length <= 6 &&
      values.every((v) => EFFORT_VOCABULARY.has(v))
    ) {
      levels = values;
      break;
    }
  }

  // 2) Raise message: "Supported types are xhigh (default), medium, and low."
  if (!levels) {
    const m = ct.match(/Supported types are ([^'"]+)/i);
    if (m) {
      const values = m[1]
        .split(/,|\band\b/)
        .map((s) => s.replace(/\s*\(default\)/i, "").trim().replace(/[.!?]+$/, ""))
        .filter((s) => /^[A-Za-z0-9_]+$/.test(s));
      if (values.length >= 2) levels = values;
    }
  }

  // 3) Aliases: == 'high' … set … = 'xhigh' (both sides must be known effort values)
  const aliases: Record<string, string> = {};
  for (const m of ct.matchAll(
    /==\s*['"]([a-z]+)['"][\s\S]{0,160}?\bset\s+[A-Za-z_]\w*\s*=\s*['"]([a-z]+)['"]/g,
  )) {
    const [from, to] = [m[1], m[2]];
    if (from !== to && EFFORT_VOCABULARY.has(from) && EFFORT_VOCABULARY.has(to)) {
      aliases[from] = to;
    }
  }

  // Variable names the template actually reads — caps probes can't
  // distinguish the two, but the template text can.
  const varNames: string[] = [];
  if (/reasoning_effort\b/.test(ct)) varNames.push("reasoning_effort");
  if (/reasoning_strength\b/.test(ct)) varNames.push("reasoning_strength");

  return {
    levels,
    aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    off: /enable_thinking/.test(ct),
    varNames: varNames.length > 0 ? varNames : undefined,
  };
}

/**
 * Classify a model's thinking style from /props data.
 */
export function classifyThinkingStyle(data: {
  chat_template?: string;
  chat_template_caps?: Record<string, boolean> | null;
}): ThinkingStyle {
  const ct = data?.chat_template ?? "";
  const caps = data?.chat_template_caps;

  // Effort family: cap from llama.cpp ≥ b10435 (7e4c0a9), template-text
  // fallback for older builds. The cap probe sets both variable names, so
  // it covers either naming.
  const usesEffort =
    caps?.supports_reasoning_effort === true ||
    /reasoning_effort\b/.test(ct) ||
    /reasoning_strength\b/.test(ct);
  if (usesEffort) {
    return { style: "effort", effort: parseEffortTemplate(ct) };
  }

  if (ct.includes("enable_thinking")) return { style: "toggle" };
  return { style: "none" };
}

/**
 * Build the Pi thinkingLevelMap for an effort-style model: every exposed
 * level maps to a distinct model tier. Levels with no effect are hidden
 * (null), never clamped.
 */
export function buildEffortLevelMap(effort: EffortStyle): Record<string, string | null> {
  const set = effort.levels ?? GENERIC_EFFORT_LEVELS;
  const map: Record<string, string | null> = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  const claimed = new Set<string>();

  // Pass 1 — exact name matches claim their tier first.
  for (const level of PI_LEVELS) {
    if (level === "off") continue;
    if (set.includes(level) && !claimed.has(level)) {
      map[level] = level;
      claimed.add(level);
    }
  }

  // Pass 2 — aliases may only claim tiers no exact level already uses.
  for (const [from, to] of Object.entries(effort.aliases ?? {})) {
    if (map[from] === null && set.includes(to) && !claimed.has(to)) {
      map[from] = to;
      claimed.add(to);
    }
  }

  // Off — only when the template gates on enable_thinking; "none" disables
  // reasoning server-side, and the effort kwargs stay inert (gate skips them).
  if (effort.off) map.off = "none";

  return map;
}
