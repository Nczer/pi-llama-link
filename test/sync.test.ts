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
