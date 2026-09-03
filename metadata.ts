/**
 * metadata.ts — per-server:model capability metadata (thinking style,
 * context size), persisted to ~/.pi/agent/llama-metadata.json so overrides
 * survive model syncs.
 *
 *  • debounced store (load/save/prune/migrate/persist)
 *  • overlay application into Pi model configs (via thinking.ts)
 *  • lazy /props discovery on the first response per model
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  resolveServers,
  resolveApiKey,
  API_KEY_PLACEHOLDER,
  PROPS_TIMEOUT_MS,
} from "./server";
import { classifyThinkingStyle } from "./thinking-style";
import {
  applyEnableThinkingSupport,
  applyEffortThinkingSupport,
} from "./thinking";
import { atomicWrite } from "./ext-settings";

const METADATA_JSON = join(process.env.HOME || ".", ".pi", "agent", "llama-metadata.json");

// ── Types ───────────────────────────────────────────────────────────────

export interface ModelMetadataEntry {
  thinking?: "effort" | "toggle";
  effortLevels?: string[];
  effortAliases?: Record<string, string>;
  effortOff?: boolean;
  contextWindow?: number;
}

export interface ModelMetadata {
  [serverId: string]: { [modelId: string]: ModelMetadataEntry };
}

// ── Store (debounced writes) ────────────────────────────────────────────

let metadataWriteTimer: NodeJS.Timeout | null = null;
let pendingMetadataStr: string | null = null;

export function loadMetadataOverlay(): ModelMetadata {
  if (existsSync(METADATA_JSON)) {
    try { return JSON.parse(readFileSync(METADATA_JSON, "utf-8")); } catch {}
  }
  return {};
}

export function saveMetadataOverlay(metadata: ModelMetadata): void {
  if (metadataWriteTimer) clearTimeout(metadataWriteTimer);
  pendingMetadataStr = JSON.stringify(metadata, null, 2) + "\n";
  metadataWriteTimer = setTimeout(() => {
    if (pendingMetadataStr) atomicWrite(METADATA_JSON, pendingMetadataStr);
    metadataWriteTimer = null;
    pendingMetadataStr = null;
  }, 1000);
}

/** Flush a pending debounced write (session shutdown). */
export function flushMetadataWrite(): void {
  if (metadataWriteTimer) { clearTimeout(metadataWriteTimer); metadataWriteTimer = null; }
  if (pendingMetadataStr) { atomicWrite(METADATA_JSON, pendingMetadataStr); pendingMetadataStr = null; }
}

/**
 * Prune metadata for removed/renamed models (only for reachable servers).
 */
export function cleanupStaleMetadata(overlay: ModelMetadata, validModels: Map<string, Set<string>>, reachableServers: string[]): void {
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
export function migrateMetadataKeys(overlay: ModelMetadata, serverId: string, apiIds: Map<string, string>): boolean {
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

/** Merge an entry for server:model into the persisted overlay. */
export function persistModelMetadata(serverId: string, modelId: string, data: ModelMetadataEntry): void {
  const overlay = loadMetadataOverlay();
  if (!overlay[serverId]) overlay[serverId] = {};
  const existing = overlay[serverId][modelId] || {};
  overlay[serverId][modelId] = { ...existing, ...data };
  saveMetadataOverlay(overlay);
}

// ── Overlay application ─────────────────────────────────────────────────

/**
 * Apply the persisted metadata entry for server:model to a Pi model config:
 * thinking style (via thinking.ts) + context window override.
 */
export function applyMetadataOverlay(model: Record<string, any>, serverId: string, overlay?: ModelMetadata): void {
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

// ── Lazy /props Metadata Discovery ──────────────────────────────────────

// Track which server:model combos have been discovered to avoid duplicate queries
const discoveredMetadata = new Set<string>();
const pendingMetadata = new Set<string>();

/** Drop discovery tracking (session shutdown). */
export function resetDiscoveryState(): void {
  discoveredMetadata.clear();
  pendingMetadata.clear();
}

/** Pi-glue seams: notifications, status-bar updates, and the post-update
 *  lazy re-sync — all injected by index.ts. */
export interface DiscoveryHooks {
  notify?: (message: string, type: "info" | "warning" | "error") => void;
  onStatus?: (status: string | undefined) => void;
  onUpdated?: () => void;
}

export async function discoverModelMetadata(
  serverId: string,
  modelId: string,
  hooks?: DiscoveryHooks,
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

  try {
    const response = await fetch(propsUrl, {
      signal: controller.signal,
      headers: {
        ...(resolveApiKey(serverId) !== API_KEY_PLACEHOLDER ? { Authorization: `Bearer ${resolveApiKey(serverId)}` } : {}),
      },
    });

    if (!response.ok) {
      discoveredMetadata.add(key); // don't retry + notify on every response
      hooks?.notify?.(`[llama-cpp] /props for ${modelId} returned ${response.status}`, "error");
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
    hooks?.onUpdated?.();
  } catch (error) {
    const err = error as Error;
    const msg = err.name === "AbortError" ? "timeout" : err.message;
    discoveredMetadata.add(key); // don't retry + notify on every response
    hooks?.onStatus?.(undefined);
    hooks?.notify?.(`[llama-cpp] /props for ${modelId} failed: ${msg}`, "error");
  } finally {
    clearTimeout(timer);
    pendingMetadata.delete(key);
  }
}
