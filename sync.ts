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
import { atomicWrite, agentDir } from "./ext-settings";

const MODELS_JSON = join(agentDir(), "models.json");

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
 * The models.json id under which a server model is exposed (entry id must
 * be the real id or one of its aliases), or undefined when the provider or
 * model isn't in the file yet.
 */
export function modelsJsonApiId(
  providerId: string,
  m: { id: string; aliases?: string[] },
): string | undefined {
  const models = loadModelsJson().providers[providerId]?.models || [];
  const entry = models.find(
    (e: any) => e.id === m.id || (m.aliases?.includes(e.id) ?? false),
  );
  return entry?.id;
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
  incoming: Array<{ id: string; contextWindow?: number; input: string[]; reasoning?: boolean }>,
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
let pendingUnknownContext = 0;
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
  const unknown = pendingUnknownContext;
  pendingUnknownContext = 0;
  if (notify) {
    if (syncNotifyTimer) clearTimeout(syncNotifyTimer);
    notify(
      `✓ models synced${unknown ? ` · context size unknown for ${unknown}` : ""} -- /reload to use`,
    );
    syncNotifyTimer = setTimeout(() => {
      notify(undefined);
      syncNotifyTimer = null;
    }, SYNC_NOTIFY_DURATION);
  }
}

interface SyncedModel {
  id: string;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
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

    const modelConfigs: SyncedModel[] = filteredModels.map(m => {
      const id = apiIds.get(m.id)!;
      // An unreported context size stays unknown: keep what models.json already
      // records (from an earlier read that did report one) rather than invent a
      // number, and omit the field when nothing is known — pi then applies its
      // own default, and the sync notification says the size was unknown
      // instead of the file silently claiming 32768.
      const reported = resolveContextSize(m);
      const contextWindow =
        reported ?? (config.providers[server.id]?.models || []).find((e: any) => e.id === id)?.contextWindow;
      const entry: SyncedModel = {
        id,
        input: (m.architecture?.input_modalities || ["text"]).filter(
          (mod) => mod === "text" || mod === "image",
        ),
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      if (contextWindow !== undefined) {
        entry.contextWindow = contextWindow;
        entry.maxTokens = contextWindow;
      }
      return entry;
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
    pendingUnknownContext += modelsWithOverlay.filter((m: any) => m.contextWindow === undefined).length;
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
