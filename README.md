# llama-link

Llama.cpp server integration link, model load/unload, and `models.json` sync for Pi.

Requires Pi ≥ 0.80.6 (uses the `max` thinking tier).

## Commands

| Command | Description |
|---------|-------------|
| `/llama-model` | Overlay popup showing server status, model metadata, slots, metrics, and available models |
| `/llama-unload` | Unload the current model if it's from a llama.cpp provider |
| `/llama-load` | Open model picker to load a model (router mode); Pi's current model switches to it |
| `/llama-load <id>` | Load a specific model by ID (router mode); Pi's current model switches to it |
| `/llama-sampling` | Tune generation sampling per thinking level (writes `models.json` `modelOverrides`) |
| `/llama-version` | Print `llama-server --version` output |

## Servers

One local server always present. Remote server is opt-in.

| Provider ID | Default | Configurable |
|-------------|---------|--------------|
| `llama-cpp` | `http://127.0.0.1:8080` | Yes (see below) |
| `llama-cpp-remote` | None (opt-in) | Yes (`remoteUrl`) |

### URL Resolution (local server)

Priority order: `LLAMA_SERVER_URL` env → `serverUrl` setting → `127.0.0.1:8080`.

### URL Resolution (remote server)

`remoteUrl` setting → omitted if not set. Set to `""` to explicitly disable.

## Settings

`llama-link` namespace of `~/.pi/agent/settings-ext.json` (managed by `ext-settings.ts`; defaults are materialized on first load, corrupt files are auto-backed up as `.bak`):

| Setting | Default | Description |
|---------|---------|-------------|
| `serverUrl` | `http://127.0.0.1:8080` | Local server URL (overridden by env var) |
| `remoteUrl` | None | Remote server URL (opt-in) |

Loading is all-or-nothing: pi auto-scans `~/.pi/agent/extensions/`, so to silence the extension move its folder out (e.g. `llama-link.disabled`) and `/reload`, or run `pi --no-extensions`.

## Inflight Progress

**Zero API calls while pi is idle.** There is no persistent server connection: a per-request watcher runs only between `before_provider_request` and `after_provider_response` (llama-server sends response headers when the prompt is done, so the window covers the whole request). Loads triggered by *other* clients of the same server are never shown.

One initial `/models` probe per request: the request triggered an auto-load (model not loaded / waking from sleep) → an ephemeral `/models/sse` stream provides instant percentage updates (`· Loading model 42%`, stages: `fit_params` → `text_model` → `mmproj_model`), and a slow `/models` heartbeat (2s) is the source of truth — it covers the queueing gap before the first SSE event, sleeping wake-ups, stream drops, and servers without SSE (no progress data → `· Loading ...`). The watcher stops when the model becomes loaded.

- **SSE is optional**: progress data only exists in the SSE stream (`/models` never carries it); a missing SSE endpoint degrades to dots-only display
- **Update dedup**: status bar only updates when the string changes; the heartbeat never overwrites a fresher SSE display
- **Lifecycle**: the watcher stops on response, on session shutdown, or after a 30-min safety cap; it clears the status slot only if it set it (never clobbers other status content)

The `/llama-load` command has its own progress display (SSE with polling fallback, `loadModelAndWait`) — independent of the watcher.

## Auto-Sync

Syncs model metadata to `~/.pi/agent/models.json` whenever models are needed — there is no manual sync command:

- `session_start`
- after model metadata is (re)discovered from a server
- when `/llama-load` opens its picker, so a model added to a server mid-session becomes loadable
- before a model switch, when the entry the switch needs is missing from `models.json`
- when `/llama-sampling` finds no entry for the provider

- `id`, `input` (capabilities), `contextWindow`, `maxTokens` (no `name` field — Pi displays the id). `contextWindow`/`maxTokens` are omitted when neither the server nor models.json records a size.
- Model `id` uses the model's first alias when present (e.g. `Qwen3.8-27B` instead of `Qwen3.8-27B-Q4_K_XL`). llama.cpp resolves aliases on every endpoint (`/v1/chat/completions`, `/props`, `/slots`, `/models/load|unload`), so the alias is directly usable as the request model. Real ids are always reserved; on alias collision the first model wins.
- Persisted metadata (`llama-metadata.json`) is re-keyed from old real ids to alias ids on sync, so thinking/context overrides survive
- Sampling config (`samplingParams`, `samplingParamsByThinkingLevel`) already on a model entry is carried into the rebuilt entry, and `modelOverrides` is spread untouched — a sync never drops tuning
- Skips write if model list and context windows are unchanged
- **Nothing is rewritten without a change**: `modelsChanged()` gates a sync, `setSampling` reports no change when the value is already there or there is nothing to clear, `persistModelMetadata` skips an identical re-persist (the same `/props` answer every session), `patchExtSettings`/`loadExtSettings` skip a patch that changes nothing
- Each server writes under its own provider key
- Filters out auto-exposed HF cache entries (undefined models like `unsloth/Qwen3.6-27B-MTP-GGUF:Q4_K_XL`)
- Removes provider entries for servers no longer configured (e.g., remote URL unset)
- **Parse tolerance**: `models.json` is read with JSON comments and a BOM stripped (same treatment pi gives it), so a hand-annotated file is not mistaken for an empty one. When the file still cannot be parsed, every writer (`sync`, `/llama-sampling`) leaves it alone and reports the problem instead of rewriting it. Note that a write that *does* happen re-serializes the file, so hand-written comments in it are not preserved

## Session Start

The `session_start` sync reuses a single `/models` fetch per server for both sync and the loaded-model notice:

- **Notice per loaded model**: `Llama.cpp: {model} {status} on {server}` — suffixed `— current model` when it matches the model Pi has selected
- **Unreachable server owning the current model** → `Llama.cpp: {server} unreachable — current model {provider}/{id}` (without it the session starts on a dead model with no explanation)
- **Auto-switch** when Pi's current llama model is *unusable* — its own server doesn't answer, or it isn't loaded there — while some reachable server has a model loaded (skipped while a load is in flight): it switches and reports `Llama.cpp: switched to {model} on {server} — {reason}`. Candidates come from **any** reachable server, so a dead local server plus a loaded remote model still switches. The pick is deterministic: a model on the current model's own server first (switching inside one server changes less than switching servers), otherwise probe order — server order as configured, then that server's own model-list order. Server state is re-probed *before* the switch: a load may have finished (minutes for big models), a model may have unloaded, or a down server may have come back since the announce, so the switch is skipped when the current model is now loaded or the candidate isn't. Headless modes (`hasUI` false) do nothing — `ctx.ui.notify` is a no-op there, and changing the model of a run nobody is watching is worse than leaving it alone
- **Model switch plumbing** (used by both `/llama-load` and the session-start switch): `modelsJsonApiId()` (sync.ts) finds the models.json id of a server model; when the model is missing from models.json a fresh sync + flush runs first, then `ctx.modelRegistry.refresh({ providers: [id] })` re-reads models.json (no `/reload` needed) and `pi.setModel()` switches

## Thinking Support

Autodetects thinking capability from each model's chat template via `/props` (`chat_template` + `chat_template_caps`), classified in `thinking-style.ts`:

- **effort style** (Qwen3.8, Muse Glimmer, DeepSeek V4, Kimi-K3, etc.) — template consumes an effort string variable: `reasoning_effort` and/or `reasoning_strength` (standard; detected via the `supports_reasoning_effort` cap, template-text fallback for older builds) or `thinking_effort` (Kimi-K3 family; text detection only). Only the variable name(s) the template actually references are emitted as `chatTemplateKwargs` keys (each bound to the same effort string); caps-only detection (no template text) falls back to emitting the two standard names.
  - **Only levels the template actually distinguishes are exposed** (never clamped). The tier set is parsed from the template's own effort-variable usage: `== 'v'` / `!= 'v'` / `in [...]` / `not in [...]` comparisons, plus `set <effort var> = 'v'` / `else 'v'` defaults. E.g. DeepSeek V4 (checks only `== 'max'`) exposes off/max, V4-Flash off/high/max, tencent Hy3 off→`no_think`/low/high, upstage Solar minimal/low/high, Cohere2MoE off only, Kimi-K3 low/high/max (off inexpressible — its off gate is a `thinking` boolean, not an effort token).
  - **Free-form templates** (gpt-oss, Muse Glimmer — effort string interpolated into the prompt, no comparables) get the generic set low/medium/high/xhigh.
  - Heuristic fallbacks for templates whose comparisons don't fit the scoped patterns (e.g. Qwen3.8 compares an alias variable `resolved_reasoning_effort`): unscoped `not in ('xhigh', 'medium', 'low')` tuple, then the `raise_exception('... Supported types are ...')` message.
  - `off` is exposed when the template gates on `enable_thinking` (payload `none`) or names an off-token in its effort vocabulary (`none`/`off`/`no_think`), which becomes the payload value for off.
- **enable_thinking toggle** (Gemma4, DeepSeek V3.1, etc.) → boolean toggle via `chatTemplateKwargs`, `thinkingFormat: "chat-template"`. Levels off/low/high/max exposed; budget tokens differentiate low vs high.

DeepSeek templates gate on `thinking` in `{% if ... %}` form (never `{{ thinking }}`), so they land in the two styles above: V3.1 as toggle, V4+ as effort.

`thinking_budget_tokens` is injected for a subset of levels (`low` → 512, `high` → 8192); `medium` is intentionally unmapped and falls back to the server's default budget.

Discovered metadata (style + parsed tiers/aliases) is persisted to `llama-metadata.json` and applied on every model sync.

## Sampling Tuning

`/llama-sampling` tunes generation sampling per thinking level. Config is written to `~/.pi/agent/models.json` under the provider's `modelOverrides` — the layer pi merges last and llama-link's own syncs never overwrite:

```json
"providers": {
  "llama-cpp": {
    "modelOverrides": {
      "Qwen3.8-27B": {
        "samplingParams": { "temperature": 0.7 },
        "samplingParamsByThinkingLevel": { "off": { "temperature": 0.2 }, "max": { "top_k": 20 } }
      }
    }
  }
}
```

### Layers

pi merges the layers per key at request time (`resolveSamplingParams`, `packages/ai/src/api/simple-options.ts`) and `Object.assign`s the result onto the request body (`openai-completions.ts:1006`):

1. **server startup values** — nothing configured → the server's own `--temperature` / `--top-k` / `--top-p` / `--min-p`. llama-link ships no defaults of its own.
2. **flat `samplingParams`** — applies to every thinking level.
3. **`samplingParamsByThinkingLevel[<level>]`** — wins over the flat layer for that level.

pi clamps the thinking level *before* the lookup (`clampThinkingLevel`), so an entry for a level the model does not expose is dead config; `/llama-sampling` offers `all levels (global)` plus the exposed ones only (`getSupportedThinkingLevels`). A `samplingParams` written directly on the `models[]` entry works as well and sits *underneath* `modelOverrides`: the UI reads and displays the combined view (`effectiveOverride`), and clearing removes the override layer only.

### Keys

| Key | Valid | Meaning |
|-----|-------|---------|
| `temperature` | ≥ 0 | `0` = greedy, `1` = neutral, higher = more random |
| `top_p` | > 0, ≤ 1 | `1` = no nucleus truncation |
| `top_k` | integer ≥ 0 | `0` = full vocabulary (llama-server) |
| `min_p` | 0..1 | `0` = off |

Any other key the server accepts (`repeat_penalty`, `typical_p`, `min_keep`, `dry_*`, `grammar`, …) reaches the server as-is — the whole map is assigned onto the request body — so those are a hand-edit away; the command curates the four above.

### Command flow

1. **model** — picker when several llama models are synced, otherwise the current model
2. **target** — `all levels (global)` plus the levels pi exposes for that model, each showing what it contributes: `high — own: temp 0.20`, `low — same as global`, `all levels (global) — set: temp 0.70 · top_p 0.90`
3. **key** — the four keys, annotated with where the value comes from: `temperature = 0.20 (this level)`, `top_p = 0.90 (same as global)`, `top_k = 40 (server)`, `min_p — unset`. Inside the `all levels (global)` list the same value reads `(global)`
4. **value** — the hint line explains the key; empty input clears that key for that target, and the prompt names what it then falls back to (`… empty removes it → server 40`)
5. **back to the key list** — after a write the same list is shown again with fresh annotations, so temperature, top_p, top_k can be tuned in a row. Escape walks back the way pi's own selectors do — value → keys → targets → out of the command — and pi already prints `↑↓ navigate · Enter select · Esc cancel` under every list, so the command adds no nav items of its own

A value that is already set in the layer being edited, or a clear where the layer owns nothing, reports where the number actually comes from instead of writing. Only exposed levels are offered: pi clamps the requested level before the lookup, so an entry for a hidden level never applies.

The write goes through `patchModelsJson` (flush the debounced sync write → read → mutate → atomic write). Only the two sampling keys inside `modelOverrides[<id>]` are touched; an override entry is removed when it becomes completely empty, and one that still holds other settings (`contextWindow`, …) is kept. The command refuses to write when `models.json` cannot be parsed.

**Applying**: pi composes the `Model` object before the write, so a change to the current model is re-applied once per command run — `modelRegistry.refresh({ providers: [id] })` re-reads models.json, `pi.setModel()` re-composes the model, and the thinking level is captured and restored (pi re-derives it from settings on any switch, `agent-session.ts` `_getThinkingLevelForModelSwitch`; the switch adds one model-change entry to the transcript, however many keys were tuned). A change to another model reports that it applies when you switch.

**Reading it back**: `/llama-model` prints the values in effect for the active model — `Sampling [off]: temp 0.20 · top_k 40` — or, with nothing tuned, the server's own values marked `(server defaults)`, taken from the persisted `/props` metadata.

### Backend notes

- **llama-server**: unset keys keep the startup config; `temperature 0` is greedy (`tools/server/server-schema.cpp:118`). Per-model startup values are reported as `/props` `default_generation_settings.params` (`tools/server/server-context.cpp:4604`), fetched by the lazy discovery as `/props?model=<id>&autoload=false` and persisted in `llama-metadata.json`. A model that has never answered `/props` shows `server values unknown`.
- **Strata**: an absent `temperature` is greedy and `temperature=0` is not forwarded (`Strata/serve/server.py:300-301`); the sampled path takes `top_k` 1..64 (`serve/server.py:2755-2757`).


## Architecture

**Modules**

- `index.ts` — pi glue: hooks, commands, TUI (status overlay), inflight-watch lifecycle, metadata overlay + sync orchestration, model switching (`switchPiModel`/`switchToLoaded`, session-start `autoSwitchToLoaded`)
- `server.ts` — server layer: server resolution + per-server auth, `rpc()` JSON client + SSE stream parsing, endpoint helpers (`fetchSlots`/`fetchMetrics`/`fetchV1Models`/`loadModel`), `detectMode`, `resolveContextSize`, load-wait state machine (`loadModelAndWait`), cached `ModelInspector`. No pi runtime dependency.
- `metadata.ts` — per-server:model capability metadata (thinking style, context window) persisted to `llama-metadata.json`: debounced store, key migration + stale pruning, overlay application, lazy `/props` discovery
- `thinking-style.ts` — pure style classification + template-derived tier exposure over /props data (no pi dependency)
- `thinking.ts` — applies the discovered style to Pi model configs (level maps, compat kwargs) and decides `thinking_budget_tokens` injection
- `sampling.ts` — sampling tuning: key/level vocabulary, value validation, server defaults from `/props`, exposed-level and level-clamp mirroring of pi, the effective (model entry + modelOverrides) view, `setSampling` writes + pruning, status-line formatting
- `sync.ts` — `models.json` sync: alias-based ids (`resolveApiIds`, `modelsJsonApiId` lookup), change detection, debounced write + flush, stale-provider pruning; applies the metadata overlay per model
- `watch.ts` — per-request progress watcher (auto-load): ephemeral `/models/sse` percentage updates + `/models` heartbeat as source of truth, status-bar display; all pi access via injected `WatchGlue`
- `status.ts` — the `/llama-model` overlay: `buildStatusLines` (accepts a pre-fetched `ServerInfo[]`) + border rendering
- `ext-settings.ts` — loads/patches the `llama-link` namespace of `settings-ext.json` (defaults merge, corrupt-file auto-backup; hosts shared `atomicWrite`)

**Key functions**

- `ModelInspector.status(id)` — router: from `/models` data; single: from `/props`. Returns `loaded|loading|sleeping|unloaded|failed`
- `buildStatusLines(current)` — gathers all data, returns plain string lines
- `buildBorderDynamic(theme, lines, width)` — wraps lines in box-drawing border using `visibleWidth()` for emoji-safe padding

## Status Display

The `/llama-model` overlay shows per-server:
- **Model info**: name, status, context size, input modalities
- **Metadata** (from `/v1/models`): params, vocab size, file size, training context
- **Active generation** (from `/slots`): active/total slots, tokens decoded, remaining
- **Metrics** (from `/metrics`, requires `--metrics` flag): KV cache %, gen/prefill tok/s, queue depth
- **Available models**: all registered models with status icons
- **Sampling** (active model only): values in effect for the current thinking level, tuned or server-default, from models.json + `llama-metadata.json` — no API call

## Gotchas

- **Emoji width**: use `visibleWidth()` from `@earendil-works/pi-tui`, not `.length`. Emojis (🟢⚪⬛📊▶) are 2 terminal columns. Using `.length` causes border overflow/glitch.
- **Overlay**: `render(width)` must use the `width` param from Pi for the border. Fixed widths cause clipping on narrow terminals.
- **Overlay options**: use `width: "80%"`, `minWidth: 70`, `maxHeight: "90%"` for responsive sizing.
- **Router mode**: `/props` returns router-level info only. Status and context size come from `/models` `status.args`. Slots/metrics need `?model=X` query param.
- **Metrics requires `--metrics`**: `/metrics` returns 501 if server started without `--metrics` flag. Gracefully degrades (shows nothing).
- **Slots may be disabled**: `/slots` can be disabled with `--no-slots`. Gracefully degrades.
- **Context size is never invented**: it comes from `/models` `status.args` (`--ctx-size`, `-c`, `-ctx`, `--fit-ctx`) or `meta.n_ctx`/`n_ctx_train`. When the server reports none, the last size models.json already recorded is kept; if there is none, the field is left out (Pi applies its own default) and the sync notification reports how many models have an unknown size. `/llama-model` shows `Context: unknown`.
- **Remote is opt-in**: no default remote URL. Must be set explicitly in `settings-ext.json` (`llama-link` namespace).
- **Provider IDs**: both `llama-server` and `llama-cpp` are accepted for unload checks.
- **Multi-server**: `rpc` takes a `ServerConfig`, not a global URL. All helpers are per-server.
- **V1 models ID matching**: `/v1/models` reports real ids only (and may return full paths); match by checking if ID ends with the model id from `/models`.
- **Aliases as Pi ids**: models.json uses each model's first alias as the id when present; `/llama-load <alias>`, status display, and `/llama-unload` all resolve aliases against the server's `/models` data.
- **Metrics parsing**: Prometheus text format — skip `#` comments, split on last space for value.
- **Load UI**: `/llama-load` with no args shows `ctx.ui.select` picker. With an arg, loads directly.
- **Load server**: `/llama-load` prefers the server owning the current model, but only while it answers — otherwise it falls back to the reachable ones (one → use it with a warning, several → ask). An explicit id that lives on another reachable server is loaded there instead.
- **Switch candidates are cross-server**: the session-start offer keys on the current model being unusable (server down or model not loaded), not on which provider the loaded model belongs to.
- **Sampling config lives in `modelOverrides`, never in `settings-ext.json`**: pi owns `settings.json` and validates `models.json` with TypeBox (`model-config.ts`), and an unknown key there invalidates the whole file — which is why `/llama-sampling` writes only the keys pi accepts, and why the extension never invents sampling defaults.
- **Thinking level survives a live re-apply**: `pi.setModel` re-derives the level from settings (per-model default > global default > current session), so `reapplyModel` restores the session level explicitly afterwards.

## Development

- Tests: `npx vitest run` — module-level tests (`thinking-style`, `thinking`, `server`, `metadata`, `sync`, `sampling`, `watch`, `status`, `ext-settings`), incl. local-HTTP integration for discovery, sync, and the inflight watcher (load phase) plus the index.ts switch glue (`session-switch.test.ts`: session-start offer, cross-server candidates, `/llama-load` server choice); the remaining pi glue is verified in a live session
- Run `pi --extension .../index.ts` and test the hooks and commands in a live session
