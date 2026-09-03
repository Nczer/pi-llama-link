/**
 * metadata.ts: the debounced overlay store, key migration/stale cleanup,
 * overlay application, and lazy /props discovery (against a local HTTP
 * server).
 *
 * HOME is redirected to a temp dir BEFORE importing the module because
 * the METADATA_JSON path binds at module load.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "llama-link-metadata-"));
process.env.HOME = home;
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
const metadataFile = join(agentDir, "llama-metadata.json");

const md = await import("../metadata");

afterAll(() => {
  md.flushMetadataWrite();
  rmSync(home, { recursive: true, force: true });
});

describe("loadMetadataOverlay", () => {
  it("missing file → empty overlay", () => {
    expect(md.loadMetadataOverlay()).toEqual({});
  });

  it("parses the persisted file", () => {
    writeFileSync(metadataFile, JSON.stringify({ "llama-cpp": { "m1": { contextWindow: 4096 } } }));
    expect(md.loadMetadataOverlay()).toEqual({ "llama-cpp": { "m1": { contextWindow: 4096 } } });
    rmSync(metadataFile);
  });
});

describe("persistModelMetadata", () => {
  it("merges into existing entries (no full replace)", () => {
    writeFileSync(metadataFile, JSON.stringify({ "llama-cpp": { "m1": { thinking: "toggle" } } }));
    md.persistModelMetadata("llama-cpp", "m1", { contextWindow: 8192 });
    md.flushMetadataWrite();
    expect(JSON.parse(readFileSync(metadataFile, "utf-8"))["llama-cpp"]["m1"]).toEqual({
      thinking: "toggle",
      contextWindow: 8192,
    });
    rmSync(metadataFile);
  });
});

describe("migrateMetadataKeys", () => {
  it("re-keys real ids to alias ids, alias-keyed entries win", () => {
    const overlay: md.ModelMetadata = {
      "llama-cpp": {
        "real-a": { contextWindow: 100 },
        "alias-b": { contextWindow: 200 }, // pre-existing alias entry
        "real-b": { contextWindow: 300 },
      },
    };
    const apiIds = new Map([["real-a", "alias-a"], ["real-b", "alias-b"]]);
    expect(md.migrateMetadataKeys(overlay, "llama-cpp", apiIds)).toBe(true);
    expect(overlay["llama-cpp"]).toEqual({
      "alias-a": { contextWindow: 100 },
      "alias-b": { contextWindow: 200 },
    });
  });

  it("no change when ids are unchanged or server unknown", () => {
    const overlay: md.ModelMetadata = { "llama-cpp": { "a": {} } };
    expect(md.migrateMetadataKeys(overlay, "llama-cpp", new Map([["a", "a"]]))).toBe(false);
    expect(md.migrateMetadataKeys(overlay, "other", new Map([["x", "y"]]))).toBe(false);
  });
});

describe("cleanupStaleMetadata", () => {
  it("prunes removed models, keeps unreachable servers, drops empty entries", () => {
    const overlay: md.ModelMetadata = {
      "llama-cpp": { "kept": {}, "gone": {} },
      "llama-cpp-remote": { "whatever": {} }, // unreachable — untouched
      "llama-server": {}, // reachable but no valid models
    };
    const valid = new Map([["llama-cpp", new Set(["kept"])]]);
    md.cleanupStaleMetadata(overlay, valid, ["llama-cpp", "llama-server"]);
    expect(overlay).toEqual({
      "llama-cpp": { kept: {} },
      "llama-cpp-remote": { whatever: {} },
    });
  });
});

describe("applyMetadataOverlay", () => {
  it("effort entry → thinking config with levels/aliases/off", () => {
    const model: Record<string, any> = { id: "m1" };
    const overlay: md.ModelMetadata = {
      "llama-cpp": {
        "m1": {
          thinking: "effort",
          effortLevels: ["xhigh", "medium", "low"],
          effortAliases: { high: "xhigh" },
          effortOff: true,
        },
      },
    };
    md.applyMetadataOverlay(model, "llama-cpp", overlay);
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap.off).toBe("none"); // off path enabled
    expect(model.compat.chatTemplateKwargs["enable_thinking"]).toBeDefined();
  });

  it("toggle entry → enable_thinking toggle; contextWindow overrides both caps", () => {
    const model: Record<string, any> = { id: "m1", contextWindow: 4096, maxTokens: 4096 };
    const overlay: md.ModelMetadata = {
      "llama-cpp": { "m1": { thinking: "toggle", contextWindow: 32768 } },
    };
    md.applyMetadataOverlay(model, "llama-cpp", overlay);
    expect(model.compat.chatTemplateKwargs["enable_thinking"]).toEqual({ "$var": "thinking.enabled" });
    expect(model.contextWindow).toBe(32768);
    expect(model.maxTokens).toBe(32768);
  });

  it("no entry → model untouched", () => {
    const model: Record<string, any> = { id: "unknown" };
    md.applyMetadataOverlay(model, "llama-cpp", { "llama-cpp": {} });
    expect(model).toEqual({ id: "unknown" });
  });
});

describe("discoverModelMetadata (integration, local HTTP server)", () => {
  let server: http.Server;
  let requests = 0;
  const seen: Array<{ notify?: string; status?: string; updated?: boolean }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/props")) {
        requests++;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            is_sleeping: false,
            chat_template: "{%- if enable_thinking is defined -%}x{%- endif -%}",
            default_generation_settings: { n_ctx: 12345 },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    process.env.LLAMA_SERVER_URL = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    delete process.env.LLAMA_SERVER_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches /props, classifies the style, persists, and triggers onUpdated", async () => {
    await md.discoverModelMetadata("llama-cpp", "disc-model", {
      notify: (msg) => { seen.push({ notify: msg }); },
      onStatus: (s) => { seen.push({ status: s }); },
      onUpdated: () => { seen.push({ updated: true }); },
    });
    expect(requests).toBe(1);
    md.flushMetadataWrite();
    const stored = JSON.parse(readFileSync(metadataFile, "utf-8"));
    expect(stored["llama-cpp"]["disc-model"]).toEqual({
      thinking: "toggle",
      contextWindow: 12345,
    });
    expect(seen.some((s) => s.updated)).toBe(true);
  });

  it("does not re-fetch an already-discovered model", async () => {
    await md.discoverModelMetadata("llama-cpp", "disc-model");
    expect(requests).toBe(1);
  });

  it("unknown server id → no fetch", async () => {
    await md.discoverModelMetadata("nope", "whatever");
    expect(requests).toBe(1);
  });
});
