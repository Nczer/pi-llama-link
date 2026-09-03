/**
 * sse.ts — persistent /models/sse listener: live loading progress in the
 * status bar while a model loads, with exponential-backoff reconnect.
 *
 * All pi interaction goes through SseGlue (status-bar set + theme access),
 * injected by index.ts; the connection state machine itself has no pi
 * dependency.
 */
import {
  resolveServers,
  resolveApiKey,
  API_KEY_PLACEHOLDER,
  PROVIDER_IDS,
  parseSseStream,
  type ServerConfig,
} from "./server";

// ── State ───────────────────────────────────────────────────────────────

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
let sseCtx: unknown = null;
let sseReconnectTimer: NodeJS.Timeout | null = null;
let sseReconnectAttempts = 0;
let sseClearToken = 0;
const SSE_MAX_RECONNECT_ATTEMPTS = 10;
const SSE_INITIAL_RECONNECT_MS = 1000;

// ── Pi glue ─────────────────────────────────────────────────────────────

/** Stale-safe pi interaction. ctx is the ExtensionContext captured at
 *  connect time; it may be stale after a session switch. */
export interface SseGlue {
  /** Current theme from ctx.ui, or undefined if ctx is stale. */
  getTheme: (ctx: unknown) => any;
  /** Stale-safe status-bar update (deduped). */
  setStatus: (ctx: unknown, value: string | undefined) => void;
}

// ── Progress formatting ─────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  "fit_params": "fitting params",
  "text_model": "model",
  "mmproj_model": "mmproj",
};

export function formatStage(stage: string): string {
  return STAGE_LABELS[stage] || stage;
}

/**
 * Format the loading progress string for the status bar.
 * Matches tps/gallop style: dim prefix, accent for key values, dim for detail.
 */
export function formatLoadingProgress(state: ModelLoadState, theme: any): string {
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

// ── Connection lifecycle ────────────────────────────────────────────────

/**
 * Connect to /models/sse and process status_change events.
 * Reconnects with exponential backoff on disconnect (up to max attempts).
 */
async function connectSse(server: ServerConfig, ctx: unknown, glue: SseGlue): Promise<void> {
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
        handleSseEvent(event, server.id, ctx, glue);
      } catch {
        // Skip malformed SSE data lines
      }
    }
  } catch (err: any) {
    const msg = err?.name || err?.message || String(err);
    // AbortError is expected when we intentionally disconnect
    if (msg === "AbortError" || msg === "aborted") return;

    attemptSseReconnect(server, ctx, glue);
  }
}

/**
 * Attempt to reconnect SSE with exponential backoff.
 */
function attemptSseReconnect(
  server: ServerConfig,
  ctx: unknown,
  glue: SseGlue,
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
    connectSse(server, ctx, glue);
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
  ctx: unknown,
  glue: SseGlue,
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
    const theme = glue.getTheme(ctx);
    if (!theme) return; // stale context
    const progressStr = formatLoadingProgress(state, theme);
    if (progressStr) {
      glue.setStatus(ctx, progressStr);
    }

    // Clear status bar when model is fully loaded.
    // Token guard: a newer loading event increments sseClearToken,
    // so a stale 5s timer won't clobber the freshly-set status.
    if (status === "loaded") {
      const token = ++sseClearToken;
      setTimeout(() => {
        if (sseCtx && token === sseClearToken) glue.setStatus(sseCtx, undefined);
      }, 5000);
    }
  }
}

/**
 * Stop the active SSE connection and clear state.
 */
export function stopSse(): void {
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
  sseCtx = null;
}

/**
 * Start SSE listener for a server if not already connected.
 */
export function startSseForServer(serverId: string, ctx: unknown, glue: SseGlue): void {
  if (sseServerId === serverId) return;

  stopSse();

  const servers = resolveServers();
  const server = servers.find((s) => s.id === serverId);
  if (!server) return;

  connectSse(server, ctx, glue);
}

/** Check if SSE is connected (optionally: to a specific server). */
export function isSseActive(serverId?: string): boolean {
  if (serverId) return sseServerId === serverId;
  return sseServerId !== "" && PROVIDER_IDS.includes(sseServerId);
}
