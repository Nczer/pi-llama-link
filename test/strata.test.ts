/**
 * Strata backend support: kind detection via /health, and the
 * load/unload endpoint mapping (POST /load, POST /unload) against a
 * local HTTP server that emulates Strata's control-plane responses.
 *
 * HOME is redirected to a temp dir BEFORE importing the module
 * (server.ts' api-key resolution is HOME-bound).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "llama-link-strata-"));
process.env.HOME = home;
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

const server = await import("../server");

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// ── Fake servers ────────────────────────────────────────────────────────

interface Recorded { method?: string; url?: string; body?: string }

/**
 * Start a fake server. Every endpoint returns `json` (or `status` if set)
 * and records the last request; the `handlers` map overrides per path.
 * Unique server ids keep the kind cache from leaking across tests.
 */
const startFake = (
  id: string,
  handlers: Record<string, (req: Recorded, res: http.ServerResponse) => void>,
) =>
  new Promise<{ srv: http.Server; url: string; seen: Recorded[] }>((resolve) => {
    const seen: Recorded[] = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const rec: Recorded = { method: req.method, url: req.url, body };
        seen.push(rec);
        const path = req.url?.split("?")[0];
        const h = handlers[path];
        if (!h) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "not found" } }));
          return;
        }
        h(rec, res);
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      resolve({ srv, url: `http://127.0.0.1:${(srv.address() as any).port}`, seen });
    });
  });

const closeServer = (srv: http.Server) =>
  new Promise<void>((r) => srv.close(() => r()));

const json = (res: http.ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

const cfg = (id: string, url: string) => ({ id, name: "Fake", url });

// ── detectServer ────────────────────────────────────────────────────────

describe("detectServer", () => {
  it("Strata /health (model field) → strata + configured model", async () => {
    const { srv, url } = await startFake("strata-health", {
      "/health": (_r, res) =>
        json(res, 200, { status: "ok", max_context: 65536, model: "qwen4exp", images: false, api_key: false, loaded: true }),
    });
    try {
      const info = await server.detectServer(cfg("strata-health", url));
      expect(info).toEqual({ kind: "strata", strataModel: "qwen4exp" });
    } finally {
      await closeServer(srv);
    }
  });

  it("llama-server /health ({status:ok}) → llama-cpp", async () => {
    const { srv, url } = await startFake("llama-health", {
      "/health": (_r, res) => json(res, 200, { status: "ok" }),
    });
    try {
      const info = await server.detectServer(cfg("llama-health", url));
      expect(info).toEqual({ kind: "llama-cpp" });
    } finally {
      await closeServer(srv);
    }
  });

  it("unreachable → llama-cpp (safe default)", async () => {
    const info = await server.detectServer(cfg("dead-server", "http://127.0.0.1:1"));
    expect(info.kind).toBe("llama-cpp");
  });

  it("caches the first answer per server", async () => {
    let calls = 0;
    const { srv, url } = await startFake("strata-cache", {
      "/health": (_r, res) => {
        calls++;
        json(res, 200, calls === 1 ? { status: "ok", model: "m1" } : { status: "ok" });
      },
    });
    try {
      const first = await server.detectServer(cfg("strata-cache", url));
      const second = await server.detectServer(cfg("strata-cache", url));
      expect(first.kind).toBe("strata");
      expect(second).toEqual(first);
      expect(calls).toBe(1);
    } finally {
      await closeServer(srv);
    }
  });
});

// ── loadModel / unloadModelOnServer endpoint mapping ────────────────────

describe("loadModel", () => {
  it("strata → POST /load (empty body), not /models/load", async () => {
    const { srv, url, seen } = await startFake("strata-load", {
      "/health": (_r, res) => json(res, 200, { status: "ok", model: "m1", loaded: false }),
      "/load": (_r, res) => json(res, 200, { status: "loaded" }),
    });
    try {
      await server.loadModel(cfg("strata-load", url), "m1");
      const post = seen.find((r) => r.method === "POST");
      expect(post?.url).toBe("/load");
      expect(post?.body).toBe("{}");
      expect(seen.some((r) => r.url === "/models/load")).toBe(false);
    } finally {
      await closeServer(srv);
    }
  });

  it("llama-cpp → POST /models/load with the model id", async () => {
    const { srv, url, seen } = await startFake("llama-load", {
      "/health": (_r, res) => json(res, 200, { status: "ok" }),
      "/models/load": (_r, res) => json(res, 200, {}),
    });
    try {
      await server.loadModel(cfg("llama-load", url), "m2");
      const post = seen.find((r) => r.method === "POST");
      expect(post?.url).toBe("/models/load");
      expect(JSON.parse(post?.body || "")).toEqual({ model: "m2" });
    } finally {
      await closeServer(srv);
    }
  });

  it("strata GPU busy (503) → error carries Strata's message", async () => {
    const { srv, url } = await startFake("strata-busy", {
      "/health": (_r, res) => json(res, 200, { status: "ok", model: "m1", loaded: false }),
      "/load": (_r, res) =>
        json(res, 503, { error: { type: "server_error", message: "the GPU is in use by another program" } }),
    });
    try {
      await expect(server.loadModel(cfg("strata-busy", url), "m1")).rejects.toThrow(
        "the GPU is in use by another program",
      );
    } finally {
      await closeServer(srv);
    }
  });
});

describe("unloadModelOnServer", () => {
  it("strata → POST /unload, not /models/unload", async () => {
    const { srv, url, seen } = await startFake("strata-unload", {
      "/health": (_r, res) => json(res, 200, { status: "ok", model: "m1", loaded: true }),
      "/unload": (_r, res) => json(res, 200, { status: "unloaded" }),
    });
    try {
      await server.unloadModelOnServer(cfg("strata-unload", url), "m1");
      const post = seen.find((r) => r.method === "POST");
      expect(post?.url).toBe("/unload");
      expect(seen.some((r) => r.url === "/models/unload")).toBe(false);
    } finally {
      await closeServer(srv);
    }
  });

  it("strata busy (409) → HTTP 409 error", async () => {
    const { srv, url } = await startFake("strata-unload-busy", {
      "/health": (_r, res) => json(res, 200, { status: "ok", model: "m1", loaded: true }),
      "/unload": (_r, res) => json(res, 409, { status: "busy" }),
    });
    try {
      await expect(server.unloadModelOnServer(cfg("strata-unload-busy", url), "m1")).rejects.toThrow(
        /HTTP 409/,
      );
    } finally {
      await closeServer(srv);
    }
  });

  it("llama-cpp → POST /models/unload with the model id", async () => {
    const { srv, url, seen } = await startFake("llama-unload", {
      "/health": (_r, res) => json(res, 200, { status: "ok" }),
      "/models/unload": (_r, res) => json(res, 200, {}),
    });
    try {
      await server.unloadModelOnServer(cfg("llama-unload", url), "m2");
      const post = seen.find((r) => r.method === "POST");
      expect(post?.url).toBe("/models/unload");
      expect(JSON.parse(post?.body || "")).toEqual({ model: "m2" });
    } finally {
      await closeServer(srv);
    }
  });
});

// ── loadModelAndWait against a fake Strata ─────────────────────────────

describe("loadModelAndWait (strata)", () => {
  it("reports loading before the blocking /load, then settles on /models", async () => {
    let loadDone = false;
    const unloaded = { data: [{ id: "m1", status: { value: "unloaded" } }] };
    const loaded = { data: [{ id: "m1", status: { value: "loaded" } }] };
    const { srv, url } = await startFake("strata-wait", {
      "/health": (_r, res) => json(res, 200, { status: "ok", model: "m1", loaded: false }),
      "/load": (_r, res) => {
        // block briefly like a real cold start, then answer
        setTimeout(() => { loadDone = true; json(res, 200, { status: "loaded" }); }, 60);
      },
      "/models": (_r, res) => json(res, 200, loadDone ? loaded : unloaded),
    });
    try {
      const statuses: Array<string | undefined> = [];
      let statusBeforeLoad = false;
      await server.loadModelAndWait(cfg("strata-wait", url), "m1", (s) => {
        statuses.push(s);
        if (s === "· Loading model..." && !loadDone) statusBeforeLoad = true;
      });
      expect(statusBeforeLoad).toBe(true); // status set while /load is still blocking
      expect(statuses[statuses.length - 1]).toBeUndefined(); // cleared on finish
    } finally {
      await closeServer(srv);
    }
  });

  it("keeps polling while /models lists nothing (engine starting, data:[])", async () => {
    let tick = 0;
    const { srv, url } = await startFake("strata-wait-empty", {
      "/health": (_r, res) => json(res, 200, { status: "ok", model: "m1", loaded: false }),
      "/load": (_r, res) => setTimeout(() => json(res, 200, { status: "loaded" }), 50),
      "/models": (_r, res) => json(res, 200, ++tick < 4 ? { data: [] } : { data: [{ id: "m1", status: { value: "loaded" } }] }),
    });
    try {
      await server.loadModelAndWait(cfg("strata-wait-empty", url), "m1");
      expect(tick).toBeGreaterThanOrEqual(4); // survived the empty-listing window
    } finally {
      await closeServer(srv);
    }
  });
});
