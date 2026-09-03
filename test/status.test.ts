/**
 * status.ts: formatters and buildStatusLines (with an injected
 * ServerInfo[] — no live server needed).
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import {
  buildStatusLines,
  buildBorderDynamic,
  formatParams,
  formatBytes,
  formatMetrics,
} from "../status";
import type { ServerInfo } from "../server";

const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

describe("formatParams", () => {
  it("B/M/K/abs units and missing value", () => {
    expect(formatParams(undefined)).toBe("?");
    expect(formatParams(12_000_000_000)).toBe("12.0B");
    expect(formatParams(7_500_000)).toBe("7.5M");
    expect(formatParams(24_000)).toBe("24K");
    expect(formatParams(512)).toBe("512");
  });
});

describe("formatBytes", () => {
  it("GB/MB/KB and missing value", () => {
    expect(formatBytes(undefined)).toBe("?");
    expect(formatBytes(3 * 1_073_741_824)).toBe("3.0 GB");
    expect(formatBytes(512 * 1_048_576)).toBe("512 MB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
  });
});

describe("formatMetrics", () => {
  it("only renders non-null values, queue only when > 0", () => {
    expect(
      formatMetrics({
        kv_cache_usage_ratio: 0.42,
        kv_cache_tokens: 1234,
        prompt_tokens_per_second: 1500.5,
        predicted_tokens_per_second: 42.5,
        requests_processing: 2,
        requests_deferred: 0,
      }),
    ).toEqual(["KV Cache: 42.0%", "1,234 cached", "Gen: 42.5 tok/s", "Prefill: 1500.5 tok/s", "2 processing"]);
  });
  it("all null → empty", () => {
    expect(
      formatMetrics({
        kv_cache_usage_ratio: null,
        kv_cache_tokens: null,
        prompt_tokens_per_second: null,
        predicted_tokens_per_second: null,
        requests_processing: null,
        requests_deferred: null,
      }),
    ).toEqual([]);
  });
});

describe("buildBorderDynamic", () => {
  it("wraps lines, --- becomes a divider, width-pads", () => {
    const out = buildBorderDynamic(theme, ["hello", "---", "", "x"], 12);
    const hr10 = "─".repeat(10);
    expect(out[0]).toBe(`╭${hr10}╮`);
    expect(out[1]).toContain("hello");
    expect(out[2]).toBe("│" + hr10 + "│"); // divider
    expect(out[5]).toBe(`╰${hr10}╯`);
    // every row is exactly boxWidth columns (visible width)
    for (const line of out) expect(line.length).toBe(12);
  });
});

describe("buildStatusLines", () => {
  const routerServer: ServerInfo = {
    server: { id: "llama-cpp", name: "Local (127.0.0.1:8080)", url: "http://127.0.0.1:1" },
    ready: true,
    mode: "router",
    models: [
      {
        id: "real-1",
        aliases: ["short"],
        status: { value: "loaded", args: ["--ctx-size", "1024"] },
        architecture: { input_modalities: ["text", "image"] },
      },
      {
        id: "org/cache-entry",
        status: { value: "unloaded", args: ["--hf-repo", "org/cache-entry"] }, // auto-exposed — filtered
      },
    ],
  };
  const offlineServer: ServerInfo = {
    server: { id: "llama-cpp-remote", name: "Remote (r:1)", url: "http://r:1" },
    ready: false,
    models: [],
  };

  it("lists loaded models (alias name, ctx, active marker) and the model catalog", async () => {
    const lines = await buildStatusLines({ id: "short", provider: "llama-cpp" } as any, [
      routerServer,
      offlineServer,
    ]);
    expect(lines[0]).toBe("Local (127.0.0.1:8080)");
    expect(lines[1]).toBe("  🟢 short (loaded) ✓ active");
    expect(lines[2]).toBe("     Context: 1,024 tokens · Input: text, image");
    // auto-exposed cache entry is filtered from the catalog
    expect(lines.filter((l) => l.includes("org/cache-entry"))).toHaveLength(0);
    expect(lines.some((l) => l === "    🟢 short ← active")).toBe(true);
    // offline server rendered last
    expect(lines[lines.length - 2]).toBe("");
    expect(lines[lines.length - 1]).toBe("Remote (r:1) — ⬛ offline");
  });

  it("non-llama current model → no active markers", async () => {
    const lines = await buildStatusLines({ id: "gpt", provider: "other" } as any, [routerServer]);
    expect(lines.some((l) => l.includes("✓ active"))).toBe(false);
    expect(lines.some((l) => l.includes("← active"))).toBe(false);
  });

  it("empty single-mode server → No model loaded", async () => {
    // A ready-but-empty server is reachable in production; /props must
    // answer, so use a live stub instead of an unreachable URL.
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      if (_req.url === "/props") res.end(JSON.stringify({ is_sleeping: false }));
      else if (_req.url === "/models") res.end(JSON.stringify({ models: [], data: [] }));
      else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const lines = await buildStatusLines(undefined, [
        {
          server: { id: "llama-cpp", name: "Local", url: `http://127.0.0.1:${(server.address() as any).port}` },
          ready: true,
          mode: "single",
          models: [],
        },
      ]);
      expect(lines).toEqual(["Local", "  ⚪ No model loaded"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
