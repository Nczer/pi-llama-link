/**
 * sse.ts: stage/progress formatting (pure) and the connection lifecycle
 * against a local HTTP server (progress event delivery, no-SSE endpoint,
 * reconnect-waiting on connection failure).
 *
 * HOME is redirected to a temp dir BEFORE importing the module (server.ts
 * resolves the local URL from settings at call time; resolveServers'
 * settings load is HOME-bound).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "llama-link-sse-"));
process.env.HOME = home;
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

const sse = await import("../sse");

afterAll(() => {
  delete process.env.LLAMA_SERVER_URL;
  rmSync(home, { recursive: true, force: true });
});

const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

describe("formatStage", () => {
  it("known stages → labels, unknown → passthrough", () => {
    expect(sse.formatStage("fit_params")).toBe("fitting params");
    expect(sse.formatStage("text_model")).toBe("model");
    expect(sse.formatStage("mmproj_model")).toBe("mmproj");
    expect(sse.formatStage("custom_stage")).toBe("custom_stage");
  });
});

describe("formatLoadingProgress", () => {
  it("stage + percent (current field)", () => {
    expect(sse.formatLoadingProgress({ status: "loading", progress: { current: "text_model", value: 0.42 } }, theme))
      .toBe("· Loading model 42%");
  });
  it("fit_params hides the percent", () => {
    expect(sse.formatLoadingProgress({ status: "loading", progress: { current: "fit_params", value: 0.9 } }, theme))
      .toBe("· Loading fitting params...");
  });
  it("legacy stage field", () => {
    expect(sse.formatLoadingProgress({ status: "loading", progress: { stage: "mmproj_model", value: 1 } }, theme))
      .toBe("· Loading mmproj 100%");
  });
  it("loading without progress → dots", () => {
    expect(sse.formatLoadingProgress({ status: "loading" }, theme)).toBe("· Loading ...");
  });
  it("loaded → checkmark; anything else → empty", () => {
    expect(sse.formatLoadingProgress({ status: "loaded" }, theme)).toBe("✓ loaded");
    expect(sse.formatLoadingProgress({ status: "unloaded" }, theme)).toBe("");
  });
});

describe("SSE connection lifecycle (local HTTP server)", () => {
  const seen: Array<string | undefined> = [];
  const glue: sse.SseGlue = {
    getTheme: () => theme,
    setStatus: (_ctx, v) => seen.push(v),
  };

  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
  };

  it("delivers loading progress from /models/sse", async () => {
    let closeStream: () => void;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"model":"m1","event":"status_change","data":{"status":"loading","progress":{"current":"text_model","value":0.5}}}\n\n');
      closeStream = () => res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.LLAMA_SERVER_URL = `http://127.0.0.1:${(server.address() as any).port}`;

    sse.startSseForServer("llama-cpp", "fake-ctx", glue);
    expect(await waitFor(() => seen.length > 0)).toBe(true);
    expect(seen[0]).toBe("· Loading model 50%");
    expect(sse.isSseActive()).toBe(true);
    expect(sse.isSseActive("llama-cpp")).toBe(true);
    expect(sse.isSseActive("llama-cpp-remote")).toBe(false);

    // A clean stream close does not clear the active flag (existing
    // semantics — reconnect only happens on error); stopSse ends it.
    closeStream!();
    sse.stopSse();
    expect(sse.isSseActive()).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("404 /models/sse → no SSE (stopSse, inactive)", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.LLAMA_SERVER_URL = `http://127.0.0.1:${(server.address() as any).port}`;

    sse.startSseForServer("llama-cpp", "fake-ctx", glue);
    expect(await waitFor(() => !sse.isSseActive())).toBe(true);
    expect(sse.isSseActive()).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("connection failure → waiting to reconnect until stopSse", async () => {
    // Point at a port with nothing listening
    process.env.LLAMA_SERVER_URL = "http://127.0.0.1:1";

    sse.startSseForServer("llama-cpp", "fake-ctx", glue);
    // Survives the failed fetch: still marked active (reconnect pending)
    await new Promise((r) => setTimeout(r, 300));
    expect(sse.isSseActive("llama-cpp")).toBe(true);

    sse.stopSse();
    expect(sse.isSseActive()).toBe(false);
  });

  it("startSseForServer for an unknown server id → stays inactive", () => {
    sse.startSseForServer("nope", "fake-ctx", glue);
    expect(sse.isSseActive()).toBe(false);
  });
});
