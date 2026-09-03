import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtSettings, patchExtSettings } from "../ext-settings";

let dir: string;
let file: string;

const DEFAULTS = { enabled: true, serverUrl: "http://127.0.0.1:8080", remoteUrl: null };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llama-link-test-"));
  file = join(dir, "settings-ext.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadExtSettings", () => {
  it("materializes defaults into the file when it is missing", () => {
    expect(loadExtSettings("llama-link", DEFAULTS, file)).toEqual(DEFAULTS);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "llama-link": DEFAULTS });
  });

  it("merges file values per key and preserves unknown keys", () => {
    writeFileSync(file, JSON.stringify({ "llama-link": { serverUrl: "http://1.2.3.4:9999", extra: 1 } }));
    const s = loadExtSettings("llama-link", DEFAULTS, file);
    expect(s).toEqual({ ...DEFAULTS, serverUrl: "http://1.2.3.4:9999", extra: 1 } as any);
  });

  it("writes back materialized keys without clobbering other extensions", () => {
    writeFileSync(file, JSON.stringify({ "other-ext": { keep: true }, "llama-link": { enabled: false } }));
    const s = loadExtSettings("llama-link", DEFAULTS, file);
    expect(s.enabled).toBe(false);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw["other-ext"]).toEqual({ keep: true });
    expect(raw["llama-link"].serverUrl).toBe("http://127.0.0.1:8080");
  });

  it("treats a non-object namespace as defaults", () => {
    writeFileSync(file, JSON.stringify({ "llama-link": "corrupt-string" }));
    expect(loadExtSettings("llama-link", DEFAULTS, file)).toEqual(DEFAULTS);
  });

  it("backups and ignores a corrupt file (bad JSON)", () => {
    writeFileSync(file, "{ not json");
    expect(loadExtSettings("llama-link", DEFAULTS, file)).toEqual(DEFAULTS);
    expect(existsSync(file + ".bak")).toBe(true);
  });

  it("backups and ignores a non-object top level", () => {
    writeFileSync(file, "[1, 2, 3]");
    expect(loadExtSettings("llama-link", DEFAULTS, file)).toEqual(DEFAULTS);
    expect(existsSync(file + ".bak")).toBe(true);
  });
});

describe("patchExtSettings", () => {
  it("patches keys and preserves other extensions", () => {
    writeFileSync(file, JSON.stringify({ other: { a: 1 }, "llama-link": { enabled: true } }));
    patchExtSettings("llama-link", { enabled: false }, file);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.other).toEqual({ a: 1 });
    expect(raw["llama-link"].enabled).toBe(false);
  });

  it("deletes keys patched to undefined", () => {
    writeFileSync(file, JSON.stringify({ "llama-link": { remoteUrl: "http://x" } }));
    patchExtSettings("llama-link", { remoteUrl: undefined }, file);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw["llama-link"].remoteUrl).toBeUndefined();
  });

  it("creates the namespace when absent", () => {
    patchExtSettings("llama-link", { enabled: false }, file);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw["llama-link"]).toEqual({ enabled: false });
  });
});
