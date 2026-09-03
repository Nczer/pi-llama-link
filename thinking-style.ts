/**
 * Thinking-style classification for llama.cpp chat templates.
 *
 * Pure string logic over /props data (chat_template + chat_template_caps),
 * no pi or server dependencies — kept separate so it can be unit-tested.
 *
 * Style priority:
 *   1. "effort" — template consumes an effort string variable:
 *                  reasoning_effort / reasoning_strength (standard)
 *                  or thinking_effort (Kimi-K3 family; caps can't probe it,
 *                  text detection only)
 *   2. "toggle" — enable_thinking boolean toggle only
 *
 * Note: real DeepSeek templates gate on `thinking` in `{% if ... %}` form and
 * are classified as toggle (V3.1) or effort (V4+, via reasoning_effort) —
 * they never reference `{{ thinking }}`, so no dedicated style is needed.
 *
 * Tier exposure: only levels the chat template actually distinguishes are
 * exposed. Tiers are parsed from the template's own effort-variable usage
 * (line-scoped):
 *   == 'v' / != 'v' / in [...] / not in [...]          → level (or off-token)
 *   set reasoning_effort = 'v' / else 'v'              → default level
 *   effort concatenated into the prompt, no comparables → free-form → generic
 * Heuristic fallbacks for templates whose comparisons don't fit the above:
 *   not in ('xhigh', 'medium', 'low')  (unscoped)      → level list
 *   raise_exception('... Supported types are ...')     → level list
 * Off is exposed when the template gates on enable_thinking (→ "none") or
 * names an off-token in its effort vocabulary (none/off/no_think).
 * Aliases:
 *   if x == 'high' → set x = 'xhigh'                 → alias
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

/** Effort-vocabulary values that mean "thinking off" in the template. */
const OFF_TOKENS = new Set(["none", "off", "no_think"]);

/** Effort string variable names templates may consume. */
export const EFFORT_VAR_NAMES = ["reasoning_effort", "reasoning_strength", "thinking_effort"] as const;

/** Shared fragment for the variable-name alternation in the parse regexes. */
const EFFORT_VAR = "(?:reasoning_effort|reasoning_strength|thinking_effort)";
const EFFORT_VAR_WORD = new RegExp(`\\b${EFFORT_VAR}\\b`);

export interface EffortStyle {
  /** Parsed valid tiers; undefined → generic set; [] → none beyond off. */
  levels?: string[];
  /** Template aliases, e.g. { high: "xhigh" }. */
  aliases?: Record<string, string>;
  /** Template gates on enable_thinking (boolean off path; emits the kwarg). */
  off: boolean;
  /**
   * Effort-vocabulary token the template treats as "off" (none/off/no_think).
   * Its presence exposes the off level; it is the payload value for off.
   */
  offToken?: string;
  /**
   * Variable names the template actually references (subset of
   * EFFORT_VAR_NAMES); undefined → unknown (caps-only detection, no
   * template text) → send the two standard names.
   */
  varNames?: string[];
}

export interface ThinkingStyle {
  style: "effort" | "toggle" | "none";
  effort?: EffortStyle;
}

interface EffortLiterals {
  /** Values in comparisons (==/!=/in/not-in) — what the template distinguishes. */
  compared: string[];
  /** Values assigned as defaults (set effort = 'v' / else 'v'). */
  defaults: string[];
  /** The effort string is concatenated into the prompt (free-form interpolation). */
  interpolated: boolean;
}

/**
 * Collect the literal effort values a template compares against or assigns,
 * scoped line-by-line to lines referencing reasoning_effort / reasoning_strength
 * (live templates keep each comparison on one line).
 */
export function extractEffortLiterals(ct: string): EffortLiterals | undefined {
  const compared: string[] = [];
  const defaults: string[] = [];
  let interpolated = false;
  let seen = false;

  const push = (target: string[], value: string) => {
    if (!target.includes(value)) target.push(value);
  };
  const pushList = (target: string[], list: string) => {
    for (const m of list.matchAll(/['"]([a-z_]+)['"]/g)) push(target, m[1]);
  };

  for (const line of ct.split("\n")) {
    if (!EFFORT_VAR_WORD.test(line)) continue;
    seen = true;

    // == / != against a literal (optionally through a Jinja filter: `| lower`)
    for (const m of line.matchAll(
      new RegExp(`\\b${EFFORT_VAR}\\b(?:\\s*\\|\\s*[a-z_]+(?:\\([^)]*\\))?)?\\s*[!=]=\\s*['"]([a-z_]+)['"]`, "g"),
    )) push(compared, m[1]);

    // not in [..] / (..)
    for (const m of line.matchAll(/\bnot\s+in\s*[\[(]([^)\]]*)[\])]/g)) pushList(compared, m[1]);
    // bare `in [..]` / `( .. )` (excluding `not in` matches above)
    for (const m of line.matchAll(/(?<!not\s)(?<!\w)\bin\s*[\[(]([^)\]]*)[\])]/g)) pushList(compared, m[1]);

    // Default assignments: set <effort var> = 'v'  /  ... else 'v'
    for (const m of line.matchAll(new RegExp(`\\bset\\s+${EFFORT_VAR}\\s*=\\s*['"]([a-z_]+)['"]`, "g"))) push(defaults, m[1]);
    for (const m of line.matchAll(/\belse\s+['"]([a-z_]+)['"]/g)) push(defaults, m[1]);

    // Effort string concatenated into the prompt (free-form interpolation)
    if (new RegExp(`\\+\\s*${EFFORT_VAR}\\b|\\b${EFFORT_VAR}\\s*\\+`).test(line)) {
      interpolated = true;
    }
  }

  return seen ? { compared, defaults, interpolated } : undefined;
}

/**
 * Parse tier info from an effort-style chat template.
 * All patterns are scoped to effort-vocabulary literals so unrelated
 * template logic (tool names, modality tuples, ...) can't false-positive.
 */
export function parseEffortTemplate(ct: string): EffortStyle {
  let levels: string[] | undefined;
  let offToken: string | undefined;

  // 0) Scoped literals: the template's own reasoning_effort/reasoning_strength
  //    comparisons and default assignments decide the exposed tier set.
  const lit = extractEffortLiterals(ct);
  if (lit && lit.compared.length > 0) {
    const all = [...new Set([...lit.compared, ...lit.defaults])];
    offToken = all.find((v) => OFF_TOKENS.has(v));
    const scoped = all.filter((v) => v !== offToken && EFFORT_VOCABULARY.has(v));
    if (offToken || scoped.length > 0) levels = scoped; // [] = only off is expressible
  }

  // 1) Membership tuple (unscoped — comparisons split across lines):
  //    not in ('xhigh', 'medium', 'low')
  if (!levels) {
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
  // distinguish them (and don't probe thinking_effort at all), but the
  // template text can.
  const varNames: string[] = [];
  for (const name of EFFORT_VAR_NAMES) {
    if (ct.includes(name)) varNames.push(name);
  }

  return {
    levels,
    aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    off: /enable_thinking/.test(ct),
    offToken,
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
    /reasoning_strength\b/.test(ct) ||
    /thinking_effort\b/.test(ct);
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

  // Off — when the template has an off path: an enable_thinking gate (→ "none",
  // effort kwargs stay inert, the gate skips them) or an off-token in its effort
  // vocabulary (e.g. no_think), which is the payload value for off.
  if (effort.off || effort.offToken) map.off = effort.offToken ?? "none";

  return map;
}
