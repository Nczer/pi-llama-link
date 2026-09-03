import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProviderModelConfig,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { classifyThinkingStyle } from "./thinking-style";
import {
  applyEnableThinkingSupport,
  applyEffortThinkingSupport,
  thinkingBudgetFor,
} from "./thinking";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { patchExtSettings } from "./ext-settings";
import {
  PROVIDER_NAME,
  API_KEY_PLACEHOLDER,
  PROVIDER_IDS,
  PROPS_TIMEOUT_MS,
  rpc,
  loadSettings,
  resetSettingsCache,
  clearCaches,
  detectMode,
  resolveServers,
  resolveApiKey,
  gatherServers,
  loadModelAndWait,
  ModelInspector,
  matchModel,
  resolveContextSize,
  isAutoExposedCacheEntry,
  parseSseStream,
  sleep,
  type ServerConfig,
  type ServerInfo,
  type ServerMode,
  type ModelsDataProperty,
  type ModelsResponse,
  type MetricsData,
} from "./server";

// ── Pre-emption self-close ─────────────────────────────────────
// A focused overlay renders on every TUI pass, but keyboard input routes to
// the FOCUSED component — so when another UI (a consult/quiz/halter prompt,
// a native selector, …) takes focus, this overlay would stay visible while
// being impossible to dismiss. Render-time check: if we are visible but no
// longer focused, close ourselves so the prompt underneath is reachable.
// getFocusedComponent() is a TUI class method (used by pi's interactive mode)
// that is NOT on the public TUI interface; if a future pi removes it, the
// check is skipped and plain Esc/q close remains.
function makePreemptClose(tui: any, self: unknown, done: () => void): boolean {
  const getFocused = tui?.getFocusedComponent;
  if (typeof getFocused !== "function") return false;
  if (getFocused.call(tui) !== self) {
    done();
    return true; // pre-empted — caller should return [] for this frame
  }
  return false;
}

const MODELS_JSON = join(process.env.HOME || ".", ".pi", "agent", "models.json");
const METADATA_JSON = join(process.env.HOME || ".", ".pi", "agent", "llama-metadata.json");

// ── Types ─────────────────────────────────────────────────────────────

interface ModelsJson {
  providers: Record<string, any>;
}

// ── Thinking Template Support ─────────────────────────────────────────
// Style classification over /props data: thinking-style.ts.
// Config + payload application: thinking.ts.

// ── Config Resolution ─────────────────────────────────────────────────
// Settings loading, server resolution, per-server auth: server.ts.

let modelsWriteTimer: NodeJS.Timeout | null = null;
let metadataWriteTimer: NodeJS.Timeout | null = null;
let pendingModelsStr: string | null = null;
let pendingMetadataStr: string | null = null;

function isLlamaStatusEnabled(): boolean {
  return loadSettings().enabled !== false; // default true
}

// Dedup for the "llama" status-bar slot. SSE progress events fire faster
// than the displayed string changes, so redundant setStatus calls (and the
// TUI re-renders they trigger) are skipped.
let lastLlamaStatus: string | undefined;
function setLlamaStatus(ctx: ExtensionContext, value: string | undefined): void {
  if (value === lastLlamaStatus) return;
  lastLlamaStatus = value;
  try { ctx.ui.setStatus("llama", value); } catch { /* stale context */ }
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Map each server model's real id to the id used in models.json:
 * the first alias when present and not claimed by another model,
 * otherwise the real id. llama.cpp resolves aliases on all endpoints
 * (chat completions, /props, /slots, /models/load|unload), and Pi
 * displays and requests by id — so an alias id shows the short name
 * and is directly usable as the request model.
 */
function resolveApiIds(models: ModelsDataProperty[]): Map<string, string> {
  const taken = new Set(models.map((m) => m.id)); // real ids are always reserved
  const result = new Map<string, string>();
  for (const m of models) {
    const alias = m.aliases?.[0];
    const apiId = alias && !taken.has(alias) ? alias : m.id;
    if (apiId !== m.id) taken.add(apiId);
    result.set(m.id, apiId);
  }
  return result;
}


// ── Status Indicator ──────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  loaded: "🟢",
  loading: "🟡",
  sleeping: "🔵",
  unloaded: "⚪",
  failed: "🔴",
  offline: "⬛",
};

function buildBorderDynamic(theme: Theme, lines: string[], boxWidth: number): string[] {
  const innerW = boxWidth - 2;
  const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
  const row = (content: string) =>
    theme.fg("border", "│") + pad(` ${content}`) + theme.fg("border", "│");
  const hr = () =>
    theme.fg("border", "│") + theme.fg("dim", "─".repeat(innerW)) + theme.fg("border", "│");

  const result: string[] = [];
  result.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
  for (const line of lines) {
    if (line === "---") result.push(hr());
    else if (line === "") result.push(row(""));
    else result.push(row(line));
  }
  result.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
  return result;
}

function formatParams(n: number | undefined): string {
  if (!n) return "?";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return "?";
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatMetrics(m: MetricsData): string[] {
  const parts: string[] = [];
  if (m.kv_cache_usage_ratio !== null) {
    parts.push(`KV Cache: ${(m.kv_cache_usage_ratio * 100).toFixed(1)}%`);
  }
  if (m.kv_cache_tokens !== null) {
    parts.push(`${m.kv_cache_tokens.toLocaleString()} cached`);
  }
  if (m.predicted_tokens_per_second !== null) {
    parts.push(`Gen: ${m.predicted_tokens_per_second.toFixed(1)} tok/s`);
  }
  if (m.prompt_tokens_per_second !== null) {
    parts.push(`Prefill: ${m.prompt_tokens_per_second.toFixed(1)} tok/s`);
  }
  if (m.requests_processing !== null && m.requests_processing > 0) {
    parts.push(`${m.requests_processing} processing`);
  }
  if (m.requests_deferred !== null && m.requests_deferred > 0) {
    parts.push(`${m.requests_deferred} deferred`);
  }
  return parts;
}

async function buildStatusLines(current: ProviderModelConfig | undefined): Promise<string[]> {
  const serverInfo = await gatherServers();
  const currentProvider = (current as any)?.provider;
  const isLlamaModel = current && PROVIDER_IDS.includes(currentProvider);
  const lines: string[] = [];

  for (const { server, ready, models, mode } of serverInfo) {
    if (lines.length > 0) lines.push("");
    lines.push(`${server.name}${ready ? "" : " — ⬛ offline"}`);

    if (!ready) continue;

    const inspector = new ModelInspector(server, models.length > 0 ? { data: models, mode: mode! } : undefined);
    const loadedModels = await inspector.loadedModels();

    // Pi model ids may be aliases — match server models by id or alias
    const isCurrent = (m: { id: string; aliases?: string[] }): boolean => {
      if (!isLlamaModel || !current || currentProvider !== server.id) return false;
      return matchModel(m, current.id);
    };

    loadedModels.sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)));

    if (loadedModels.length === 0) {
      lines.push(`  ⚪ No model loaded`);
    }

    for (const serverModel of loadedModels) {
      const { id, name, status } = serverModel;
      const icon = STATUS_ICONS[status] || "⚪";
      const contextSize = inspector.contextSize(id);
      const caps = inspector.capabilities(id);
      const isActive = isCurrent(serverModel);
      const isSleeping = status === "sleeping";

      lines.push(`  ${icon} ${name} (${status})${isActive ? " ✓ active" : ""}`);
      lines.push(`     Context: ${contextSize.toLocaleString()} tokens · Input: ${caps.join(", ")}`);

      // Skip live endpoints for sleeping models — they wake the model on the router
      if (!isSleeping) {
        const [meta, metrics] = await Promise.all([
          inspector.getModelMeta(id),
          inspector.getMetrics(mode === "router" ? id : undefined),
          // Warm the slots cache so the sync getSlotInfo below can read it
          inspector.getSlots(mode === "router" ? id : undefined),
        ]);

        if (meta) {
          const parts: string[] = [];
          if (meta.n_params) parts.push(`${formatParams(meta.n_params)} params`);
          if (meta.n_vocab) parts.push(`${formatParams(meta.n_vocab)} vocab`);
          if (meta.size) parts.push(`${formatBytes(meta.size)}`);
          if (meta.n_ctx_train) parts.push(`Train ctx: ${meta.n_ctx_train.toLocaleString()}`);
          if (parts.length) {
            lines.push(`     ${parts.join(" · ")}`);
          }
        }

        const slotInfo = inspector.getSlotInfo(mode === "router" ? id : undefined);
        if (slotInfo.totalSlots > 0) {
          const genInfo: string[] = [`${slotInfo.activeSlots}/${slotInfo.totalSlots} slots`];
          if (slotInfo.decoded > 0) genInfo.push(`${slotInfo.decoded} tokens`);
          if (slotInfo.remain > 0) genInfo.push(`${slotInfo.remain} remaining`);
          lines.push(`     ▶ ${genInfo.join(" · ")}`);
        }

        const metricLines = formatMetrics(metrics);
        if (metricLines.length) {
          lines.push(`     📊 ${metricLines.join(" · ")}`);
        }
      }
    }

    const allModels = await inspector.list();
    const filteredModels = allModels.filter((m) => !isAutoExposedCacheEntry(m));
    if (filteredModels.length > 0) {
      lines.push(`  Models:`);
      for (const m of filteredModels) {
        const status = await inspector.status(m.id);
        const icon = STATUS_ICONS[status] || "⚪";
        const name = m.aliases?.[0] || m.id;
        const active = isCurrent(m) ? " ← active" : "";
        lines.push(`    ${icon} ${name}${active}`);
      }
    }
  }

  return lines;
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const contentLines = await buildStatusLines(ctx.model);

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const overlay = {
        handleInput(data: string) {
          if (matchesKey(data, "escape") || matchesKey(data, "q")) {
            done(undefined);
          }
        },
        render(width: number): string[] {
          if (makePreemptClose(tui, overlay, () => done(undefined))) return [];
          const overlayLines = [
            theme.bold(theme.fg("accent", `${PROVIDER_NAME} Status`)),
            "",
            ...contentLines,
            "",
            "---",
            "",
            "Press Escape or q to close",
          ];
          return buildBorderDynamic(theme, overlayLines, width);
        },
        invalidate() {},
      };
      return overlay;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        minWidth: 70,
        maxHeight: "90%",
      },
    },
  );
}

// ── Unload Command ────────────────────────────────────────────────────

/**
 * Pick the first loaded model that is safe to unload: it has at least one
 * readable slot and none of them has an in-flight generation.
 * A model whose slots can't be read (empty response, e.g. request failed)
 * is skipped — better to refuse than to interrupt a generation we can't see.
 */
async function pickIdleLoadedModel(
  inspector: ModelInspector,
  loaded: Array<{ id: string; name: string; aliases?: string[]; status: string }>,
  mode: ServerMode,
): Promise<{ id: string; name: string; aliases?: string[]; status: string } | undefined> {
  for (const m of loaded) {
    const slots = await inspector.getSlots(mode === "router" ? m.id : undefined);
    if (slots.length === 0) continue; // unverifiable — skip
    if (slots.some((s) => s.is_processing)) continue; // in use
    return m;
  }
  return undefined;
}

async function unloadModel(ctx: ExtensionCommandContext): Promise<void> {
  const current = ctx.model;

  const modelProvider = (current as any)?.provider;
  if (!current || !PROVIDER_IDS.includes(modelProvider)) {
    ctx.ui.notify(`Current model is not ${PROVIDER_NAME} (provider: ${modelProvider || "none"})`, "error");
    return;
  }

  const servers = resolveServers();
  const server = servers.find((s) => s.id === modelProvider);

  if (!server) {
    ctx.ui.notify(`No server found for provider ${modelProvider}`, "error");
    return;
  }

  let modelsRes: ModelsResponse;
  try {
    modelsRes = await rpc<ModelsResponse>(server, "/models");
  } catch {
    ctx.ui.notify(`${server.name} unreachable`, "error");
    return;
  }
  const mode = detectMode(modelsRes);
  const inspector = new ModelInspector(server, { data: modelsRes.data || [], mode });
  const loadedModels = await inspector.loadedModels();
  // Prefer the current Pi model (explicit intent); otherwise fall back to the
  // first loaded model with no in-flight generation, never to a busy one
  // (current.id may be an alias, loaded models carry real ids + aliases)
  const serverModel =
    loadedModels.find((m) => matchModel(m, current.id)) ||
    (await pickIdleLoadedModel(inspector, loadedModels, mode));

  if (!serverModel) {
    ctx.ui.notify(
      loadedModels.length
        ? `${server.name}: no loaded model is idle (${loadedModels.length} loaded, all in use or unreadable) — nothing unloaded`
        : `${server.name}: no model loaded`,
      "info",
    );
    return;
  }

  const modelId = mode === "router" ? serverModel.id : current.id;
  try {
    await rpc(server, "/models/unload", { model: modelId });
    ctx.ui.notify(`Unloaded ${serverModel.name} from ${server.name}`, "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to unload: ${msg}`, "error");
  }
}

async function loadModelCmd(ctx: ExtensionCommandContext, modelArg: string): Promise<void> {
  const servers = resolveServers();
  const modelProvider = (ctx.model as any)?.provider;
  const server = (modelProvider && PROVIDER_IDS.includes(modelProvider))
    ? servers.find((s) => s.id === modelProvider) || servers[0]
    : servers[0];

  try {
    await rpc<ModelsResponse>(server, "/models");
  } catch {
    ctx.ui.notify(`${server.name} unreachable`, "error");
    return;
  }

  if (!isSseActive()) {
    startSseForServer(server.id, ctx);
  }

  if (modelArg) {
    try {
      await loadModelAndWait(server, modelArg, (s) => setLlamaStatus(ctx, s));
      ctx.ui.notify(`Loaded ${modelArg} on ${server.name}`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already running") || msg.includes("already loaded")) {
        ctx.ui.notify(`${modelArg} is already loaded`, "info");
      } else {
        ctx.ui.notify(`Failed to load: ${msg}`, "error");
      }
    }
    return;
  }

  const inspector = new ModelInspector(server);
  const models = (await inspector.list()).filter((m) => !isAutoExposedCacheEntry(m));

  if (models.length === 0) {
    ctx.ui.notify("No models available on server", "error");
    return;
  }

  // Disambiguate duplicate display names (aliases) so each option maps 1:1
  // to a model — indexOf(choice) then finds the right entry.
  const nameCounts = new Map<string, number>();
  for (const m of models) {
    const name = m.aliases?.[0] || m.id;
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const options = models.map((m) => {
    const name = m.aliases?.[0] || m.id;
    const status = m.status?.value || "unknown";
    const icon = STATUS_ICONS[status] || "⚪";
    const label = (nameCounts.get(name) || 0) > 1 ? `${name} (${m.id})` : name;
    return `${icon} ${label}`;
  });

  const choice = await ctx.ui.select(`Load model on ${server.name}:`, options);
  if (!choice) return;

  const selectedIndex = options.indexOf(choice);
  const selected = models[selectedIndex];
  if (!selected) {
    ctx.ui.notify("Model not found", "error");
    return;
  }

  const displayName = selected.aliases?.[0] || selected.id;
  try {
    await loadModelAndWait(server, selected.id, (s) => setLlamaStatus(ctx, s));
    ctx.ui.notify(`Loaded ${displayName} on ${server.name}`, "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already running") || msg.includes("already loaded")) {
      ctx.ui.notify(`${displayName} is already loaded`, "info");
    } else {
      ctx.ui.notify(`Failed to load: ${msg}`, "error");
    }
  }
}

// ── Sync to models.json ──────────────────────────────────────────────

function loadModelsJson(): ModelsJson {
  if (existsSync(MODELS_JSON)) {
    try { return JSON.parse(readFileSync(MODELS_JSON, "utf-8")); } catch {}
  }
  return { providers: {} };
}

/** Write via temp file + rename so a crash can't leave a half-written JSON */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function modelsChanged(
  existing: any[],
  incoming: Array<{ id: string; contextWindow: number; input: string[]; reasoning?: boolean }>,
): boolean {
  if (existing.length !== incoming.length) return true;
  const existingMap = new Map(existing.map((m: any) => [m.id, m]));
  for (const m of incoming) {
    const match = existingMap.get(m.id);
    if (!match) return true;
    // Legacy entries carried a redundant name field — strip it on rewrite
    if (match.name !== undefined) return true;
    if (match.contextWindow !== m.contextWindow) return true;
    if (Boolean(m.reasoning) !== Boolean(match.reasoning)) return true;
    if ((match.input || []).join(",") !== m.input.join(",")) return true;
  }
  return false;
}

let syncNotifyTimer: NodeJS.Timeout | null = null;
const SYNC_NOTIFY_DURATION = 3000;

async function syncToModelsJson(
  serverInfo?: ServerInfo[],
  setStatus?: (value: string | undefined) => void,
): Promise<boolean> {
  const info = serverInfo ?? (await gatherServers());
  const config = loadModelsJson();
  const overlay = loadMetadataOverlay();
  let overlayDirty = false;
  let wrote = false;
  const validModels = new Map<string, Set<string>>();

  for (const { server, ready, models } of info) {
    if (!ready) continue;

    // Filter out auto-exposed HF cache entries (undefined models)
    const filteredModels = models.filter((m) => !isAutoExposedCacheEntry(m));
    if (filteredModels.length === 0) continue;

    // Use each model's alias as its Pi id when available (llama.cpp accepts
    // the alias in every request), falling back to the real id.
    const apiIds = resolveApiIds(filteredModels);
    validModels.set(server.id, new Set(apiIds.values()));

    const modelConfigs: Array<Omit<ProviderModelConfig, "name">> = filteredModels.map(m => {
      const contextWindow = resolveContextSize(m);
      return {
        id: apiIds.get(m.id)!,
        input: (m.architecture?.input_modalities || ["text"]).filter(
          (mod) => mod === "text" || mod === "image",
        ),
        contextWindow,
        maxTokens: contextWindow,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    });

    // Re-key persisted metadata from real ids to alias ids so overrides survive
    if (migrateMetadataKeys(overlay, server.id, apiIds)) overlayDirty = true;
    const modelsWithOverlay = modelConfigs.map(m => {
      const { id, input, contextWindow, maxTokens, cost } = m;
      const result: any = { id, input, contextWindow, maxTokens, cost };
      applyMetadataOverlay(result, server.id, overlay);
      return result;
    });

    const existing = config.providers[server.id]?.models || [];
    if (!modelsChanged(existing, modelsWithOverlay)) continue;

    config.providers[server.id] = {
      baseUrl: server.url + "/v1",
      api: "openai-completions",
      apiKey: resolveApiKey(server.id),
      models: modelsWithOverlay.map(m => ({ ...m, reasoning: m.reasoning ?? false })),
    };
    wrote = true;
  }

  const resolvedIds = new Set(resolveServers().map(s => s.id));
  for (const key of Object.keys(config.providers)) {
    if (!PROVIDER_IDS.includes(key)) continue;
    if (resolvedIds.has(key)) continue;
    delete config.providers[key];
    wrote = true;
  }

  if (wrote) {
    if (modelsWriteTimer) clearTimeout(modelsWriteTimer);
    pendingModelsStr = JSON.stringify(config, null, 2) + "\n";
    modelsWriteTimer = setTimeout(() => {
      if (pendingModelsStr) atomicWrite(MODELS_JSON, pendingModelsStr);
      modelsWriteTimer = null;
      pendingModelsStr = null;
      if (setStatus) {
        if (syncNotifyTimer) clearTimeout(syncNotifyTimer);
        setStatus("\u2713 models synced -- /reload to use");
        syncNotifyTimer = setTimeout(() => {
          setStatus(undefined);
          syncNotifyTimer = null;
        }, SYNC_NOTIFY_DURATION);
      }
    }, 1000);
  }

  if (overlayDirty) saveMetadataOverlay(overlay);

  // Prune metadata for removed/renamed models (only for reachable servers)
  cleanupStaleMetadata(overlay, validModels, info.filter((s) => s.ready).map((s) => s.server.id));

  return wrote;
}

// ── Lazy /props Metadata Discovery ────────────────────────────────────

// Track which server:model combos have been discovered to avoid duplicate queries
const discoveredMetadata = new Set<string>();
const pendingMetadata = new Set<string>();

// ── SSE Model Loading Progress ────────────────────────────────────────

interface SseProgress {
  current?: string;    // "text_model", "spec_model", "mmproj_model"
  stage?: string;      // older format: single stage name
  value?: number;      // 0.0 — 1.0
}

interface ModelLoadState {
  status: string;      // "loading", "loaded", "sleeping", "unloaded"
  progress?: SseProgress;
}

let sseAbort: AbortController | null = null;
let sseServerId: string | "" = "";
let sseCtx: ExtensionContext | null = null;
let sseReconnectTimer: NodeJS.Timeout | null = null;
let sseReconnectAttempts = 0;
let sseClearToken = 0;
const SSE_MAX_RECONNECT_ATTEMPTS = 10;
const SSE_INITIAL_RECONNECT_MS = 1000;

const STAGE_LABELS: Record<string, string> = {
  "fit_params": "fitting params",
  "text_model": "model",
  "mmproj_model": "mmproj",
};

function formatStage(stage: string): string {
  return STAGE_LABELS[stage] || stage;
}

/**
 * Format the loading progress string for the status bar.
 * Matches tps/gallop style: dim prefix, accent for key values, dim for detail.
 */
function formatLoadingProgress(state: ModelLoadState, theme: any): string {
  const dim = (s: string) => theme.fg("dim", s);
  const accent = (s: string) => theme.fg("accent", s);
  const success = (s: string) => theme.fg("success", s);

  if (state.status === "loading" && state.progress) {
    const prog = state.progress;
    const stage = prog.current || prog.stage;
    const value = prog.value;

    if (stage && value !== undefined) {
      const pct = Math.round(value * 100);
      if (stage === "fit_params") {
        return `${dim("· ")}${accent("Loading")} ${dim(`${formatStage(stage)}...`)}`;
      }
      return `${dim("· ")}${accent("Loading")} ${dim(`${formatStage(stage)} ${pct}%`)}`;
    }
  }

  if (state.status === "loading") {
    return `${dim("· ")}${accent("Loading")} ${dim("...")}`;
  }

  if (state.status === "loaded") {
    return `${success("✓")} ${dim("loaded")}`;
  }

  return "";
}

/**
 * Parse SSE stream from a Response body.
 * Yields parsed JSON objects from "data:" lines.
 */
async function* parseSseStream(response: Response): AsyncGenerator<string> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            const json = trimmed.slice(5).trim();
            if (json) yield json;
          }
        }
      }
    }

    if (buffer.trim()) {
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const json = trimmed.slice(5).trim();
          if (json) yield json;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Connect to /models/sse and process status_change events.
 * Reconnects with exponential backoff on disconnect (up to max attempts).
 */
async function connectSse(
  server: ServerConfig,
  ctx: ExtensionContext,
): Promise<void> {
  const apiKey = resolveApiKey(server.id);
  const url = `${server.url}/models/sse`;

  sseAbort = new AbortController();
  sseCtx = ctx;
  sseServerId = server.id;

  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "text/event-stream",
        ...(apiKey && apiKey !== API_KEY_PLACEHOLDER
          ? { Authorization: `Bearer ${apiKey}` }
          : {}),
      },
      signal: sseAbort.signal,
    });

    if (!response.ok) {
      // SSE endpoint not available (e.g., single-model mode or old server)
      stopSse();
      return;
    }

    sseReconnectAttempts = 0;

    for await (const jsonStr of parseSseStream(response)) {
      try {
        const event = JSON.parse(jsonStr);
        handleSseEvent(event, server.id, ctx);
      } catch {
        // Skip malformed SSE data lines
      }
    }
  } catch (err: any) {
    const msg = err?.name || err?.message || String(err);
    // AbortError is expected when we intentionally disconnect
    if (msg === "AbortError" || msg === "aborted") return;

    attemptSseReconnect(server, ctx);
  }
}

/**
 * Attempt to reconnect SSE with exponential backoff.
 */
function attemptSseReconnect(
  server: ServerConfig,
  ctx: ExtensionContext,
): void {
  if (sseReconnectAttempts >= SSE_MAX_RECONNECT_ATTEMPTS) {
    stopSse(); // Clear stale state so isSseActive() returns false
    return;
  }

  sseReconnectAttempts++;
  const delay = Math.min(
    SSE_INITIAL_RECONNECT_MS * Math.pow(2, sseReconnectAttempts - 1),
    30000, // Cap at 30s
  );

  sseReconnectTimer = setTimeout(() => {
    connectSse(server, ctx);
  }, delay);
}

/**
 * Handle a parsed SSE data line.
 * SSE format: data: {"model":"...","event":"status_change","data":{"status":"loading","progress":{...}}}
 * The JSON has: model, event, data (with status + progress inside).
 */
function handleSseEvent(
  payload: any,
  serverId: string,
  ctx: ExtensionContext,
): void {
  if (!payload || !payload.model) return;

  const inner = payload.data;
  if (!inner || !inner.status) return;

  const status = inner.status;
  const progress = inner.progress;

  const state: ModelLoadState = {
    status,
    progress: progress || undefined,
  };
  // Update status bar if this model belongs to the active server
  if (serverId === sseServerId && sseCtx) {
    try {
      const theme = ctx.ui.theme;
      const progressStr = formatLoadingProgress(state, theme);
      if (progressStr) {
        setLlamaStatus(ctx, progressStr);
      }

      // Clear status bar when model is fully loaded.
      // Token guard: a newer loading event increments sseClearToken,
      // so a stale 5s timer won't clobber the freshly-set status.
      if (status === "loaded") {
        const token = ++sseClearToken;
        setTimeout(() => {
          if (sseCtx && token === sseClearToken) setLlamaStatus(sseCtx, undefined);
        }, 5000);
      }
    } catch {
      // Context may be stale after session end
    }
  }
}

/**
 * Stop the active SSE connection and clear state.
 */
function stopSse(): void {
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (sseAbort) {
    sseAbort.abort();
    sseAbort = null;
  }
  sseServerId = "";
  sseReconnectAttempts = 0;
  sseClearToken = 0;
}

/**
 * Start SSE listener for a server if not already connected.
 */
function startSseForServer(serverId: string, ctx: ExtensionContext): void {
  if (sseServerId === serverId) return;

  stopSse();

  const servers = resolveServers();
  const server = servers.find((s) => s.id === serverId);
  if (!server) return;

  connectSse(server, ctx);
}

/**
 * Check if SSE is connected to a llama-cpp provider.
 */
function isSseActive(): boolean {
  return sseServerId !== "" && PROVIDER_IDS.includes(sseServerId);
}

// ── Metadata Overlay ──────────────────────────────────────────────────
// Persists model capabilities (thinking, context size) per server:model so it survives model syncs.

interface ModelMetadataEntry {
  thinking?: "effort" | "toggle";
  effortLevels?: string[];
  effortAliases?: Record<string, string>;
  effortOff?: boolean;
  contextWindow?: number;
}

interface ModelMetadata {
  [serverId: string]: { [modelId: string]: ModelMetadataEntry };
}

function loadMetadataOverlay(): ModelMetadata {
  if (existsSync(METADATA_JSON)) {
    try { return JSON.parse(readFileSync(METADATA_JSON, "utf-8")); } catch {}
  }
  return {};
}

function saveMetadataOverlay(metadata: ModelMetadata): void {
  if (metadataWriteTimer) clearTimeout(metadataWriteTimer);
  pendingMetadataStr = JSON.stringify(metadata, null, 2) + "\n";
  metadataWriteTimer = setTimeout(() => {
    if (pendingMetadataStr) atomicWrite(METADATA_JSON, pendingMetadataStr);
    metadataWriteTimer = null;
    pendingMetadataStr = null;
  }, 1000);
}

function cleanupStaleMetadata(overlay: ModelMetadata, validModels: Map<string, Set<string>>, reachableServers: string[]): void {
  let pruned = false;
  for (const serverId of Object.keys(overlay)) {
    // Skip servers that weren't reachable — don't delete their metadata
    if (!reachableServers.includes(serverId)) continue;

    const valid = validModels.get(serverId);
    if (!valid) {
      delete overlay[serverId];
      pruned = true;
      continue;
    }
    for (const modelId of Object.keys(overlay[serverId])) {
      if (!valid.has(modelId)) {
        delete overlay[serverId][modelId];
        pruned = true;
      }
    }
    if (Object.keys(overlay[serverId]).length === 0) {
      delete overlay[serverId];
      pruned = true;
    }
  }
  if (pruned) {
    saveMetadataOverlay(overlay);
  }
}

/**
 * Re-key persisted metadata entries from real server ids to the alias ids
 * used in models.json, so thinking/context overrides survive the id switch.
 * Existing alias-keyed entries win over stale real-id entries.
 */
function migrateMetadataKeys(overlay: ModelMetadata, serverId: string, apiIds: Map<string, string>): boolean {
  const srv = overlay[serverId];
  if (!srv) return false;
  let changed = false;
  for (const [realId, apiId] of apiIds) {
    if (realId === apiId || !srv[realId]) continue;
    if (srv[apiId]) {
      delete srv[realId];
    } else {
      srv[apiId] = srv[realId];
      delete srv[realId];
    }
    changed = true;
  }
  return changed;
}

function persistModelMetadata(serverId: string, modelId: string, data: ModelMetadataEntry): void {
  const overlay = loadMetadataOverlay();
  if (!overlay[serverId]) overlay[serverId] = {};
  const existing = overlay[serverId][modelId] || {};
  overlay[serverId][modelId] = { ...existing, ...data };
  saveMetadataOverlay(overlay);
}

function applyMetadataOverlay(model: Record<string, any>, serverId: string, overlay?: ModelMetadata): void {
  const data = overlay ?? loadMetadataOverlay();
  const entry = data[serverId]?.[model.id];
  if (!entry) return;
  if (entry.thinking) {
    switch (entry.thinking) {
      case "effort":
        applyEffortThinkingSupport(model, {
          levels: entry.effortLevels,
          aliases: entry.effortAliases,
          off: entry.effortOff === true,
        });
        break;
      case "toggle":
        // enable_thinking boolean toggle (Qwen, Gemma4, etc.)
        applyEnableThinkingSupport(model);
        break;
    }
  }
  if (entry.contextWindow) {
    model.contextWindow = entry.contextWindow;
    model.maxTokens = entry.contextWindow;
  }
}

async function discoverModelMetadata(
  serverId: string,
  modelId: string,
  ctx?: ExtensionContext,
): Promise<void> {
  const servers = resolveServers();
  const server = servers.find((s) => s.id === serverId);
  if (!server) return;

  const key = `${serverId}:${modelId}`;
  if (discoveredMetadata.has(key)) return;
  if (pendingMetadata.has(key)) return;

  pendingMetadata.add(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROPS_TIMEOUT_MS);
  const propsUrl = `${server.url.replace(/\/+$/, "")}/props?model=${encodeURIComponent(modelId)}&autoload=false`;

  // Safe ctx wrapper — session can be replaced after model switch, making ctx stale
  const u = (fn: (c: ExtensionContext) => void) => { try { if (ctx) fn(ctx); } catch {} };

  try {
    const response = await fetch(propsUrl, {
      signal: controller.signal,
      headers: {
        ...(resolveApiKey(serverId) !== API_KEY_PLACEHOLDER ? { Authorization: `Bearer ${resolveApiKey(serverId)}` } : {}),
      },
    });

    if (!response.ok) {
      discoveredMetadata.add(key); // don't retry + notify on every response
      u((c) => c.ui.notify(`[llama-cpp] /props for ${modelId} returned ${response.status}`, "error"));
      return;
    }

    const data = await response.json();
    let updated = false;
    const metadata: ModelMetadataEntry = {};

    // Effort styles (reasoning_effort/reasoning_strength) are classified first:
    // templates like Qwen3.8 have both enable_thinking and a tiered effort var.
    const style = classifyThinkingStyle(data);
    if (style.style !== "none") {
      metadata.thinking = style.style;
      if (style.style === "effort" && style.effort) {
        if (style.effort.levels) metadata.effortLevels = style.effort.levels;
        if (style.effort.aliases) metadata.effortAliases = style.effort.aliases;
        metadata.effortOff = style.effort.off;
      }
      updated = true;
    }

    if (data?.default_generation_settings?.n_ctx) {
      metadata.contextWindow = data.default_generation_settings.n_ctx;
      updated = true;
    }

    if (Object.keys(metadata).length > 0) {
      persistModelMetadata(serverId, modelId, metadata);
    }

    discoveredMetadata.add(key);

    if (!updated) return;

    // Lazy re-sync to apply overlay to models.json without blocking
    void syncToModelsJson(undefined, (v) => u((c) => setLlamaStatus(c, v))).catch(() => {});
  } catch (error) {
    const err = error as Error;
    const msg = err.name === "AbortError" ? "timeout" : err.message;
    discoveredMetadata.add(key); // don't retry + notify on every response
    u((c) => setLlamaStatus(c, undefined));
    u((c) => c.ui.notify(`[llama-cpp] /props for ${modelId} failed: ${msg}`, "error"));
  } finally {
    clearTimeout(timer);
    pendingMetadata.delete(key);
  }
}

// ── Session-start notice ──────────────────────────────────────────────

/**
 * Announce loaded models at session start so the user can see at a glance
 * whether the server's loaded model is the one Pi has selected.
 * Also warns when the selected model is not loaded while another model is
 * loaded on the same server (an unloaded-but-free server is not a conflict).
 */
async function announceLoadedModels(serverInfo: ServerInfo[], ctx: ExtensionContext): Promise<void> {
  const current = ctx.model;
  const currentProvider = (current as any)?.provider;

  for (const { server, ready, models, mode } of serverInfo) {
    if (!ready || !mode || models.length === 0) continue;
    const inspector = new ModelInspector(server, { data: models, mode });

    let loaded: Array<{ id: string; name: string; aliases?: string[]; status: string }>;
    try {
      loaded = await inspector.loadedModels();
    } catch {
      continue;
    }

    const isCurrent = (m: { id: string; aliases?: string[] }): boolean =>
      currentProvider === server.id && matchModel(m, current!.id);

    for (const m of loaded) {
      ctx.ui.notify(
        `${PROVIDER_NAME}: ${m.name} ${m.status} on ${server.name}${isCurrent(m) ? " — current model" : ""}`,
        "info",
      );
    }

    // Warn only when another model is loaded on this server but the selected
    // one isn't — with nothing loaded there is no conflict to warn about.
    if (currentProvider === server.id && loaded.length > 0 && !loaded.some(isCurrent)) {
      const status = await inspector.status(current!.id).catch(() => "unknown");
      if (status !== "loading") {
        ctx.ui.notify(
          `${PROVIDER_NAME}: ${current!.id} not loaded on ${server.name} -- /llama-load ${current!.id}`,
          "warning",
        );
      }
    }
  }
}

// ── Extension Entry ───────────────────────────────────────────────────

export default function llamaLinkExtension(pi: ExtensionAPI) {
  pi.registerCommand("llama-model", {
    description: `${PROVIDER_NAME} status indicator`,
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await showStatus(ctx);
    },
  });

  pi.registerCommand("llama-unload", {
    description: `Unload current ${PROVIDER_NAME} model`,
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await unloadModel(ctx);
    },
  });

  pi.registerCommand("llama-load", {
    description: `Load a ${PROVIDER_NAME} model (router mode)`,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await loadModelCmd(ctx, args.trim());
    },
  });

  pi.registerCommand("llama-sync", {
    description: `Sync ${PROVIDER_NAME} models to models.json`,
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const wrote = await syncToModelsJson();
      ctx.ui.notify(wrote ? `${PROVIDER_NAME} models synced` : `${PROVIDER_NAME} models already up to date`, "info");
    },
  });

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    if (!isLlamaStatusEnabled()) return;
    try {
      // One /models fetch per server, shared by sync and the loaded-model notice
      const serverInfo = await gatherServers();
      await syncToModelsJson(serverInfo, (v) => setLlamaStatus(ctx, v));
      await announceLoadedModels(serverInfo, ctx);
    } catch {}
  });

  // ── SSE Model Loading Progress ──────────────────────────────────────

  // Connect SSE listener early on session start to catch auto-load events
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    if (!isLlamaStatusEnabled()) return;
    const provider = (ctx.model as any)?.provider;
    if (provider && PROVIDER_IDS.includes(provider) && !isSseActive()) {
      startSseForServer(provider, ctx);
    }
  });

  pi.on("model_select", async (event: any, ctx: ExtensionContext) => {
    if (!isLlamaStatusEnabled()) return;
    const provider = (event.model as any)?.provider;
    if (!provider || !PROVIDER_IDS.includes(provider)) {
      stopSse();
      return;
    }

    if (isSseActive() && sseServerId === provider) return;

    startSseForServer(provider, ctx);
  });

  pi.on("session_shutdown", async () => {
    stopSse();
    sseCtx = null;
    // Flush pending debounced writes before clearing
    if (pendingModelsStr) { atomicWrite(MODELS_JSON, pendingModelsStr); pendingModelsStr = null; }
    if (pendingMetadataStr) { atomicWrite(METADATA_JSON, pendingMetadataStr); pendingMetadataStr = null; }
    if (modelsWriteTimer) { clearTimeout(modelsWriteTimer); modelsWriteTimer = null; }
    if (metadataWriteTimer) { clearTimeout(metadataWriteTimer); metadataWriteTimer = null; }
    clearCaches();
    discoveredMetadata.clear();
    pendingMetadata.clear();
  });

  // ── Additional Commands ─────────────────────────────────────────────

  pi.registerCommand("llama-version", {
    description: "Print llama-server --version output",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      let result;
      try {
        result = await pi.exec("llama-server", ["--version"]);
      } catch {
        ctx.ui.notify("llama-server not found on PATH", "error");
        return;
      }
      const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
      const versionLine = output
        .split("\n")
        .map((l) => l.trim())
        .find((l) => /^version:\s/i.test(l));
      ctx.ui.notify(
        versionLine ?? `llama-server exited with code ${result.code}`,
        versionLine ? "info" : "error",
      );
    },
  });

  // ── Event Handlers ──────────────────────────────────────────────────

  pi.on("before_provider_request", (event, ctx) => {
    if (!isLlamaStatusEnabled()) return;
    const provider = (ctx.model as any)?.provider;
    if (!PROVIDER_IDS.includes(provider || "")) return;
    const budget = thinkingBudgetFor(ctx.model, pi.getThinkingLevel());
    if (budget === undefined) return;

    return {
      ...(event.payload as Record<string, unknown>),
      thinking_budget_tokens: budget,
    };
  });

  // /props metadata after first successful provider response
  // (model is guaranteed loaded by this point — no race with model loading)
  pi.on("after_provider_response", (event, ctx) => {
    if (!isLlamaStatusEnabled()) return;
    if (event.status !== 200) return;
    const model = ctx.model;
    if (!model) return;
    const provider = (model as any)?.provider;
    if (!PROVIDER_IDS.includes(provider || "")) return;
    void discoverModelMetadata(provider, model.id, ctx);
  });

  pi.registerCommand("llama-link", {
    description: "Toggle llama-link extension on/off",
    handler: async (_args, ctx) => {
      // Re-read fresh from disk to avoid clobbering external edits
      resetSettingsCache();
      const next = !loadSettings().enabled;
      patchExtSettings("llama-link", { enabled: next });
      loadSettings(); // re-read patched value, warm the server.ts cache
      if (!next) {
        stopSse();
        setLlamaStatus(ctx, undefined);
      }
      ctx.ui.notify(next ? "Llama link enabled" : "Llama link disabled", next ? "info" : "warning");
    },
  });

}
