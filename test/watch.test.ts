/**
 * watch.ts: load-progress formatting (pure) and the watcher lifecycle
 * against a local HTTP server (load-phase display, load→stop handoff,
 * stop semantics).
 *
 * HOME is redirected to a temp dir BEFORE importing the module (server.ts'
 * api-key resolution is HOME-bound).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "llama-link-watch-"));
process.env.HOME = home;
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

const watch = await import("../watch");

afterAll(() => {
  watch.stopInflightWatch();
  rmSync(home, { recursive: true, force: true });
});

const theme: any = { fg: (_c: string, s: string) => s };

const modelEntry = (value: string, over: Record<string, unknown> = {}) => ({
  id: "m1",
  status: { value, ...over },
});

// ── Formatting ─────────────────────────────────────────────────────────

describe("formatStage", () => {
  it("known stages → labels, unknown → passthrough", () => {
    expect(watch.formatStage("fit_params")).toBe("fitting params");
    expect(watch.formatStage("text_model")).toBe("model");
    expect(watch.formatStage("mmproj_model")).toBe("mmproj");
    expect(watch.formatStage("custom_stage")).toBe("custom_stage");
  });
});

describe("formatLoadingProgress", () => {
  it("stage + percent (current field)", () => {
    expect(watch.formatLoadingProgress({ status: "loading", progress: { current: "text_model", value: 0.42 } }, theme))
      .toBe("· Loading model 42%");
  });
  it("fit_params hides the percent", () => {
    expect(watch.formatLoadingProgress({ status: "loading", progress: { current: "fit_params", value: 0.9 } }, theme))
      .toBe("· Loading fitting params...");
  });
  it("legacy stage field", () => {
    expect(watch.formatLoadingProgress({ status: "loading", progress: { stage: "mmproj_model", value: 1 } }, theme))
      .toBe("· Loading mmproj 100%");
  });
  it("loading without progress → dots", () => {
    expect(watch.formatLoadingProgress({ status: "loading" }, theme)).toBe("· Loading ...");
  });
  it("non-loading status → empty", () => {
    expect(watch.formatLoadingProgress({ status: "loaded" }, theme)).toBe("");
    expect(watch.formatLoadingProgress({ status: "sleeping" }, theme)).toBe("");
  });
});

// ── Watcher lifecycle (local HTTP server) ──────────────────────────────

describe("watcher lifecycle (local HTTP server)", () => {
  const startServer = (opts: { models?: unknown[] }) =>
    new Promise<http.Server>((resolve) => {
      let m = 0;
      const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/models")) {
          const body = opts.models
            ? opts.models[Math.min(m++, opts.models.length - 1)]
            : { data: [modelEntry("loaded")] };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });

  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
  };

  const cfg = (url: string) => ({ id: "llama-cpp", name: "Local", url });

  const glueFor = (seen: Array<string | undefined>): watch.WatchGlue => ({
    getTheme: () => theme,
    setStatus: (_c, v) => seen.push(v),
  });

  it("load phase shows % while the model loads, then stops when loaded", async () => {
    const loading = (v: number) => ({ data: [modelEntry("loading", { progress: { current: "text_model", value: v } })] });
    const server = await startServer({
      // first entry is consumed by the initial probe
      models: [loading(0.42), loading(0.7), loading(0.8), { data: [modelEntry("loaded")] }],
    });
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const seen: Array<string | undefined> = [];

    await watch.startInflightWatch({ server: cfg(url), modelId: "m1", ctx: "fake", glue: glueFor(seen), pollMs: 25 });
    expect(watch.isInflightWatchActive()).toBe(true);
    expect(await waitFor(() => seen.some((s) => s?.includes("80%")))).toBe(true);
    expect(await waitFor(() => !watch.isInflightWatchActive())).toBe(true); // loaded → self-stop
    expect(await waitFor(() => seen.some((s) => s === undefined))).toBe(true); // status cleared on stop

    expect(seen[0]).toBe("· Loading model 70%");
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("already-loaded model at probe → no watch, no status writes", async () => {
    const server = await startServer({
      models: [{ data: [modelEntry("loaded")] }],
    });
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const seen: Array<string | undefined> = [];

    await watch.startInflightWatch({ server: cfg(url), modelId: "m1", ctx: "fake", glue: glueFor(seen), pollMs: 25 });
    expect(watch.isInflightWatchActive()).toBe(false);
    expect(seen).toEqual([]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("sleeping model (wake-up) → dots, then stops when loaded", async () => {
    const server = await startServer({
      models: [
        { data: [modelEntry("sleeping")] }, // probe
        { data: [modelEntry("sleeping")] }, // poll 1 → dots
        { data: [modelEntry("loaded")] },   // poll 2 → stop
      ],
    });
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const seen: Array<string | undefined> = [];

    await watch.startInflightWatch({ server: cfg(url), modelId: "m1", ctx: "fake", glue: glueFor(seen), pollMs: 25 });
    expect(await waitFor(() => seen.some((s) => s === "· Loading ..."))).toBe(true);
    expect(await waitFor(() => !watch.isInflightWatchActive())).toBe(true);
    expect(await waitFor(() => seen.some((s) => s === undefined))).toBe(true);

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("stop clears a visible status", async () => {
    const loading = (v: number) => ({ data: [modelEntry("loading", { progress: { current: "text_model", value: v } })] });
    const server = await startServer({
      models: [loading(0.42), loading(0.7)],
    });
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const seen: Array<string | undefined> = [];

    await watch.startInflightWatch({ server: cfg(url), modelId: "m1", ctx: "fake", glue: glueFor(seen), pollMs: 25 });
    expect(await waitFor(() => seen.length > 0)).toBe(true);

    watch.stopInflightWatch();
    expect(seen.at(-1)).toBeUndefined();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("unreachable server → inactive, no status writes", async () => {
    const seen: Array<string | undefined> = [];

    await watch.startInflightWatch({ server: cfg("http://127.0.0.1:1"), modelId: "m1", ctx: "fake", glue: glueFor(seen), pollMs: 25 });
    expect(watch.isInflightWatchActive()).toBe(false);
    expect(seen).toEqual([]);
  });
});
