/**
 * sync.ts: alias-id resolution, change detection, and the full
 * sync-to-models.json path (local HTTP /models → debounced write → flush).
 *
 * HOME is redirected to a temp dir BEFORE importing the module because
 * the MODELS_JSON path binds at module load.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { setSampling } from "../sampling";

const home = mkdtempSync(join(tmpdir(), "llama-link-sync-"));
process.env.HOME = home;
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
const modelsFile = join(agentDir, "models.json");

const sync = await import("../sync");

afterAll(() => {
  delete process.env.LLAMA_SERVER_URL;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveApiIds", () => {
  it("first alias wins, real ids always reserved", () => {
    const ids = sync.resolveApiIds([
      { id: "real-1", aliases: ["short-1"] },
      { id: "real-2", aliases: ["short-2"] },
    ]);
    expect(ids.get("real-1")).toBe("short-1");
    expect(ids.get("real-2")).toBe("short-2");
  });

  it("alias colliding with another model's real id → real id", () => {
    const ids = sync.resolveApiIds([
      { id: "a", aliases: ["b"] }, // "b" is reserved (real id of model 2)
      { id: "b", aliases: ["c"] },
    ]);
    expect(ids.get("a")).toBe("a");
    expect(ids.get("b")).toBe("c");
  });

  it("duplicate aliases: first model claims, later falls back", () => {
    const ids = sync.resolveApiIds([
      { id: "x", aliases: ["same"] },
      { id: "y", aliases: ["same"] },
    ]);
    expect(ids.get("x")).toBe("same");
    expect(ids.get("y")).toBe("y");
  });
});

describe("modelsChanged", () => {
  const incoming = [{ id: "m1", contextWindow: 4096, input: ["text"], reasoning: false }];

  it("identical → false", () => {
    expect(sync.modelsChanged([{ id: "m1", contextWindow: 4096, input: ["text"], reasoning: false }], incoming)).toBe(false);
  });
  it("length / missing id → true", () => {
    expect(sync.modelsChanged([], incoming)).toBe(true);
    expect(sync.modelsChanged([{ id: "other", contextWindow: 4096, input: ["text"] }], incoming)).toBe(true);
  });
  it("legacy name field → true (strip on rewrite)", () => {
    expect(sync.modelsChanged([{ id: "m1", name: "M1", contextWindow: 4096, input: ["text"], reasoning: false }], incoming)).toBe(true);
  });
  it("contextWindow / reasoning / input drift → true", () => {
    expect(sync.modelsChanged([{ id: "m1", contextWindow: 8192, input: ["text"], reasoning: false }], incoming)).toBe(true);
    expect(sync.modelsChanged([{ id: "m1", contextWindow: 4096, input: ["text"], reasoning: true }], incoming)).toBe(true);
    expect(sync.modelsChanged([{ id: "m1", contextWindow: 4096, input: ["text", "image"], reasoning: false }], incoming)).toBe(true);
  });
});

describe("modelsJsonApiId", () => {
  const provider = "llama-cpp";
  const writeModels = (models: any[]) =>
    writeFileSync(modelsFile, JSON.stringify({ providers: { [provider]: { models } } }));

  afterAll(() => rmSync(modelsFile, { force: true }));

  it("alias id wins when the entry id is the first alias", () => {
    writeModels([{ id: "short-1" }, { id: "other" }]);
    expect(sync.modelsJsonApiId(provider, { id: "real-1", aliases: ["short-1", "alt-1"] })).toBe("short-1");
  });

  it("matches on the real id when no alias is exposed", () => {
    writeModels([{ id: "real-1" }]);
    expect(sync.modelsJsonApiId(provider, { id: "real-1", aliases: ["short-1"] })).toBe("real-1");
  });

  it("matches on a non-first alias", () => {
    writeModels([{ id: "alt-1" }]);
    expect(sync.modelsJsonApiId(provider, { id: "real-1", aliases: ["short-1", "alt-1"] })).toBe("alt-1");
  });

  it("unknown model / unknown provider / missing file → undefined", () => {
    writeModels([{ id: "short-1" }]);
    expect(sync.modelsJsonApiId(provider, { id: "nope", aliases: ["nope-alias"] })).toBeUndefined();
    expect(sync.modelsJsonApiId("llama-cpp-remote", { id: "real-1", aliases: ["short-1"] })).toBeUndefined();
    rmSync(modelsFile, { force: true });
    expect(sync.modelsJsonApiId(provider, { id: "real-1", aliases: ["short-1"] })).toBeUndefined();
  });
});

describe("syncToModelsJson (integration, local HTTP server)", () => {
  let server: http.Server;
  const notified: Array<string | undefined> = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          models: [
            { id: "real-1", aliases: ["short-1"], architecture: { input_modalities: ["text", "image"] }, meta: { n_ctx: 8192 } },
          ],
          data: [
            { id: "real-1", aliases: ["short-1"], architecture: { input_modalities: ["text", "image"] }, meta: { n_ctx: 8192 } },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.LLAMA_SERVER_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("writes the provider entry, drops stale providers, notifies", async () => {
    // Pre-seed a stale provider that is no longer resolved
    writeFileSync(modelsFile, JSON.stringify({ providers: { "llama-server": { models: [] } } }));

    const wrote = await sync.syncToModelsJson(undefined, (v) => notified.push(v));
    expect(wrote).toBe(true);
    sync.flushModelsWrite();

    const file = JSON.parse(readFileSync(modelsFile, "utf-8"));
    expect(Object.keys(file.providers)).toEqual(["llama-cpp"]);
    const provider = file.providers["llama-cpp"];
    expect(provider.api).toBe("openai-completions");
    expect(provider.baseUrl).toBe(process.env.LLAMA_SERVER_URL + "/v1");
    expect(provider.apiKey).toBe("sk-placeholder");
    expect(provider.models).toEqual([
      {
        id: "short-1", // alias as Pi id
        input: ["text", "image"],
        contextWindow: 8192,
        maxTokens: 8192,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    expect(notified[0]).toContain("models synced");
  });

  it("second sync with unchanged models → no write", async () => {
    const wrote = await sync.syncToModelsJson();
    expect(wrote).toBe(false);
  });
});

describe("syncToModelsJson with an unreported context size", () => {
  let server: http.Server;
  const notified: Array<string | undefined> = [];
  // Same model as above, but the server reports no meta.n_ctx and no --ctx-size.
  const models = [{ id: "real-1", aliases: ["short-1"], architecture: { input_modalities: ["text"] } }];

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models, data: models }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.LLAMA_SERVER_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("omits the field instead of inventing one, and discloses it", async () => {
    rmSync(modelsFile, { force: true });
    expect(await sync.syncToModelsJson(undefined, (v) => notified.push(v))).toBe(true);
    sync.flushModelsWrite();
    const entry = JSON.parse(readFileSync(modelsFile, "utf-8")).providers["llama-cpp"].models[0];
    // No 32768: pi applies its own default, and the user is told the size is unknown.
    expect(entry.contextWindow).toBeUndefined();
    expect(entry.maxTokens).toBeUndefined();
    expect(notified[0]).toContain("context size unknown for 1");
  });

  it("keeps the size models.json already records rather than losing it", async () => {
    writeFileSync(
      modelsFile,
      JSON.stringify({ providers: { "llama-cpp": { models: [{ id: "short-1", input: ["text"], contextWindow: 8192, maxTokens: 8192, reasoning: false }] } } }),
    );
    expect(await sync.syncToModelsJson(undefined, (v) => notified.push(v))).toBe(false); // unchanged → no rewrite
    const entry = JSON.parse(readFileSync(modelsFile, "utf-8")).providers["llama-cpp"].models[0];
    expect(entry.contextWindow).toBe(8192);
  });
});


// ── User-owned sampling config (modelOverrides, patch writes, parse tolerance)
describe("user sampling config in models.json", () => {
  // One fake server for the writes below: always reports short-1 @ 8192
  const srvModels = [{ id: "real-1", aliases: ["short-1"], architecture: { input_modalities: ["text", "image"] }, meta: { n_ctx: 8192 } }];
  let server: http.Server;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: srvModels, data: srvModels }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.LLAMA_SERVER_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("syncToModelsJson keeps it", () => {
    it("rewrites model entries without dropping modelOverrides, provider keys, or hand-written samplingParams", async () => {
      writeFileSync(
        modelsFile,
        JSON.stringify({
          providers: {
            "llama-cpp": {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "sk-placeholder",
              headers: { "x-user": "keep me" },
              models: [{
                id: "short-1",
                input: ["text", "image"],
                contextWindow: 4096, // stale on purpose: forces a rewrite
                maxTokens: 4096,
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                samplingParams: { temperature: 1 },
              }],
              modelOverrides: {
                "short-1": { samplingParamsByThinkingLevel: { off: { temperature: 0.2 } } },
                other: { contextWindow: 4096 },
              },
            },
          },
        }),
      );

      expect(await sync.syncToModelsJson()).toBe(true);
      sync.flushModelsWrite();

      const provider = JSON.parse(readFileSync(modelsFile, "utf-8")).providers["llama-cpp"];
      expect(provider.headers).toEqual({ "x-user": "keep me" });
      expect(provider.modelOverrides).toEqual({
        "short-1": { samplingParamsByThinkingLevel: { off: { temperature: 0.2 } } },
        other: { contextWindow: 4096 },
      });
      expect(provider.models[0].contextWindow).toBe(8192);
      expect(provider.models[0].samplingParams).toEqual({ temperature: 1 });
    });

    it("a carried samplingParams is not seen as drift (no rewrite churn)", async () => {
      expect(await sync.syncToModelsJson()).toBe(false);
    });
  });

  describe("patchModelsJson", () => {
    it("writes a mutation into modelOverrides", () => {
      writeFileSync(modelsFile, JSON.stringify({ providers: { "llama-cpp": { models: [{ id: "m1" }] } } }));
      expect(sync.patchModelsJson((cfg) => setSampling(cfg, "llama-cpp", "m1", "off", "top_k", 20))).toBe(true);
      expect(JSON.parse(readFileSync(modelsFile, "utf-8")).providers["llama-cpp"].modelOverrides)
        .toEqual({ m1: { samplingParamsByThinkingLevel: { off: { top_k: 20 } } } });
    });

    it("a no-op mutate does not touch the file", () => {
      const before = JSON.stringify({ providers: { "llama-cpp": { models: [{ id: "m1" }] } } });
      writeFileSync(modelsFile, before);
      expect(sync.patchModelsJson(() => false)).toBe(false);
      expect(readFileSync(modelsFile, "utf-8")).toBe(before);
    });

    it("flushes a pending debounced sync write first, so the patch survives it", async () => {
      rmSync(modelsFile, { force: true });
      expect(await sync.syncToModelsJson()).toBe(true); // schedules a debounced write
      sync.patchModelsJson((cfg) => setSampling(cfg, "llama-cpp", "short-1", "all", "temperature", 0.6));
      sync.flushModelsWrite(); // must not rewrite the pre-patch snapshot
      const provider = JSON.parse(readFileSync(modelsFile, "utf-8")).providers["llama-cpp"];
      expect(provider.models[0].id).toBe("short-1");
      expect(provider.modelOverrides).toEqual({ "short-1": { samplingParams: { temperature: 0.6 } } });
    });

    it("refuses an unparsable models.json instead of replacing it", () => {
      const broken = "{ providers: this is not json";
      writeFileSync(modelsFile, broken);
      expect(sync.patchModelsJson((cfg) => setSampling(cfg, "llama-cpp", "m1", "all", "top_k", 20))).toBe(false);
      expect(sync.modelsJsonUnreadable()).toBe(true);
      expect(readFileSync(modelsFile, "utf-8")).toBe(broken);
    });
  });

  describe("parsing tolerance", () => {
    it("comments and trailing commas read the way pi reads them (other providers survive)", async () => {
      writeFileSync(
        modelsFile,
        "\uFEFF{\n  // my own provider\n  \"providers\": {\n    \"ollama\": { \"baseUrl\": \"http://127.0.0.1:11434/v1\", \"models\": [{ \"id\": \"keep\" }], },\n  },\n}\n",
      );
      expect(await sync.syncToModelsJson()).toBe(true);
      sync.flushModelsWrite();
      const file = JSON.parse(readFileSync(modelsFile, "utf-8"));
      expect(Object.keys(file.providers).sort()).toEqual(["llama-cpp", "ollama"]);
      expect(file.providers.ollama.models[0].id).toBe("keep");
    });

    it("a // inside a string is not eaten", () => {
      writeFileSync(modelsFile, JSON.stringify({ providers: { ollama: { apiKey: "//not-a-comment" } } }));
      expect(sync.readModelsJson().providers.ollama.apiKey).toBe("//not-a-comment");
    });

    it("sync leaves a file it cannot parse untouched", async () => {
      const broken = "{ not json at all";
      writeFileSync(modelsFile, broken);
      expect(await sync.syncToModelsJson()).toBe(false);
      expect(sync.modelsJsonUnreadable()).toBe(true);
      expect(readFileSync(modelsFile, "utf-8")).toBe(broken);
    });
  });
});
