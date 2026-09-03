/**
 * status.ts — the `/llama-model` status overlay: builds the plain-text
 * status lines for all servers and renders them in a TUI overlay.
 *
 * buildStatusLines accepts a pre-fetched ServerInfo[] (same seam as
 * syncToModelsJson) so the line-building logic is testable without a live
 * server.
 */
import type {
  ExtensionCommandContext,
  ProviderModelConfig,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
  gatherServers,
  ModelInspector,
  matchModel,
  isAutoExposedCacheEntry,
  PROVIDER_IDS,
  PROVIDER_NAME,
  type ServerInfo,
  type MetricsData,
} from "./server";

const STATUS_ICONS: Record<string, string> = {
  loaded: "🟢",
  loading: "🟡",
  sleeping: "🔵",
  unloaded: "⚪",
  failed: "🔴",
  offline: "⬛",
};

/**
 * A focused overlay renders on every TUI pass, but keyboard input routes to
 * the FOCUSED component — so when another UI (a consult/quiz/halter prompt,
 * a native selector, …) takes focus, this overlay would stay visible while
 * being impossible to dismiss. Render-time check: if we are visible but no
 * longer focused, close ourselves so the prompt underneath is reachable.
 * getFocusedComponent() is a TUI class method (used by pi's interactive mode)
 * that is NOT on the public TUI interface; if a future pi removes it, the
 * check is skipped and plain Esc/q close remains.
 */
function makePreemptClose(tui: any, self: unknown, done: () => void): boolean {
  const getFocused = tui?.getFocusedComponent;
  if (typeof getFocused !== "function") return false;
  if (getFocused.call(tui) !== self) {
    done();
    return true; // pre-empted — caller should return [] for this frame
  }
  return false;
}

export function buildBorderDynamic(theme: Theme, lines: string[], boxWidth: number): string[] {
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

export function formatParams(n: number | undefined): string {
  if (!n) return "?";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes) return "?";
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function formatMetrics(m: MetricsData): string[] {
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

export async function buildStatusLines(
  current: ProviderModelConfig | undefined,
  serverInfo?: ServerInfo[],
): Promise<string[]> {
  const info = serverInfo ?? (await gatherServers());
  const currentProvider = (current as any)?.provider;
  const isLlamaModel = current && PROVIDER_IDS.includes(currentProvider);
  const lines: string[] = [];

  for (const { server, ready, models, mode } of info) {
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

export async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
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
