/**
 * sampling.ts — the user-owned sampling layer for llama providers:
 * models.json `providers[<pid>].modelOverrides[<modelId>].samplingParams`
 * and `.samplingParamsByThinkingLevel`.
 *
 * Why modelOverrides and not the model entry: pi merges modelOverrides last,
 * after every write an extension makes to the model definition
 * (provider-composer.ts applyModelOverride), so a tuning the user made can
 * never be destroyed by a model sync.
 *
 * Merge semantics (packages/ai/src/api/simple-options.ts resolveSamplingParams):
 *  • flat `samplingParams` applies to every thinking level
 *  • a level entry wins over the flat value for that level
 *  • pi forwards the merged map into the request body verbatim
 *    (openai-completions.ts `Object.assign(params, samplingParams)`)
 *
 * pi resolves the level entry AFTER clamping the requested level to one the
 * model exposes (packages/ai/src/models.ts clampThinkingLevel), so an entry for
 * an unexposed level is dead config that silently never applies —
 * exposedLevels() is what the UI offers.
 *
 * Backend acceptance (per-request, both verified in source):
 *  • llama-server: temperature / top_p / top_k / min_p
 *    (llama.cpp tools/server/server-task.cpp); unset = the server's own startup
 *    values (temp 0.80 top_p 0.95 top_k 40 min_p 0.05 in common/common.h)
 *  • Strata: the same keys (serve/server.py sampling_keys); unset temperature
 *    means greedy, and top_k is an integer clamped to 1..64 by the engine
 */
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export const SAMPLING_KEYS = ["temperature", "top_p", "top_k", "min_p"] as const;
export type SamplingKey = (typeof SAMPLING_KEYS)[number];

/** pi's own thinking levels (models.ts EXTENDED_THINKING_LEVELS). */
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

/** "all" writes flat samplingParams (applies to every level). */
export type SamplingTarget = "all" | Level;

export type SamplingMap = Record<string, number>;

/** The models.json keys that hold sampling config (flat and per-level). */
export const SAMPLING_FIELDS = ["samplingParams", "samplingParamsByThinkingLevel"] as const;

export interface SamplingOverride {
  samplingParams?: SamplingMap;
  samplingParamsByThinkingLevel?: Record<string, SamplingMap>;
}

/** Sampling defaults the server reports for this model (/props). */
export function serverSamplingDefaults(props: any): SamplingMap | undefined {
  const params = props?.default_generation_settings?.params;
  if (!params || typeof params !== "object") return undefined;
  const out: SamplingMap = {};
  for (const key of SAMPLING_KEYS) {
    const v = params[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validate one tuned value. Returns the number, or an error message. */
export function parseSamplingValue(key: SamplingKey, raw: string): { value?: number; error?: string } {
  const text = raw.trim();
  const value = Number(text);
  if (!text || !Number.isFinite(value)) return { error: `${key}: expected a number, got "${raw.trim()}"` };
  switch (key) {
    case "temperature":
      if (value < 0) return { error: "temperature must be >= 0 (0 = greedy)" };
      break;
    case "top_p":
      if (value <= 0 || value > 1) return { error: "top_p must be > 0 and <= 1 (1 = no truncation)" };
      break;
    case "top_k":
      if (!Number.isInteger(value) || value < 0) {
        return { error: "top_k must be a whole number >= 0 (0 = full vocab; a Strata server clamps to 1..64)" };
      }
      break;
    case "min_p":
      if (value < 0 || value > 1) return { error: "min_p must be 0..1 (0 = off)" };
      break;
  }
  return { value };
}

/** Levels pi can actually use for this model config (mirrors getSupportedThinkingLevels). */
export function exposedLevels(model: Record<string, any>): Level[] {
  return getSupportedThinkingLevels(model as any) as Level[];
}

/**
 * The level that actually runs for this model, and where it comes from.
 * pi's own priority: per-model default > global default > current session
 * level (agent-session.ts _getThinkingLevelForModelSwitch); then pi clamps to
 * the model's exposed levels.
 */
export function effectiveLevel(
  model: Record<string, any>,
  providerId: string,
  modelId: string,
  settings: any,
  currentLevel: string,
): { level: Level; source: string; clampedFrom?: string } {
  const perModel = settings?.modelThinkingLevels?.[`${providerId}/${modelId}`];
  const global = settings?.defaultThinkingLevel;
  const raw = perModel ?? global ?? currentLevel;
  const source = perModel ? "per-model default" : global ? "global default" : "current session";
  const supported = exposedLevels(model);
  const level = (supported.includes(raw as Level) ? raw : clampLevel(raw as Level, supported)) as Level;
  return { level, source, clampedFrom: level !== raw ? raw : undefined };
}

/** Same climb-then-descend search pi uses (models.ts clampThinkingLevel). */
export function clampLevel(level: Level, supported: Level[]): Level {
  if (supported.includes(level)) return level;
  const idx = LEVELS.indexOf(level);
  if (idx === -1) return supported[0] ?? "off";
  for (let i = idx; i < LEVELS.length; i++) if (supported.includes(LEVELS[i] as Level)) return LEVELS[i] as Level;
  for (let i = idx - 1; i >= 0; i--) if (supported.includes(LEVELS[i] as Level)) return LEVELS[i] as Level;
  return supported[0] ?? "off";
}

export function readOverride(
  config: any,
  providerId: string,
  modelId: string,
): SamplingOverride | undefined {
  const entry = config?.providers?.[providerId]?.modelOverrides?.[modelId];
  if (!entry) return undefined;
  return { samplingParams: entry.samplingParams, samplingParamsByThinkingLevel: entry.samplingParamsByThinkingLevel };
}

/**
 * The sampling config pi will actually see: a hand-written samplingParams on
 * the model entry, with the modelOverrides layer merged on top of it (per level
 * as well as flat). pi composes the model entry first and applies
 * modelOverrides last, so anything the UI shows or compares has to be this view.
 * Clearing through setSampling only removes the modelOverrides layer — a value
 * still present on the model entry stays, and this view is what reveals it.
 */
export function effectiveOverride(config: any, providerId: string, modelId: string): SamplingOverride {
  const entry = (config?.providers?.[providerId]?.models || []).find((m: any) => m.id === modelId);
  const override = readOverride(config, providerId, modelId);
  const out: SamplingOverride = {};

  const flat = { ...(entry?.samplingParams || {}), ...(override?.samplingParams || {}) };
  if (Object.keys(flat).length) out.samplingParams = flat;

  const levels: Record<string, SamplingMap> = {};
  for (const level of [...new Set([
    ...Object.keys(entry?.samplingParamsByThinkingLevel || {}),
    ...Object.keys(override?.samplingParamsByThinkingLevel || {}),
  ])]) {
    const map = {
      ...(entry?.samplingParamsByThinkingLevel?.[level] || {}),
      ...(override?.samplingParamsByThinkingLevel?.[level] || {}),
    };
    if (Object.keys(map).length) levels[level] = map;
  }
  if (Object.keys(levels).length) out.samplingParamsByThinkingLevel = levels;
  return out;
}

/** Values in effect for one level: server defaults, then flat, then the level entry. */
export function effectiveSampling(
  override: SamplingOverride | undefined,
  serverDefaults: SamplingMap | undefined,
  level: Level,
): SamplingMap {
  return {
    ...(serverDefaults || {}),
    ...(override?.samplingParams || {}),
    ...(override?.samplingParamsByThinkingLevel?.[level] || {}),
  };
}

/**
 * Set (or clear, when value === undefined) one key for one target inside a
 * models.json object. Mutates the object; returns whether anything changed.
 * Empty containers are pruned so the file never keeps dead keys.
 */
export function setSampling(
  config: any,
  providerId: string,
  modelId: string,
  target: SamplingTarget,
  key: SamplingKey,
  value: number | undefined,
): boolean {
  const provider = config.providers[providerId];
  if (!provider) return false;
  if (!provider.modelOverrides) provider.modelOverrides = {};
  const entry = provider.modelOverrides[modelId] || (provider.modelOverrides[modelId] = {});

  const flatKey = target === "all" ? "samplingParams" : "samplingParamsByThinkingLevel";
  if (target === "all") {
    const map = entry.samplingParams || (entry.samplingParams = {});
    if (value === undefined) delete map[key];
    else map[key] = value;
    if (!Object.keys(map).length) delete entry.samplingParams;
  } else {
    const levels = entry.samplingParamsByThinkingLevel || (entry.samplingParamsByThinkingLevel = {});
    const map = levels[target] || (levels[target] = {});
    if (value === undefined) delete map[key];
    else map[key] = value;
    if (!Object.keys(map).length) delete levels[target];
    if (!Object.keys(levels).length) delete entry.samplingParamsByThinkingLevel;
  }

  // An override entry that has nothing left in it is noise in the file; keys
  // the user put there for other reasons (contextWindow, ...) are never touched
  if (Object.keys(entry).length === 0) {
    delete provider.modelOverrides[modelId];
    if (!Object.keys(provider.modelOverrides).length) delete provider.modelOverrides;
  }
  return true;
}

export function carriesSampling(entry: any): boolean {
  return Boolean(entry?.samplingParams || entry?.samplingParamsByThinkingLevel);
}

/** Identical sampling config in two objects (missing counts as equal to missing). */
export function sameSampling(a: any, b: any): boolean {
  return SAMPLING_FIELDS.every(
    (field) => JSON.stringify(a?.[field] ?? null) === JSON.stringify(b?.[field] ?? null),
  );
}

/**
 * Copy the sampling config a user put on a previous model entry into a rebuilt
 * one — llama-link rewrites model entries on every sync, and must not drop
 * hand-written `models[].samplingParams` on the way through.
 */
export function carrySamplingFields(prev: any, entry: any): boolean {
  let carried = false;
  for (const field of SAMPLING_FIELDS) {
    if (prev?.[field] !== undefined) {
      entry[field] = prev[field];
      carried = true;
    }
  }
  return carried;
}

/** `temp 0.80 · top_p 0.95 · top_k 40` — llama-link's compact style. */
export function formatSampling(map: SamplingMap): string {
  const parts = SAMPLING_KEYS.filter((k) => map[k] !== undefined).map((k) => `${shortKey(k)} ${num(map[k])}`);
  return parts.join(" · ");
}

export function shortKey(key: SamplingKey): string {
  return key === "temperature" ? "temp" : key;
}

export function num(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** One-line summary of what is configured for a model. */
export function describeOverride(override: SamplingOverride | undefined): string {
  if (!carriesSampling(override)) return "server defaults";
  const parts: string[] = [];
  if (override?.samplingParams) {
    const s = formatSampling(override.samplingParams);
    if (s) parts.push(`all: ${s}`);
  }
  const levels = override?.samplingParamsByThinkingLevel || {};
  for (const level of LEVELS) {
    const map = levels[level];
    if (!map) continue;
    const s = formatSampling(map);
    if (s) parts.push(`${level}: ${s}`);
  }
  return parts.join(" · ") || "server defaults";
}

/** Sampling line for the /llama-model overlay, e.g. values actually in effect. */
export function samplingStatusLine(
  override: SamplingOverride | undefined,
  serverDefaults: SamplingMap | undefined,
  level: Level,
): string {
  const inEffect = effectiveSampling(override, serverDefaults, level);
  const s = formatSampling(inEffect);
  if (!s) return `Sampling [${level}]: server values unknown (the model has not answered /props yet)`;
  const tuned = carriesSampling(override) ? "" : " (server defaults)";
  return `Sampling [${level}]: ${s}${tuned}`;
}
