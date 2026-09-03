/**
 * server.ts pure parts: metrics parsing, load-progress parsing, context
 * size resolution, model matching, mode detection, error extraction,
 * api-key resolution, and server resolution.
 *
 * HOME is redirected to a temp dir BEFORE importing the module because
 * ext-settings binds SETTINGS_PATH at module load.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "llama-link-server-"));
process.env.HOME = home;
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });

const server = await import("../server");

afterAll(() => {
  delete process.env.LLAMA_SERVER_URL;
  rmSync(home, { recursive: true, force: true });
});

describe("extractError", () => {
  it("pulls llama.cpp error.message", () => {
    expect(server.extractError({ error: { code: 400, message: "model not found" } }, "fb")).toBe(
      "model not found",
    );
  });
  it("falls back on non-object or missing message", () => {
    expect(server.extractError("nope", "fb")).toBe("fb");
    expect(server.extractError(null, "fb")).toBe("fb");
    expect(server.extractError({ error: {} }, "fb")).toBe("fb");
  });
});

describe("detectMode", () => {
  it("models key present → single, absent → router", () => {
    expect(server.detectMode({ data: [] } as any)).toBe("router");
    expect(server.detectMode({ models: [], data: [] } as any)).toBe("single");
  });
});

describe("parsePrometheusMetrics", () => {
  const sample = [
    "# HELP llamacpp_kv_cache_usage_ratio usage ratio",
    "# TYPE llamacpp_kv_cache_tokens counter",
    "llamacpp:kv_cache_usage_ratio 0.42",
    "llamacpp:kv_cache_tokens 1234",
    "llamacpp:prompt_tokens_seconds 1500.5",
    "llamacpp:predicted_tokens_seconds 42.5",
    "llamacpp:requests_processing 2",
    "llamacpp:requests_deferred 0",
    "llamacpp:other_metric 99",
    "unrelated 1",
    "",
  ].join("\n");

  it("maps llamacpp:* gauges, skips comments/unknown lines", () => {
    expect(server.parsePrometheusMetrics(sample)).toEqual({
      kv_cache_usage_ratio: 0.42,
      kv_cache_tokens: 1234,
      prompt_tokens_per_second: 1500.5,
      predicted_tokens_per_second: 42.5,
      requests_processing: 2,
      requests_deferred: 0,
    });
  });

  it("empty text → all null", () => {
    const m = server.parsePrometheusMetrics("");
    expect(m.kv_cache_usage_ratio).toBeNull();
    expect(m.requests_processing).toBeNull();
  });
});

describe("parseLoadProgress", () => {
  it("current stage + ratio", () => {
    expect(server.parseLoadProgress({ progress: { current: "compute_0", value: 0.3 } })).toEqual({
      message: "Loading compute 0",
      ratio: 0.3,
    });
  });
  it("legacy stage field, ratio clamped to [0,1]", () => {
    expect(server.parseLoadProgress({ progress: { stage: "read_model", value: 1.5 } })).toEqual({
      message: "Loading read model",
      ratio: 1,
    });
  });
  it("value only → generic message", () => {
    expect(server.parseLoadProgress({ progress: { value: 0.7 } })).toEqual({
      message: "Loading model",
      ratio: 0.7,
    });
  });
  it("no progress → undefined", () => {
    expect(server.parseLoadProgress({})).toBeUndefined();
    expect(server.parseLoadProgress(null)).toBeUndefined();
    expect(server.parseLoadProgress({ progress: { stages: [] } })).toBeUndefined();
  });
});

describe("resolveContextSize", () => {
  const m = (over: Record<string, unknown>) => ({ id: "x", ...over });
  it("router args: --ctx-size and -c flags", () => {
    expect(server.resolveContextSize(m({ status: { value: "loaded", args: ["--ctx-size", "16384"] } }))).toBe(
      16384,
    );
    expect(server.resolveContextSize(m({ status: { value: "loaded", args: ["-c", "8192"] } }))).toBe(8192);
  });
  it("flag without a value falls through", () => {
    expect(server.resolveContextSize(m({ status: { value: "loaded", args: ["--fit-ctx"] } }))).toBe(32768);
  });
  it("single-mode meta.n_ctx, then n_ctx_train, fallback 32768", () => {
    expect(server.resolveContextSize(m({ meta: { n_ctx: 4096, n_ctx_train: 128000 } }))).toBe(4096);
    expect(server.resolveContextSize(m({ meta: { n_ctx: 0, n_ctx_train: 128000 } }))).toBe(128000);
    expect(server.resolveContextSize(m({}))).toBe(32768);
  });
});

describe("isAutoExposedCacheEntry", () => {
  it("true when --hf-repo arg equals the model id", () => {
    expect(
      server.isAutoExposedCacheEntry({
        id: "org/repo",
        status: { value: "loaded", args: ["--hf-repo", "org/repo", "-c", "4096"] },
      }),
    ).toBe(true);
  });
  it("false otherwise", () => {
    expect(
      server.isAutoExposedCacheEntry({
        id: "org/repo",
        status: { value: "loaded", args: ["--hf-repo", "other/repo"] },
      }),
    ).toBe(false);
    expect(server.isAutoExposedCacheEntry({ id: "org/repo" })).toBe(false);
  });
});

describe("matchModel", () => {
  it("matches id or alias", () => {
    expect(server.matchModel({ id: "real", aliases: ["short"] }, "real")).toBe(true);
    expect(server.matchModel({ id: "real", aliases: ["short"] }, "short")).toBe(true);
    expect(server.matchModel({ id: "real", aliases: ["short"] }, "other")).toBe(false);
    expect(server.matchModel({ id: "real" }, "short")).toBe(false);
  });
});

describe("resolveServers", () => {
  it("no settings file → single local server at the default url", () => {
    const servers = server.resolveServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe("llama-cpp");
    expect(servers[0].url).toBe("http://127.0.0.1:8080");
    expect(servers[0].name).toBe("Local (127.0.0.1:8080)");
  });

  it("settings remoteUrl adds a remote server (trailing slash stripped)", () => {
    writeFileSync(join(agentDir, "settings-ext.json"), JSON.stringify({ "llama-link": { remoteUrl: "http://remote:9999/" } }));
    server.resetSettingsCache();
    const servers = server.resolveServers();
    expect(servers.map((s) => s.id)).toEqual(["llama-cpp", "llama-cpp-remote"]);
    expect(servers[1].url).toBe("http://remote:9999");
    expect(servers[1].name).toBe("Remote (remote:9999)");
  });

  it("LLAMA_SERVER_URL env overrides the local url", () => {
    process.env.LLAMA_SERVER_URL = "http://override:1234//";
    const servers = server.resolveServers();
    expect(servers[0].url).toBe("http://override:1234");
    expect(servers[0].name).toBe("Local (override:1234)");
    delete process.env.LLAMA_SERVER_URL;
  });
});

describe("resolveApiKey", () => {
  it("placeholder when auth.json is absent (and cached thereafter)", () => {
    expect(server.resolveApiKey("llama-cpp")).toBe(server.API_KEY_PLACEHOLDER);
    // Cache is per-session: a later auth.json must not change this id's key
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "llama-cpp": { key: "k-cpp" } }));
    expect(server.resolveApiKey("llama-cpp")).toBe(server.API_KEY_PLACEHOLDER);
  });

  it("server-specific key wins, then any known provider key", () => {
    expect(server.resolveApiKey("llama-cpp-remote")).toBe("k-cpp");
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "llama-server": { key: "k-srv" } }));
    expect(server.resolveApiKey("llama-server")).toBe("k-srv");
  });
});
