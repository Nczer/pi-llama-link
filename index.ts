import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { thinkingBudgetFor } from "./thinking";
import { showStatus, STATUS_ICONS } from "./status";
import {
  startInflightWatch,
  stopInflightWatch,
  type WatchGlue,
} from "./watch";
import {
  discoverModelMetadata,
  flushMetadataWrite,
  resetDiscoveryState,
} from "./metadata";
import { patchExtSettings } from "./ext-settings";
import { syncToModelsJson, flushModelsWrite, modelsJsonApiId } from "./sync";
import {
  PROVIDER_NAME,
  PROVIDER_IDS,
  rpc,
  loadSettings,
  resetSettingsCache,
  clearCaches,
  detectMode,
  resolveServers,
  gatherServers,
  loadModelAndWait,
  unloadModelOnServer,
  detectServer,
  ModelInspector,
  matchModel,
  isAutoExposedCacheEntry,
  type ServerInfo,
  type ServerMode,
  type ServerConfig,
  type ModelsResponse,
} from "./server";

// ── Thinking Template Support ─────────────────────────────────────────
// Style classification over /props data: thinking-style.ts.
// Config + payload application: thinking.ts.

// ── Config Resolution ─────────────────────────────────────────────────
// Settings loading, server resolution, per-server auth: server.ts.
// Metadata store + lazy /props discovery: metadata.ts.
// models.json sync: sync.ts.

function isLlamaStatusEnabled(): boolean {
  return loadSettings().enabled !== false; // default true
}

// Dedup for the "llama" status-bar slot. Watcher polls fire faster than
// the displayed string changes, so redundant setStatus calls (and the
// TUI re-renders they trigger) are skipped.
let lastLlamaStatus: string | undefined;
function setLlamaStatus(ctx: ExtensionContext, value: string | undefined): void {
  if (value === lastLlamaStatus) return;
  lastLlamaStatus = value;
  try { ctx.ui.setStatus("llama", value); } catch { /* stale context */ }
}

// ── Switching Pi's current model to a server model ─────────────────

/**
 * Point Pi's current model at a model on this server (no-op when it is
 * already current). models.json is read at pi startup — if the model isn't
 * in it yet (e.g. just registered on the server) sync + flush first, then
 * refresh the registry (re-reads models.json, no /reload needed) and
 * switch. Returns false when the switch did not happen.
 */
async function switchPiModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  server: ServerConfig,
  m: { id: string; aliases?: string[] },
): Promise<boolean> {
  const current = ctx.model;
  if (current && (current as any).provider === server.id && matchModel(m, current.id)) {
    return true;
  }

  let apiId = modelsJsonApiId(server.id, m);
  if (!apiId) {
    await syncToModelsJson().catch(() => {});
    flushModelsWrite();
    apiId = modelsJsonApiId(server.id, m);
  }
  if (!apiId) {
    ctx.ui.notify(`${m.aliases?.[0] || m.id} missing from models.json — /llama-sync then /reload`, "error");
    return false;
  }
  await ctx.modelRegistry.refresh({ providers: [server.id] }).catch(() => {});
  const model = ctx.modelRegistry.find(server.id, apiId);
  if (!model) {
    ctx.ui.notify(`${apiId} not found in model registry — /llama-sync then /reload`, "error");
    return false;
  }
  const ok = await pi.setModel(model);
  if (!ok) {
    ctx.ui.notify(`Could not switch: no API key configured for ${server.id}`, "error");
    return false;
  }
  ctx.ui.notify(`Current model → ${apiId}`, "info");
  return true;
}

/**
 * Resolve a server-side model entry by id or alias (fresh /models fetch)
 * and switch Pi's current model to it. Used for the /llama-load auto-switch.
 */
async function switchToLoaded(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  server: ServerConfig,
  idOrAlias: string,
): Promise<void> {
  const res = await rpc<ModelsResponse>(server, "/models").catch(() => undefined);
  const entry = (res?.data || []).find((m) => matchModel(m, idOrAlias));
  if (!entry) {
    ctx.ui.notify(`${idOrAlias} not found on ${server.name} — current model unchanged`, "warning");
    return;
  }
  await switchPiModel(pi, ctx, server, entry);
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
    await unloadModelOnServer(server, modelId);
    ctx.ui.notify(`Unloaded ${serverModel.name} from ${server.name}`, "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("HTTP 409")) {
      ctx.ui.notify(`${server.name}: the model is busy — try again once the current request finishes`, "info");
    } else {
      ctx.ui.notify(`Failed to unload: ${msg}`, "error");
    }
  }
}

/**
 * Which server /llama-load loads on: the provider the current model points
 * at when it answers, otherwise the reachable ones (single → use it, several
 * → ask). Pinning is a preference, not a trap: with the pinned server down the
 * command would be unusable.
 */
async function pickLoadServer(
  ctx: ExtensionCommandContext,
): Promise<{ server: ServerConfig; info: ServerInfo[] } | undefined> {
  const info = await gatherServers();
  const reachable = info.filter((s) => s.ready);
  const currentProvider = (ctx.model as any)?.provider;
  const preferred = PROVIDER_IDS.includes(currentProvider || "")
    ? info.find((s) => s.server.id === currentProvider)
    : undefined;

  if (reachable.length === 0) {
    ctx.ui.notify(`${preferred?.server.name || "No llama.cpp server"} unreachable`, "error");
    return undefined;
  }
  if (preferred?.ready) return { server: preferred.server, info };

  if (reachable.length === 1) {
    if (preferred) {
      ctx.ui.notify(`${preferred.server.name} unreachable — using ${reachable[0].server.name}`, "warning");
    }
    return { server: reachable[0].server, info };
  }
  const names = reachable.map((s) => s.server.name);
  const choice = ctx.hasUI ? await ctx.ui.select("Load model on which server:", names) : names[0];
  if (!choice) return undefined;
  const picked = reachable.find((s) => s.server.name === choice);
  return picked ? { server: picked.server, info } : undefined;
}

async function loadModelCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, modelArg: string): Promise<void> {
  const picked = await pickLoadServer(ctx);
  if (!picked) return;
  let server = picked.server;
  const info = picked.info;

  // An explicit id may live on another reachable server
  if (modelArg) {
    const has = (s: ServerInfo) => s.models.some((m) => matchModel(m, modelArg));
    if (!has(info.find((s) => s.server.id === server.id)!)) {
      const other = info.find((s) => s.ready && has(s));
      if (other) {
        ctx.ui.notify(`${modelArg} is on ${other.server.name}, not ${server.name} — loading there`, "info");
        server = other.server;
      }
    }
  }

  // Strata serves exactly one model per install; loading a different id
  // would silently load the configured one, so refuse it up front.
  const kindInfo = await detectServer(server);
  if (modelArg && kindInfo.kind === "strata" && kindInfo.strataModel && modelArg !== kindInfo.strataModel) {
    ctx.ui.notify(`${server.name} (Strata) serves one model: ${kindInfo.strataModel} — ${modelArg} is not it`, "error");
    return;
  }

  if (modelArg) {
    let loaded = false;
    try {
      await loadModelAndWait(server, modelArg, (s) => setLlamaStatus(ctx, s));
      ctx.ui.notify(`Loaded ${modelArg} on ${server.name}`, "info");
      loaded = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already running") || msg.includes("already loaded")) {
        ctx.ui.notify(`${modelArg} is already loaded`, "info");
        loaded = true;
      } else {
        ctx.ui.notify(`Failed to load: ${msg}`, "error");
      }
    }
    if (loaded) await switchToLoaded(pi, ctx, server, modelArg);
    return;
  }

  const inspector = new ModelInspector(server);
  let models = (await inspector.list()).filter((m) => !isAutoExposedCacheEntry(m));

  // Strata lists its model in /models only while the engine is (or was) up;
  // /health knows the configured id either way.
  if (models.length === 0 && kindInfo.kind === "strata" && kindInfo.strataModel) {
    models = [{ id: kindInfo.strataModel, status: { value: "unloaded" } }];
  }

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
  let loaded = false;
  try {
    await loadModelAndWait(server, selected.id, (s) => setLlamaStatus(ctx, s));
    ctx.ui.notify(`Loaded ${displayName} on ${server.name}`, "info");
    loaded = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already running") || msg.includes("already loaded")) {
      ctx.ui.notify(`${displayName} is already loaded`, "info");
      loaded = true;
    } else {
      ctx.ui.notify(`Failed to load: ${msg}`, "error");
    }
  }
  if (loaded) await switchToLoaded(pi, ctx, server, selected.id);
}

// ── Session-start notice ──────────────────────────────────────────────

/** A loaded model on a reachable server, tagged with the server it lives on. */
interface LoadedCandidate {
  server: ServerConfig;
  id: string;
  name: string;
  aliases?: string[];
  status: string;
}

/**
 * Announce loaded models at session start so the user can see at a glance
 * whether the server's loaded model is the one Pi has selected.
 * The current model is unusable when its own server doesn't answer or it
 * isn't loaded there; then every loaded model on a reachable server is a
 * switch candidate (an unloaded-but-free server is not a conflict, and
 * neither is a load still in flight).
 */
async function announceLoadedModels(
  serverInfo: ServerInfo[],
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  const current = ctx.model;
  const currentProvider = (current as any)?.provider ?? "";
  const currentId = current?.id ?? "";
  const llamaCurrent = !!currentId && PROVIDER_IDS.includes(currentProvider);

  const own = llamaCurrent ? serverInfo.find((s) => s.server.id === currentProvider) : undefined;
  if (own && !own.ready) {
    // Without this the session starts on a dead model with no explanation
    ctx.ui.notify(
      `${PROVIDER_NAME}: ${own.server.name} unreachable — current model ${currentProvider}/${currentId}`,
      "warning",
    );
  }

  const ownInspector = own?.ready && own.mode
    ? new ModelInspector(own.server, { data: own.models, mode: own.mode })
    : undefined;
  const candidates: LoadedCandidate[] = [];

  for (const { server, ready, models, mode } of serverInfo) {
    if (!ready || !mode || models.length === 0) continue;
    const inspector = server.id === currentProvider && ownInspector
      ? ownInspector
      : new ModelInspector(server, { data: models, mode });
    const loaded = await inspector.loadedModels().catch(() => []);

    for (const m of loaded) {
      const isCurrent = server.id === currentProvider && matchModel(m, currentId);
      ctx.ui.notify(
        `${PROVIDER_NAME}: ${m.name} ${m.status} on ${server.name}${isCurrent ? " — current model" : ""}`,
        "info",
      );
      if (!isCurrent) candidates.push({ server, ...m });
    }
  }

  // A non-llama current model is the user's choice: announce, never offer
  if (!llamaCurrent) return;

  // Current model loaded where it belongs → nothing to offer
  if (ownInspector) {
    if ((await ownInspector.loadedModels().catch(() => [])).some((m) => matchModel(m, currentId))) return;
    if ((await ownInspector.status(currentId).catch(() => "unknown")) === "loading") return;
  }

  // Nothing loaded anywhere → no conflict to resolve
  if (candidates.length === 0) return;
  const reason = own && !own.ready
    ? `current model ${currentId} is on ${own.server.name}, which is unreachable`
    : `current model ${currentId} is not loaded${own ? ` on ${own.server.name}` : ""}`;
  await autoSwitchToLoaded(pi, ctx, candidates, { provider: currentProvider, id: currentId }, reason);
}

/**
 * Session-start switch: switch to a loaded model and report it — no dialog.
 * Confirming a state the user has just watched being announced, with one
 * obviously better answer (the current model works nowhere else), is a prompt
 * for its own sake.
 *
 * Candidate ranking is deterministic and the notification states what was
 * picked: a model on the current model's own server first (switching inside
 * one server changes less than switching servers), otherwise probe order —
 * server order as configured, then that server's own model-list order.
 *
 * Headless does nothing: `ctx.ui.notify` is a no-op there, and changing the
 * model of a run nobody is watching is worse than leaving it alone.
 *
 * Server state is re-probed before the switch: a load may have finished
 * (minutes for big models), a model may have unloaded, or a down server may
 * have come back since the announce.
 */
async function autoSwitchToLoaded(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  candidates: LoadedCandidate[],
  current: { provider: string; id: string },
  reason: string,
): Promise<void> {
  if (!ctx.hasUI) return;

  const target = candidates.find((c) => c.server.id === current.provider) ?? candidates[0];
  if (!target) return;

  // Race guard: re-probe every server (loads, unloads and reconnects happen
  // while the announce and the probes run).
  const fresh = await gatherServers();
  const freshOwn = fresh.find((s) => s.server.id === current.provider);
  if (freshOwn?.ready && freshOwn.mode) {
    const ownLoaded = await new ModelInspector(freshOwn.server, {
      data: freshOwn.models,
      mode: freshOwn.mode,
    }).loadedModels().catch(() => []);
    if (ownLoaded.some((m) => matchModel(m, current.id))) {
      ctx.ui.notify(`${PROVIDER_NAME}: ${current.id} loaded in the meantime — kept current model`, "info");
      return;
    }
  }
  const freshServer = fresh.find((s) => s.server.id === target.server.id);
  if (!freshServer?.ready || !freshServer.mode) {
    ctx.ui.notify(`${target.server.name} unreachable — kept current model`, "warning");
    return;
  }
  const freshLoaded = await new ModelInspector(freshServer.server, {
    data: freshServer.models,
    mode: freshServer.mode,
  }).loadedModels().catch(() => []);
  const freshTarget = freshLoaded.find((m) => m.id === target.id);
  if (!freshTarget) {
    ctx.ui.notify(`${PROVIDER_NAME}: ${target.name} no longer loaded — kept current model`, "warning");
    return;
  }
  const ok = await switchPiModel(pi, ctx, freshServer.server, freshTarget);
  if (ok) {
    const label = freshTarget.aliases?.[0] || freshTarget.id;
    ctx.ui.notify(
      `${PROVIDER_NAME}: switched to ${label} on ${freshServer.server.name} — ${reason}`,
      "info",
    );
  }
}

// ── Extension Entry ───────────────────────────────────────────────────

// Pi-glue for the status bar (watch.ts): stale-safe theme + status access.
const watchGlue: WatchGlue = {
  getTheme: (ctx) => {
    try { return (ctx as ExtensionContext).ui.theme; } catch { return undefined; }
  },
  setStatus: (ctx, value) => setLlamaStatus(ctx as ExtensionContext, value),
};

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
      await loadModelCmd(pi, ctx, args.trim());
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
      await announceLoadedModels(serverInfo, ctx, pi);
    } catch {}
  });

  // ── Inflight Progress (auto-load) ───────────────────────────────────

  // No persistent server connection: the progress display runs only
  // while a provider request is in flight — see the
  // before/after_provider_request hooks below.

  pi.on("session_shutdown", async () => {
    stopInflightWatch();
    // Flush pending debounced writes before clearing
    flushModelsWrite();
    flushMetadataWrite();
    clearCaches();
    resetDiscoveryState();
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
    const model = ctx.model;
    const provider = (model as any)?.provider;
    if (!PROVIDER_IDS.includes(provider || "")) return;

    // Live progress in the status bar while the model auto-loads
    const server = resolveServers().find((s) => s.id === provider);
    if (server && model) {
      void startInflightWatch({ server, modelId: model.id, ctx, glue: watchGlue });
    }

    const budget = thinkingBudgetFor(model!, pi.getThinkingLevel());
    if (budget === undefined) return;

    return {
      ...(event.payload as Record<string, unknown>),
      thinking_budget_tokens: budget,
    };
  });

  // /props metadata after first successful provider response
  // (model is guaranteed loaded by this point — no race with model loading)
  pi.on("after_provider_response", (event, ctx) => {
    // Headers arrive when llama-server finishes the prompt — stop the
    // inflight watcher regardless of response status
    const provider = (ctx.model as any)?.provider;
    if (PROVIDER_IDS.includes(provider || "")) stopInflightWatch();

    if (!isLlamaStatusEnabled()) return;
    if (event.status !== 200) return;
    if (!ctx.model) return;
    if (!PROVIDER_IDS.includes(provider || "")) return;
    void discoverModelMetadata(provider, ctx.model.id, {
      notify: (msg, type) => {
        try { ctx.ui.notify(msg, type); } catch { /* stale context */ }
      },
      onStatus: (s) => setLlamaStatus(ctx, s),
      onUpdated: () => {
        void syncToModelsJson(undefined, (v) => setLlamaStatus(ctx, v)).catch(() => {});
      },
    });
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
        stopInflightWatch();
        setLlamaStatus(ctx, undefined);
      }
      ctx.ui.notify(next ? "Llama link enabled" : "Llama link disabled", next ? "info" : "warning");
    },
  });

}
