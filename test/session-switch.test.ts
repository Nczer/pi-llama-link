/**
 * index.ts model-switching glue: the session-start offer (the current model is
 * unusable when its own server doesn't answer or it isn't loaded there, and any
 * loaded model on a reachable server is then a candidate, cross-server) and the
 * /llama-load server choice (pinned to the current model's provider only while
 * that server answers).
 *
 * HOME is redirected to a temp dir BEFORE importing index.ts (settings,
 * models.json and the metadata store are HOME-bound).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "llama-link-switch-"));
process.env.HOME = home;
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });

const mod: any = await import("../index");
const server = await import("../server");

/** Minimal router-mode fake: /models listing + /models/load|unload. */
async function fakeRouter(models: Record<string, string>): Promise<string> {
  const s = await new Promise<http.Server>((resolve) => {
    const srv = http.createServer((req, res) => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const url = (req.url || "").split("?")[0];
      if (url === "/models") {
        return send(200, { data: Object.entries(models).map(([id, value]) => ({ id, status: { value } })) });
      }
      if (url === "/models/load" || url === "/models/unload") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const { model } = JSON.parse(body || "{}");
          models[model] = url === "/models/load" ? "loaded" : "unloaded";
          send(200, { success: true });
        });
        return;
      }
      send(404, { error: { code: 404, message: "not found" } });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as any).port}`;
}
const servers: http.Server[] = [];
afterAll(() => {
  servers.forEach((s) => s.close());
  rmSync(home, { recursive: true, force: true });
});

const DEAD = "http://127.0.0.1:1"; // connection refused

function useSettings(serverUrl: string, remoteUrl: string | null): void {
  writeFileSync(join(agentDir, "settings-ext.json"), JSON.stringify({
    "llama-link": { enabled: true, serverUrl, remoteUrl },
  }));
  server.resetSettingsCache();
}

interface Run { notices: string[]; dialog?: { question: string; options: string[] }; setModels: string[] }

/** Drives one session_start (or one /llama-load) through the real handler. */
async function run(
  model: { provider: string; id: string },
  cmd?: [string, string],
  pick?: (options: string[]) => string | undefined,
): Promise<Run> {
  const handlers: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const setModels: string[] = [];
  const pi: any = {
    on: (name: string, h: any) => { handlers[name] = h; },
    registerCommand: (name: string, def: any) => { commands[name] = def.handler; },
    getThinkingLevel: () => "low",
    setModel: async (m: any) => { setModels.push(`${m.provider}/${m.id}`); return true; },
  };
  mod.default(pi);

  const notices: string[] = [];
  let dialog: Run["dialog"];
  const ctx: any = {
    model,
    hasUI: true,
    ui: {
      notify: (m: string, t?: string) => { notices.push(`${t ?? "info"}: ${m}`); },
      select: async (q: string, opts: string[]) => {
        dialog = { question: q, options: opts };
        return pick ? pick(opts) : opts[0];
      },
      setStatus: () => {},
      theme: undefined,
    },
    modelRegistry: {
      refresh: async () => {},
      find: (provider: string, id: string) => ({ provider, id }),
    },
  };

  if (cmd) await commands[cmd[0]](cmd[1], ctx);
  else await handlers.session_start({}, ctx);
  await handlers.session_shutdown?.({}, ctx);
  return { notices, dialog, setModels };
}

const portOf = (url: string) => url.replace(/^https?:\/\//, "");

describe("session-start switch", () => {
  it("offers a loaded model on another server when the current one is unreachable", async () => {
    const live = await fakeRouter({ m1: "unloaded", m2: "loaded" });
    useSettings(DEAD, live);
    const r = await run({ provider: "llama-cpp", id: "m1" });

    expect(r.notices).toContain(`warning: Llama.cpp: Local (${portOf(DEAD)}) unreachable — current model llama-cpp/m1`);
    expect(r.dialog?.options).toEqual([`m2 — Remote (${portOf(live)})`, "Keep current model"]);
    expect(r.setModels).toEqual(["llama-cpp-remote/m2"]);
  });

  it("keeps the current model when the user declines", async () => {
    const live = await fakeRouter({ m1: "unloaded", m2: "loaded" });
    useSettings(DEAD, live);
    const r = await run({ provider: "llama-cpp", id: "m1" }, undefined, (o) => o[o.length - 1]);
    expect(r.setModels).toEqual([]);
  });

  it("still offers same-server switches (no server suffix when one server is involved)", async () => {
    const live = await fakeRouter({ m1: "unloaded", m2: "loaded" });
    useSettings(live, null);
    const r = await run({ provider: "llama-cpp", id: "m1" });
    expect(r.dialog?.options).toEqual(["m2", "Keep current model"]);
    expect(r.setModels).toEqual(["llama-cpp/m2"]);
    expect(r.notices.some((n) => /unreachable/.test(n))).toBe(false);
  });

  it("offers nothing when the current model is loaded where it belongs", async () => {
    const live = await fakeRouter({ m1: "unloaded", m2: "loaded" });
    useSettings(live, null);
    const r = await run({ provider: "llama-cpp", id: "m2" });
    expect(r.dialog).toBeUndefined();
    expect(r.setModels).toEqual([]);
    expect(r.notices).toContain(`info: Llama.cpp: m2 loaded on Local (${portOf(live)}) — current model`);
  });

  it("waits instead of offering while the current model is still loading", async () => {
    const live = await fakeRouter({ m1: "loading", m2: "loaded" });
    useSettings(live, null);
    const r = await run({ provider: "llama-cpp", id: "m1" });
    expect(r.dialog).toBeUndefined();
    expect(r.setModels).toEqual([]);
  });

  it("announces loaded models but never offers for a non-llama current model", async () => {
    const live = await fakeRouter({ m1: "unloaded", m2: "loaded" });
    useSettings(DEAD, live);
    const r = await run({ provider: "anthropic", id: "claude" });
    expect(r.dialog).toBeUndefined();
    expect(r.setModels).toEqual([]);
    expect(r.notices).toContain(`info: Llama.cpp: m2 loaded on Remote (${portOf(live)})`);
    expect(r.notices.some((n) => /unreachable/.test(n))).toBe(false);
  });
});

describe("/llama-load server choice", () => {
  it("falls back to the reachable server when the pinned one is down", async () => {
    const live = await fakeRouter({ m1: "unloaded", m2: "loaded" });
    useSettings(DEAD, live);
    const r = await run({ provider: "llama-cpp", id: "m1" }, ["llama-load", "m1"]);
    expect(r.notices).toContain(`warning: Local (${portOf(DEAD)}) unreachable — using Remote (${portOf(live)})`);
    expect(r.notices).toContain(`info: Loaded m1 on Remote (${portOf(live)})`);
    expect(r.setModels).toEqual(["llama-cpp-remote/m1"]);
  });

  it("loads an explicit id on the server that actually has it", async () => {
    const a = await fakeRouter({ a1: "unloaded" });
    const b = await fakeRouter({ b1: "unloaded" });
    useSettings(a, b);
    const r = await run({ provider: "llama-cpp", id: "a1" }, ["llama-load", "b1"]);
    expect(r.notices).toContain(`info: b1 is on Remote (${portOf(b)}), not Local (${portOf(a)}) — loading there`);
    expect(r.setModels).toEqual(["llama-cpp-remote/b1"]);
  });

  it("asks which server when the pinned provider is absent and both answer", async () => {
    const a = await fakeRouter({ a1: "unloaded" });
    const b = await fakeRouter({ b1: "unloaded" });
    useSettings(a, b);
    // "llama-server" is a legacy provider id that no configured server owns
    const r = await run({ provider: "llama-server", id: "a1" }, ["llama-load", "a1"]);
    expect(r.dialog?.question).toBe("Load model on which server:");
    expect(r.dialog?.options).toEqual([`Local (${portOf(a)})`, `Remote (${portOf(b)})`]);
    expect(r.setModels).toEqual(["llama-cpp/a1"]);
  });

  it("errors when no configured server answers", async () => {
    useSettings(DEAD, "http://127.0.0.1:2");
    const r = await run({ provider: "llama-cpp", id: "m1" }, ["llama-load", "m1"]);
    expect(r.notices).toContain(`error: Local (${portOf(DEAD)}) unreachable`);
    expect(r.setModels).toEqual([]);
  });
});
