/**
 * watch.ts — live auto-load progress for the provider request in flight:
 * pi's request triggered an auto-load (the model wasn't loaded / is waking
 * from sleep) → polls /models, shows "· Loading model 42%". The watcher
 * stops when the model is loaded — there is nothing left to show.
 *
 * Zero calls while pi is idle: the watcher exists only between
 * before_provider_request and after_provider_response. Loads triggered by
 * other clients are never shown — there is no persistent SSE connection.
 *
 * Data source: /models status { value: "loading", progress: { current, value } }
 *
 * All pi interaction goes through WatchGlue (theme + status-bar set),
 * injected by index.ts; no pi dependency.
 */
import {
  rpc,
  matchModel,
  type ServerConfig,
  type ModelsResponse,
} from "./server";

export interface WatchGlue {
  /** Current theme from ctx.ui, or undefined if ctx is stale. */
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

const DEFAULT_POLL_MS = 500;
const MAX_WATCH_MS = 30 * 60_000; // safety cap for the whole watch (long loads)

let generation = 0;
let timer: NodeJS.Timeout | null = null;
let showing = false;
let glue: WatchGlue | null = null;
let watchCtx: unknown = null;

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
  pollMs?: number;
}): Promise<void> {
  stopInflightWatch();
  const gen = ++generation;
  const { server, modelId, ctx, glue: g } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  // Initial probe: an already-loaded model has nothing left to show.
  const res = await rpc<ModelsResponse>(server, "/models").catch(() => undefined);
  if (!res || gen !== generation) return;
  const probe = (res.data || []).find((m) => matchModel(m, modelId));
  if (probe?.status?.value === "loaded") return;

  const startedAt = Date.now();
  showing = false;
  glue = g;
  watchCtx = ctx;

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

  const poll = async (): Promise<void> => {
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
    if (!value || value === "unloaded" || value === "failed") {
      setStatus(undefined); // nothing loading yet (or it failed)
      return;
    }
    // "loading" — or "sleeping" while the server wakes it up (dots)
    const state: LoadProgressState = value === "sleeping"
      ? { status: "loading" }
      : { status: value, progress: entry?.status?.progress };
    setStatus(formatLoadingProgress(state, theme));
  };

  void poll();
  timer = setInterval(() => void poll(), pollMs);
}

/** Stop the watcher; clears the status bar if we were showing. */
export function stopInflightWatch(): void {
  generation++;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (showing && glue) {
    try { glue.setStatus(watchCtx, undefined); } catch { /* stale context */ }
  }
  showing = false;
  glue = null;
  watchCtx = null;
}

export function isInflightWatchActive(): boolean {
  return timer !== null;
}
