/**
 * sync.ts — keep ~/.pi/agent/models.json in sync with the running
 * llama.cpp servers: alias-based ids, context sizes, capabilities, and the
 * persisted metadata overlay applied per model.
 *
 * Writes are debounced (1s) and flushed on session shutdown; a successful
 * sync raises a short-lived status notification ("✓ models synced").
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  gatherServers,
  resolveServers,
  resolveApiKey,
  PROVIDER_IDS,
  isAutoExposedCacheEntry,
  resolveContextSize,
  type ServerInfo,
  type ModelsDataProperty,
} from "./server";
import {
  loadMetadataOverlay,
  saveMetadataOverlay,
  cleanupStaleMetadata,
  migrateMetadataKeys,
  applyMetadataOverlay,
} from "./metadata";
import { atomicWrite } from "./ext-settings";

const MODELS_JSON = join(process.env.HOME || ".", ".pi", "agent", "models.json");

interface ModelsJson {
  providers: Record<string, any>;
}

function loadModelsJson(): ModelsJson {
  if (existsSync(MODELS_JSON)) {
    try { return JSON.parse(readFileSync(MODELS_JSON, "utf-8")); } catch {}
  }
  return { providers: {} };
}

/**
 * Map each server model's real id to the id used in models.json:
 * the first alias when present and not claimed by another model,
 * otherwise the real id. llama.cpp resolves aliases on all endpoints
 * (chat completions, /props, /slots, /models/load|unload), and Pi
 * displays and requests by id — so an alias id shows the short name
 * and is directly usable as the request model.
 */
export function resolveApiIds(models: ModelsDataProperty[]): Map<string, string> {
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

export function modelsChanged(
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

// ── Debounced write + notify ────────────────────────────────────────────

let modelsWriteTimer: NodeJS.Timeout | null = null;
let pendingModelsStr: string | null = null;
let pendingModelsNotify: ((value: string | undefined) => void) | null = null;
let syncNotifyTimer: NodeJS.Timeout | null = null;
const SYNC_NOTIFY_DURATION = 3000;

/** Write the pending models.json immediately (session shutdown, tests). */
export function flushModelsWrite(): void {
  if (modelsWriteTimer) { clearTimeout(modelsWriteTimer); modelsWriteTimer = null; }
  if (!pendingModelsStr) return;
  atomicWrite(MODELS_JSON, pendingModelsStr);
  pendingModelsStr = null;
  const notify = pendingModelsNotify;
  pendingModelsNotify = null;
  if (notify) {
    if (syncNotifyTimer) clearTimeout(syncNotifyTimer);
    notify("✓ models synced -- /reload to use");
    syncNotifyTimer = setTimeout(() => {
      notify(undefined);
      syncNotifyTimer = null;
    }, SYNC_NOTIFY_DURATION);
  }
}

export async function syncToModelsJson(
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
    pendingModelsNotify = setStatus ?? null;
    modelsWriteTimer = setTimeout(flushModelsWrite, 1000);
  }

  if (overlayDirty) saveMetadataOverlay(overlay);

  // Prune metadata for removed/renamed models (only for reachable servers)
  cleanupStaleMetadata(overlay, validModels, info.filter((s) => s.ready).map((s) => s.server.id));

  return wrote;
}
