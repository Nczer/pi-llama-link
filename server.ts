/**
 * server.ts — llama.cpp server interaction layer.
 *
 *  • settings-driven server resolution (local/remote) + per-server auth
 *  • JSON RPC + SSE HTTP clients
 *  • endpoint helpers (slots, metrics, v1 models, load)
 *  • load-wait state machine (SSE hints + /models polling)
 *  • cached ModelInspector over /models + /props + /slots + /metrics + /v1
 *
 * No pi runtime dependency (type-only imports), so the pure parts
 * (parsing, resolution, mode detection) are testable directly.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadExtSettings } from "./ext-settings";

// ── Constants ───────────────────────────────────────────────────────────

export const PROVIDER_NAME = "Llama.cpp";
export const API_KEY_PLACEHOLDER = "sk-placeholder";
export const PROVIDER_IDS = ["llama-cpp", "llama-cpp-remote", "llama-server"];
const apiKeyCache = new Map<string, string>();
const RPC_TIMEOUT = 2000; // 2s timeout for all server requests
export const PROPS_TIMEOUT_MS = 120_000; // 2min timeout for /props (model loading can be slow)

// ── Server Configs ──────────────────────────────────────────────────────

export interface ServerConfig {
  id: string;
  name: string;
  url: string;
}

export interface ServerInfo {
  server: ServerConfig;
  ready: boolean;
  models: ModelsDataProperty[];
  mode?: ServerMode;
}

/** Extension settings: the "llama-link" namespace of the shared
 *  settings-ext.json (defaults materialized on first load). */
export interface LlamaLinkSettings {
  enabled: boolean;
  serverUrl: string;
  remoteUrl: string | null;
}

export const LLAMA_LINK_DEFAULTS: LlamaLinkSettings = {
  enabled: true,
  serverUrl: "http://127.0.0.1:8080",
  remoteUrl: null,
};

// ── Types ───────────────────────────────────────────────────────────────

export interface ModelsDataProperty {
  id: string;
  aliases?: string[];
  status?: { value: string; args?: string[]; failed?: boolean; exit_code?: number };
  architecture?: { input_modalities: string[] };
  meta?: { n_ctx: number; n_ctx_train: number };
}

export interface ModelsResponse {
  models?: ModelsDataProperty[]; // present in single mode, absent in router mode
  data: ModelsDataProperty[];
}

export type ServerMode = "single" | "router";

export function detectMode(res: ModelsResponse): ServerMode {
  return res.models ? "single" : "router";
}

export interface PropsResponse {
  error?: { code: number; message: string };
  is_sleeping: boolean;
  default_generation_settings?: {
    n_ctx: number;
  };
}

export interface SlotInfo {
  is_processing: boolean;
  n_ctx: number;
  next_token?: {
    n_decoded: number;
    n_remain: number;
  };
}

export interface MetricsData {
  kv_cache_usage_ratio: number | null;
  kv_cache_tokens: number | null;
  prompt_tokens_per_second: number | null;
  predicted_tokens_per_second: number | null;
  requests_processing: number | null;
  requests_deferred: number | null;
}

export interface V1ModelMeta {
  n_vocab?: number;
  n_ctx_train?: number;
  n_params?: number;
  size?: number;
}

export interface V1ModelInfo {
  id: string;
  meta?: V1ModelMeta | null;
}

export interface V1ModelsResponse {
  data: V1ModelInfo[];
}

// ── Config Resolution ───────────────────────────────────────────────────

let cachedSettings: LlamaLinkSettings | undefined;

export function loadSettings(): LlamaLinkSettings {
  if (cachedSettings !== undefined) return cachedSettings;
  return (cachedSettings = loadExtSettings("llama-link", LLAMA_LINK_DEFAULTS));
}

/** Drop the settings cache (e.g. after a settings patch or external edit). */
export function resetSettingsCache(): void {
  cachedSettings = undefined;
}

/** Drop all module caches (settings + api keys) — used at session shutdown. */
export function clearCaches(): void {
  cachedSettings = undefined;
  apiKeyCache.clear();
}

export function resolveLocalUrl(): string {
  const envOverride = process.env.LLAMA_SERVER_URL;
  const settings = loadSettings();

  return (envOverride || settings.serverUrl || "http://127.0.0.1:8080").replace(/\/+$/, "");
}

export function resolveRemoteUrl(): string | undefined {
  const settings = loadSettings();
  const raw = settings.remoteUrl;
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

export function resolveServers(): ServerConfig[] {
  const localUrl = resolveLocalUrl();
  const servers: ServerConfig[] = [
    { id: "llama-cpp", name: `Local (${localUrl.replace(/^https?:\/\//, "")})`, url: localUrl },
  ];

  const remoteUrl = resolveRemoteUrl();
  if (remoteUrl) {
    servers.push({
      id: "llama-cpp-remote",
      name: `Remote (${remoteUrl.replace(/^https?:\/\//, "")})`,
      url: remoteUrl,
    });
  }

  return servers;
}

function resolveApiKeyFromDisk(serverId: string): string {
  const authPath = join(process.env.HOME || ".", ".pi", "agent", "auth.json");
  if (!existsSync(authPath)) return API_KEY_PLACEHOLDER;
  try {
    const cfg = JSON.parse(readFileSync(authPath, "utf-8"));
    // Try server-specific key first, then any known provider key
    if (cfg?.[serverId]?.key) return cfg[serverId].key;
    for (const id of PROVIDER_IDS) {
      if (cfg?.[id]?.key) return cfg[id].key;
    }
    return API_KEY_PLACEHOLDER;
  } catch {
    return API_KEY_PLACEHOLDER;
  }
}

export function resolveApiKey(serverId: string): string {
  if (apiKeyCache.has(serverId)) {
    return apiKeyCache.get(serverId)!;
  }
  const key = resolveApiKeyFromDisk(serverId);
  apiKeyCache.set(serverId, key);
  return key;
}

// ── HTTP Client (per-server) ────────────────────────────────────────────

/** Extract error message from llama.cpp-style { error: { message } } payload */
export function extractError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" && error.message ? error.message : fallback;
}

export async function rpc<T>(server: ServerConfig, endpoint: string, body?: Record<string, unknown>, timeoutMs = RPC_TIMEOUT): Promise<T> {
  const url = `${server.url}${endpoint}`;
  const apiKey = resolveApiKey(server.id);
  const signal = AbortSignal.timeout(timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(apiKey && apiKey !== API_KEY_PLACEHOLDER ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    throw new Error(err instanceof TypeError ? `Connection failed: ${err.message}` : String(err));
  }

  // Read body first so we can extract error messages even on HTTP errors
  const text = await res.text();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { payload = undefined; }

  if (!res.ok) throw new Error(extractError(payload, `HTTP ${res.status}: ${res.statusText}`));

  if (payload === undefined) throw new Error(`Invalid JSON from ${endpoint}`);
  return payload as T;
}

// ── Additional Endpoints ────────────────────────────────────────────────

export async function fetchSlots(server: ServerConfig, modelId?: string): Promise<SlotInfo[]> {
  const qs = modelId ? `?model=${encodeURIComponent(modelId)}` : "";
  try {
    return await rpc<SlotInfo[]>(server, `/slots${qs}`);
  } catch {
    return [];
  }
}

export function parsePrometheusMetrics(text: string): MetricsData {
  const metrics: MetricsData = {
    kv_cache_usage_ratio: null,
    kv_cache_tokens: null,
    prompt_tokens_per_second: null,
    predicted_tokens_per_second: null,
    requests_processing: null,
    requests_deferred: null,
  };

  const map: Record<string, keyof MetricsData> = {
    "llamacpp:kv_cache_usage_ratio": "kv_cache_usage_ratio",
    "llamacpp:kv_cache_tokens": "kv_cache_tokens",
    "llamacpp:prompt_tokens_seconds": "prompt_tokens_per_second",
    "llamacpp:predicted_tokens_seconds": "predicted_tokens_per_second",
    "llamacpp:requests_processing": "requests_processing",
    "llamacpp:requests_deferred": "requests_deferred",
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    for (const [name, key] of Object.entries(map)) {
      if (trimmed.startsWith(name)) {
        const lastSpace = trimmed.lastIndexOf(" ");
        const value = parseFloat(trimmed.slice(lastSpace + 1));
        if (!isNaN(value)) {
          (metrics as any)[key] = value;
        }
        break;
      }
    }
  }
  return metrics;
}

export async function fetchMetrics(server: ServerConfig, modelId?: string): Promise<MetricsData> {
  const qs = modelId ? `?model=${encodeURIComponent(modelId)}` : "";
  try {
    const url = `${server.url}/metrics${qs}`;
    const apiKey = resolveApiKey(server.id);
    const res = await fetch(url, {
      headers: apiKey && apiKey !== API_KEY_PLACEHOLDER ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(RPC_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return parsePrometheusMetrics(text);
  } catch {
    return {
      kv_cache_usage_ratio: null, kv_cache_tokens: null,
      prompt_tokens_per_second: null, predicted_tokens_per_second: null,
      requests_processing: null, requests_deferred: null,
    };
  }
}

export async function fetchV1Models(server: ServerConfig): Promise<V1ModelInfo[]> {
  try {
    const res = await rpc<V1ModelsResponse>(server, "/v1/models");
    return res.data || [];
  } catch {
    return [];
  }
}

export async function loadModel(server: ServerConfig, modelId: string): Promise<void> {
  await rpc(server, "/models/load", { model: modelId }, 30_000);
}

// ── SSE + Polling Model Load Detection ──────────────────────────────────

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Cancelled")); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface LoadProgress {
  message: string;
  ratio?: number;
}

export function parseLoadProgress(data: unknown): LoadProgress | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const progress = (data as { progress?: unknown }).progress;
  if (typeof progress !== "object" || progress === null) return undefined;
  const value = progress as { stages?: unknown[]; current?: unknown; stage?: unknown; value?: unknown };
  const stage = typeof value.current === "string" ? value.current : typeof value.stage === "string" ? value.stage : undefined;
  if (!stage && typeof value.value !== "number") return undefined;
  const ratio = typeof value.value === "number" ? Math.max(0, Math.min(1, value.value)) : undefined;
  return {
    message: stage ? `Loading ${stage.replace(/_/g, " ")}` : "Loading model",
    ratio,
  };
}

/**
 * Parse SSE stream from a Response body.
 * Yields parsed JSON objects from "data:" lines.
 */
export async function* parseSseStream(response: Response): AsyncGenerator<string> {
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

export async function watchModelEvents(
  server: ServerConfig,
  modelId: string,
  signal: AbortSignal,
  onProgress?: (progress: LoadProgress) => void,
): Promise<void> {
  const apiKey = resolveApiKey(server.id);
  try {
    const response = await fetch(`${server.url}/models/sse`, {
      headers: {
        "Accept": "text/event-stream",
        ...(apiKey && apiKey !== API_KEY_PLACEHOLDER ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal,
    });
    if (!response.ok || !response.body) return;

    for await (const jsonStr of parseSseStream(response)) {
      try {
        const event = JSON.parse(jsonStr);
        if (event.model !== modelId) continue;
        if (event.event === "model_status" || event.event === "status_change") {
          const status = event.data?.status;
          // Stop watching once settled — the poller is the source of truth
          if (status === "loaded" || status === "unloaded") return;
          if (onProgress) {
            const progress = parseLoadProgress(event.data);
            if (progress) onProgress(progress);
          }
        }
      } catch { /* skip malformed events */ }
    }
  } catch {
    // SSE not available — will rely on polling
  }
}

export async function loadModelAndWait(
  server: ServerConfig,
  modelId: string,
  onStatus?: (status: string | undefined) => void,
): Promise<void> {
  // Accept aliases: SSE events and /models polling report the real id, so
  // resolve to it first (fall back to the given id if the server is down).
  let targetId = modelId;
  try {
    const res = await rpc<ModelsResponse>(server, "/models");
    const entry = (res.data || []).find((m) => matchModel(m, modelId));
    if (entry) targetId = entry.id;
  } catch {}

  const watcher = new AbortController();
  const combinedSignal = watcher.signal;

  // Start SSE watcher in background for instant load detection
  const watchPromise = watchModelEvents(server, targetId, combinedSignal, (progress) => {
    onStatus?.(`· ${progress.message}${progress.ratio !== undefined ? ` ${Math.round(progress.ratio * 100)}%` : ""}`);
  });

  try {
    await loadModel(server, targetId);
    onStatus?.("· Loading model...");

    // Poll until loaded, with SSE events providing early hints.
    // Transient failures (503 while the server is busy, network blips) are
    // tolerated — the model keeps loading server-side, so we keep polling.
    let transientFailures = 0;
    while (true) {
      let entry: ModelsDataProperty | undefined;
      try {
        const models = await rpc<ModelsResponse>(server, "/models");
        entry = models.data.find((m) => m.id === targetId);
      } catch {
        if (++transientFailures >= 20) {
          // ~5s of consecutive failures — server is gone, not busy
          throw new Error("Server unreachable while waiting for model to load");
        }
        await sleep(250, combinedSignal);
        continue;
      }
      transientFailures = 0;

      if (entry?.status?.value === "loaded" || entry?.status?.value === "sleeping") return;
      if (entry?.status?.value === "unloaded" && entry?.status?.failed) {
        throw new Error(
          entry.status.exit_code !== undefined
            ? `Model exited with code ${entry.status.exit_code}`
            : "Model failed to load",
        );
      }

      await sleep(250, combinedSignal);
    }
  } finally {
    watcher.abort();
    await watchPromise.catch(() => {});
    onStatus?.(undefined);
  }
}

// ── Model Inspector ─────────────────────────────────────────────────────

export class ModelInspector {
  private cachedData: ModelsDataProperty[] | null = null;
  private cachedMode: ServerMode | null = null;
  private cachedProps: PropsResponse | null = null;
  private cachedSlots = new Map<string, SlotInfo[]>();
  private cachedMetrics = new Map<string, MetricsData>();
  private cachedV1Models: V1ModelInfo[] | null = null;

  constructor(
    private server: ServerConfig,
    preloaded?: { data: ModelsDataProperty[]; mode: ServerMode },
  ) {
    if (preloaded) {
      this.cachedData = preloaded.data;
      this.cachedMode = preloaded.mode;
    }
  }

  private async fetchData(): Promise<ModelsDataProperty[]> {
    if (!this.cachedData) {
      const res = await rpc<ModelsResponse>(this.server, "/models");
      this.cachedData = res.data || [];
      this.cachedMode = detectMode(res);
    }
    return this.cachedData;
  }

  private getMode(): ServerMode {
    if (!this.cachedMode) throw new Error("Data not loaded");
    return this.cachedMode;
  }

  async list(): Promise<ModelsDataProperty[]> {
    if (!this.cachedData) await this.fetchData();
    return this.cachedData!;
  }

  async status(modelId: string): Promise<string> {
    const data = await this.fetchData();
    const model = data.find((m) => m.id === modelId);
    if (!model) return "failed";

    // Router mode: status from /models data
    if (this.getMode() === "router" && model.status?.value) {
      return model.status.value;
    }
    // Single mode: /props is server-wide, cache it
    const props = await this.getProps();
    if (props.is_sleeping) return "sleeping";
    if (!props.error) return "loaded";
    if (props.error.code === 503) return "loading";
    if (props.error.code === 400 && props.error.message === "model is not loaded") return "unloaded";
    return model?.status?.value || "failed";
  }

  private async getProps(): Promise<PropsResponse> {
    if (!this.cachedProps) {
      try {
        this.cachedProps = await rpc<PropsResponse>(this.server, "/props");
      } catch {
        this.cachedProps = { is_sleeping: false, error: { code: 0, message: "props request failed" } };
      }
    }
    return this.cachedProps;
  }

  contextSize(modelId: string): number {
    const model = this.cachedData?.find((m) => m.id === modelId);
    return model ? resolveContextSize(model) : 32768;
  }

  capabilities(modelId: string): string[] {
    const model = this.cachedData?.find((m) => m.id === modelId);
    if (!model?.architecture) return ["text"];
    return (model.architecture.input_modalities || ["text"]).filter(
      (m) => m === "text" || m === "image",
    );
  }

  async loadedModels(): Promise<Array<{ id: string; name: string; aliases?: string[]; status: string }>> {
    const data = await this.fetchData();
    // Router mode: status is in /models data
    if (this.getMode() === "router") {
      const loaded: Array<{ id: string; name: string; aliases?: string[]; status: string }> = [];
      for (const model of data) {
        const value = model.status?.value;
        if (value === "loaded" || value === "sleeping") {
          loaded.push({ id: model.id, name: model.aliases?.[0] || model.id, aliases: model.aliases, status: value });
        }
      }
      return loaded;
    }
    // Single mode: check /props once for the server
    const props = await this.getProps();
    if (data.length === 0) return [];
    if (props.is_sleeping) {
      const model = data[0];
      return [{ id: model.id, name: model.aliases?.[0] || model.id, aliases: model.aliases, status: "sleeping" }];
    }
    if (!props.error) {
      const model = data[0];
      return [{ id: model.id, name: model.aliases?.[0] || model.id, aliases: model.aliases, status: "loaded" }];
    }
    return [];
  }

  // ── Slots ───────────────────────────────────────────────────────────

  async getSlots(modelId?: string): Promise<SlotInfo[]> {
    const key = modelId ?? "";
    if (!this.cachedSlots.has(key)) {
      this.cachedSlots.set(key, await fetchSlots(this.server, modelId));
    }
    return this.cachedSlots.get(key)!;
  }

  getSlotInfo(modelId?: string): { decoded: number; remain: number; totalSlots: number; activeSlots: number } {
    const slots = this.cachedSlots.get(modelId ?? "") || [];
    const active = slots.filter((s) => s.is_processing);
    let decoded = 0, remain = -1;
    for (const s of active) {
      if (s.next_token) {
        decoded += s.next_token.n_decoded;
        if (s.next_token.n_remain > 0) remain = s.next_token.n_remain;
      }
    }
    return { decoded, remain, totalSlots: slots.length, activeSlots: active.length };
  }

  // ── Metrics ─────────────────────────────────────────────────────────

  async getMetrics(modelId?: string): Promise<MetricsData> {
    const key = modelId ?? "";
    if (!this.cachedMetrics.has(key)) {
      this.cachedMetrics.set(key, await fetchMetrics(this.server, modelId));
    }
    return this.cachedMetrics.get(key)!;
  }

  // ── V1 Models (rich metadata) ──────────────────────────────────────

  async getV1Models(): Promise<V1ModelInfo[]> {
    if (!this.cachedV1Models) {
      this.cachedV1Models = await fetchV1Models(this.server);
    }
    return this.cachedV1Models;
  }

  async getModelMeta(modelId: string): Promise<V1ModelMeta | null> {
    const v1Models = await this.getV1Models();
    const m = v1Models.find((v) => v.id === modelId || v.id.endsWith("/" + modelId));
    return m?.meta || null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function isAutoExposedCacheEntry(m: ModelsDataProperty): boolean {
  // Auto-exposed HF cache entries have ID == hf-repo arg value
  const args = m.status?.args;
  if (args) {
    const idx = args.indexOf("--hf-repo");
    if (idx !== -1 && args[idx + 1] === m.id) return true;
  }
  return false;
}

export function resolveContextSize(m: ModelsDataProperty): number {
  // Router mode: parse from status.args (--ctx-size, -c, -ctx, or --fit-ctx)
  if (m.status?.args) {
    const args = m.status.args;
    for (const flag of ["--ctx-size", "-c", "-ctx", "--fit-ctx"]) {
      const idx = args.indexOf(flag);
      if (idx !== -1 && args[idx + 1]) {
        const parsed = parseInt(args[idx + 1], 10);
        if (!isNaN(parsed)) return parsed;
      }
    }
  }
  // Single mode: use meta.n_ctx, then n_ctx_train
  if (m.meta?.n_ctx) return m.meta.n_ctx;
  if (m.meta?.n_ctx_train) return m.meta.n_ctx_train;
  // Fallback default
  return 32768;
}

export function matchModel(m: { id: string; aliases?: string[] }, piModelId: string): boolean {
  return m.id === piModelId || (m.aliases?.includes(piModelId) ?? false);
}

// ── Server Gathering ────────────────────────────────────────────────────

export async function gatherServers(): Promise<ServerInfo[]> {
  const servers = resolveServers();
  const serverInfo = await Promise.all(servers.map(async (server) => {
    let models: ModelsDataProperty[] = [];
    let mode: ServerMode | undefined;
    let ready = false;
    try {
      const res = await rpc<ModelsResponse>(server, "/models");
      models = res.data || [];
      mode = detectMode(res);
      ready = true;
    } catch {}
    return { server, ready, models, mode };
  }));

  return serverInfo;
}
