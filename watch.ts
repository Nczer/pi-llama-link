/**
 * watch.ts — live auto-load progress for the provider request in flight:
 * pi's request triggered an auto-load (the model wasn't loaded / is waking
 * from sleep) → follows the load, shows "· Loading model 42%". The watcher
 * stops when the model is loaded — there is nothing left to show.
 *
 * Zero calls while pi is idle: the watcher exists only between
 * before_provider_request and after_provider_response. Loads triggered by
 * other clients are never shown — SSE events are filtered to the watched
 * model's server-side id.
 *
 * Data source: /models/sse carries the progress ({ stages, current, value },
 * throttled to 1/200ms server-side) — the /models REST endpoint never
 * includes it. A slow /models heartbeat (2s) is the source of truth: it
 * covers the queueing gap before the first SSE event, sleeping wake-ups
 * (no SSE progress), stream drops, and servers without SSE (single-model
 * mode). SSE provides instant percentage updates; it is never required.
 *
 * All pi interaction goes through WatchGlue (theme + status-bar set),
 * injected by index.ts; no pi dependency.
 */
import {
  rpc,
  matchModel,
  watchModelEvents,
  detectServer,
  type ServerConfig,
  type ModelsResponse,
} from "./server";

export interface WatchGlue {
  /** Current theme from ctx, or undefined if ctx is stale. */
  getTheme: (ctx: unknown) => any;
  /** Stale-safe status-bar update (deduped). */
  setStatus: (ctx: unknown, value: string | undefined) => void;
}

// ── Load progress formatting ──────────────────────────────────────────

export interface LoadProgressState {
  status: string; // "loading" | "loaded" | ...
  progress?: { current?: string; stage?: string; value?: number };
}

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
 * Style: dim "· ", accent verb, dim detail. Non-loading states → "".
 */
export function formatLoadingProgress(state: LoadProgressState, theme: any): string {
  if (state.status !== "loading") return "";
  const dim = (s: string) => theme.fg("dim", s);
  const accent = (s: string) => theme.fg("accent", s);

  const prog = state.progress;
  const stage = prog?.current || prog?.stage;
  const value = prog?.value;
  if (stage && value !== undefined) {
    const pct = Math.round(value * 100);
    if (stage === "fit_params") {
      return `${dim("· ")}${accent("Loading")} ${dim(`${formatStage(stage)}...`)}`;
    }
    return `${dim("· ")}${accent("Loading")} ${dim(`${formatStage(stage)} ${pct}%`)}`;
  }
  return `${dim("· ")}${accent("Loading")} ${dim("...")}`;
}

// ── Watcher ───────────────────────────────────────────────────────────

const DEFAULT_HEARTBEAT_MS = 2000; // slow /models poll alongside the SSE stream
const MAX_WATCH_MS = 30 * 60_000; // safety cap for the whole watch (long loads)

let generation = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;
let watchAbort: AbortController | null = null;
let showing = false;
let glue: WatchGlue | null = null;
let watchCtx: unknown = null;
let startedAt = 0;

/**
 * Start watching the in-flight provider request (stops and restarts any
 * previous watch). Resolves after the initial /models probe; does nothing
 * when the server is unreachable.
 */
export async function startInflightWatch(opts: {
  server: ServerConfig;
  modelId: string;
  ctx: unknown;
  glue: WatchGlue;
  pollMs?: number; // heartbeat interval (tests use a small value)
}): Promise<void> {
  stopInflightWatch();
  const gen = ++generation;
  const { server, modelId, ctx, glue: g } = opts;
  const heartbeatMs = opts.pollMs ?? DEFAULT_HEARTBEAT_MS;

  // Initial probe: an already-loaded model has nothing left to show.
  const res = await rpc<ModelsResponse>(server, "/models").catch(() => undefined);
  if (!res || gen !== generation) return;
  const probe = (res.data || []).find((m) => matchModel(m, modelId));
  if (probe?.status?.value === "loaded") return;

  // Strata shows no loading state in /models ("unloaded" until ready), so
  // while its engine is down a request in flight IS a load in progress.
  const kind = (await detectServer(server)).kind;
  if (gen !== generation) return;

  startedAt = Date.now();
  showing = false;
  glue = g;
  watchCtx = ctx;
  watchAbort = new AbortController();

  // Only we may clear the status slot: never touch it unless we set it.
  const setStatus = (v: string | undefined): void => {
    if (v === undefined) {
      if (showing) {
        showing = false;
        g.setStatus(ctx, undefined);
      }
    } else {
      showing = true;
      g.setStatus(ctx, v);
    }
  };

  // ── SSE: instant percentage updates for the watched model ──────────
  // Ephemeral connection: opened here, closed by stopInflightWatch().
  // The stream filters to the server-side id (aliases are resolved by the
  // probe above); other clients' loads are never shown. A missing SSE
  // endpoint (single-model mode) is fine — the heartbeat carries the
  // display.
  void watchModelEvents(server, probe?.id ?? modelId, watchAbort.signal, (_progress, data) => {
    if (gen !== generation || !data?.status) return;
    if (data.status !== "loading") return; // loaded/unloaded settle via heartbeat
    const theme = g.getTheme(ctx);
    if (!theme) return; // stale context
    setStatus(formatLoadingProgress({ status: "loading", progress: data.progress }, theme));
  });

  // ── Heartbeat: /models state reconciliation ─────────────────────────
  // Source of truth: catches the queueing gap before the first SSE event,
  // sleeping wake-ups, stream drops, and SSE-less servers. Never overwrites
  // a fresher SSE display while one is visible.
  const heartbeat = async (): Promise<void> => {
    if (gen !== generation) return;
    if (Date.now() - startedAt > MAX_WATCH_MS) {
      stopInflightWatch();
      return;
    }
    const theme = g.getTheme(ctx);
    if (!theme) return; // stale context

    const r = await rpc<ModelsResponse>(server, "/models").catch(() => undefined);
    if (gen !== generation) return;
    const entry = (r?.data || []).find((m) => matchModel(m, modelId));
    const value = entry?.status?.value;
    if (value === "loaded") {
      stopInflightWatch(); // load done — nothing left to show
      return;
    }
    const strataLoading = kind === "strata" && (value === "unloaded" || value === undefined);
    if (value === "loading" || value === "sleeping" || strataLoading) {
      if (!showing) {
        const state: LoadProgressState = value === "loading"
          ? { status: "loading", progress: entry?.status?.progress }
          : { status: "loading" };
        setStatus(formatLoadingProgress(state, theme));
      }
    } else {
      setStatus(undefined); // nothing loading yet (or it failed)
    }
  };

  void heartbeat();
  heartbeatTimer = setInterval(() => void heartbeat(), heartbeatMs);
}

/** Stop the watcher; clears the status bar if we were showing. */
export function stopInflightWatch(): void {
  generation++;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  watchAbort?.abort();
  watchAbort = null;
  if (showing && glue) {
    try { glue.setStatus(watchCtx, undefined); } catch { /* stale context */ }
  }
  showing = false;
  glue = null;
  watchCtx = null;
  startedAt = 0;
}

export function isInflightWatchActive(): boolean {
  return heartbeatTimer !== null;
}
