/**
 * sampling.ts: value validation, level exposure/clamping (mirroring pi),
 * merge order, and the modelOverrides editor. No file or network access.
 */
import { describe, it, expect } from "vitest";
import {
  SAMPLING_KEYS,
  serverSamplingDefaults,
  parseSamplingValue,
  exposedLevels,
  clampLevel,
  effectiveLevel,
  effectiveSampling,
  readOverride,
  effectiveOverride,
  setSampling,
  carriesSampling,
  sameSampling,
  carrySamplingFields,
  describeOverride,
  keyProvenance,
  formatKeyItem,
  formatTargetItem,
  formatSampling,
  samplingStatusLine,
  num,
  type SamplingOverride,
} from "../sampling";

describe("serverSamplingDefaults", () => {
  it("cherry-picks the tuned keys out of /props params", () => {
    expect(
      serverSamplingDefaults({
        default_generation_settings: { params: { temperature: 0.8, top_p: 0.95, top_k: 40, min_p: 0.05, seed: 42, samplers: ["greedy"] } },
      }),
    ).toEqual({ temperature: 0.8, top_p: 0.95, top_k: 40, min_p: 0.05 });
  });
  it("missing / non-numeric params → undefined", () => {
    expect(serverSamplingDefaults(undefined)).toBeUndefined();
    expect(serverSamplingDefaults({ default_generation_settings: {} })).toBeUndefined();
    expect(serverSamplingDefaults({ default_generation_settings: { params: { seed: 1 } } })).toBeUndefined();
  });
});

describe("parseSamplingValue", () => {
  it("accepts in-range values, including 0 where it is meaningful", () => {
    expect(parseSamplingValue("temperature", "0")).toEqual({ value: 0 });
    expect(parseSamplingValue("temperature", " 1.2 ")).toEqual({ value: 1.2 });
    expect(parseSamplingValue("top_p", "1")).toEqual({ value: 1 });
    expect(parseSamplingValue("top_k", "0")).toEqual({ value: 0 });
    expect(parseSamplingValue("min_p", "0")).toEqual({ value: 0 });
  });
  it("rejects out-of-range, non-numeric and fractional top_k", () => {
    expect(parseSamplingValue("temperature", "-0.2").error).toContain("greedy");
    expect(parseSamplingValue("top_p", "0").error).toContain("no truncation");
    expect(parseSamplingValue("top_p", "1.5").error).toContain("top_p");
    expect(parseSamplingValue("top_k", "2.5").error).toContain("whole number");
    expect(parseSamplingValue("top_k", "-1").error).toContain("whole number");
    expect(parseSamplingValue("min_p", "2").error).toContain("min_p");
    expect(parseSamplingValue("min_p", "abc").error).toContain("expected a number");
    expect(parseSamplingValue("temperature", "NaN").error).toContain("expected a number");
    expect(parseSamplingValue("temperature", "").error).toContain("expected a number");
  });
  it("every key validates with a key-appropriate value", () => {
    expect(parseSamplingValue("temperature", "0.5").value).toBe(0.5);
    expect(parseSamplingValue("top_p", "0.5").value).toBe(0.5);
    expect(parseSamplingValue("top_k", "5").value).toBe(5);
    expect(parseSamplingValue("min_p", "0.5").value).toBe(0.5);
  });
});

// pi's own rule (models.ts): no reasoning → ["off"]; xhigh/max need an explicit
// thinkingLevelMap entry; null removes a level.
const fullModel = { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
const reasoningModel = { reasoning: true };
const flatModel = { reasoning: false };

describe("exposedLevels", () => {
  it("non-reasoning model → off only", () => expect(exposedLevels(flatModel)).toEqual(["off"]));
  it("reasoning without a map → no xhigh/max", () =>
    expect(exposedLevels(reasoningModel)).toEqual(["off", "minimal", "low", "medium", "high"]));
  it("map with null entries removes levels", () =>
    expect(exposedLevels({ reasoning: true, thinkingLevelMap: { minimal: null, low: null, max: "max" } })).toEqual([
      "off", "medium", "high", "max",
    ]));
  it("full map → all seven levels", () =>
    expect(exposedLevels(fullModel)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]));
});

describe("clampLevel", () => {
  it("climbs first, then descends (pi's search order)", () => {
    const supported = ["off", "low", "high"];
    expect(clampLevel("medium", supported as any)).toBe("high");
    expect(clampLevel("max", supported as any)).toBe("high");
    expect(clampLevel("minimal", supported as any)).toBe("low");
    expect(clampLevel("high", supported)).toBe("high");
  });
  it("unknown level → first supported", () => {
    expect(clampLevel("ultra" as any, ["low", "high"])).toBe("low");
    expect(clampLevel("high", [])).toBe("off");
  });
});

describe("effectiveLevel", () => {
  const settings = {
    defaultThinkingLevel: "medium",
    modelThinkingLevels: { "llama-cpp/m1": "xhigh", "llama-cpp/m2": "max" },
  };
  it("per-model default wins over the global one", () => {
    expect(effectiveLevel(fullModel, "llama-cpp", "m1", settings, "low")).toEqual({
      level: "xhigh",
      source: "per-model default",
    });
  });
  it("global default, then the current session level", () => {
    expect(effectiveLevel(fullModel, "llama-cpp", "nope", settings, "low").source).toBe("global default");
    expect(effectiveLevel(fullModel, "llama-cpp", "nope", {}, "low")).toEqual({
      level: "low",
      source: "current session",
    });
  });
  it("reports the level pi actually runs when settings ask for an unexposed one", () => {
    // m2 asks for "max", the model does not expose it → pi clamps down to high
    expect(effectiveLevel(reasoningModel, "llama-cpp", "m2", settings, "low")).toEqual({
      level: "high",
      source: "per-model default",
      clampedFrom: "max",
    });
    // non-reasoning model: everything collapses to "off"
    expect(effectiveLevel(flatModel, "llama-cpp", "m1", settings, "low").level).toBe("off");
  });
});

describe("effectiveSampling", () => {
  const server = { temperature: 0.8, top_p: 0.95, top_k: 40, min_p: 0.05 };
  const override: SamplingOverride = {
    samplingParams: { temperature: 1.0, top_p: 0.9 },
    samplingParamsByThinkingLevel: { off: { temperature: 0.2 } },
  };
  it("server < flat < level (pi's merge order)", () => {
    expect(effectiveSampling(override, server, "high")).toEqual({
      temperature: 1.0, top_p: 0.9, top_k: 40, min_p: 0.05,
    });
    expect(effectiveSampling(override, server, "off")).toEqual({
      temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.05,
    });
  });
  it("nothing configured → the server's own values", () => {
    expect(effectiveSampling(undefined, server, "low")).toEqual(server);
    expect(effectiveSampling(undefined, undefined, "low")).toEqual({});
  });
});

describe("setSampling", () => {
  const base = () => ({
    providers: {
      "llama-cpp": {
        models: [{ id: "m1", contextWindow: 8192 }],
        modelOverrides: { m1: { samplingParams: { temperature: 1 } } },
      },
    },
  });

  it("writes a flat value under modelOverrides", () => {
    const config = base();
    expect(setSampling(config, "llama-cpp", "m1", "all", "top_k", 20)).toBe(true);
    expect(config.providers["llama-cpp"].modelOverrides.m1.samplingParams).toEqual({
      temperature: 1, top_k: 20,
    });
  });
  it("creates the modelOverrides block when the provider has none", () => {
    const config = { providers: { "llama-cpp": { models: [{ id: "m1" }] } } };
    setSampling(config, "llama-cpp", "m1", "high", "min_p", 0.1);
    expect(config.providers["llama-cpp"].modelOverrides).toEqual({
      m1: { samplingParamsByThinkingLevel: { high: { min_p: 0.1 } } },
    });
  });
  it("clearing a level key prunes the empty level and then the container", () => {
    const config = base();
    setSampling(config, "llama-cpp", "m1", "off", "temperature", 0.2);
    expect(config.providers["llama-cpp"].modelOverrides.m1.samplingParamsByThinkingLevel).toEqual({
      off: { temperature: 0.2 },
    });
    setSampling(config, "llama-cpp", "m1", "off", "temperature", undefined);
    expect(config.providers["llama-cpp"].modelOverrides.m1.samplingParamsByThinkingLevel).toBeUndefined();
  });
  it("an override left with no sampling anywhere is deleted (no dead keys)", () => {
    const config = base();
    setSampling(config, "llama-cpp", "m1", "all", "temperature", undefined);
    expect(config.providers["llama-cpp"].modelOverrides).toBeUndefined();
  });
  it("reports no change when the value is already there (no needless write)", () => {
    const config = base();
    const snapshot = JSON.parse(JSON.stringify(config));
    expect(setSampling(config, "llama-cpp", "m1", "all", "temperature", 1)).toBe(false);
    expect(JSON.stringify(config)).toBe(JSON.stringify(snapshot));
  });
  it("reports no change when there is nothing to clear", () => {
    const config = base();
    const snapshot = JSON.parse(JSON.stringify(config));
    expect(setSampling(config, "llama-cpp", "m1", "high", "top_k", undefined)).toBe(false);
    expect(JSON.stringify(config)).toBe(JSON.stringify(snapshot));
  });
  it("keeping a non-sampling override key is left alone", () => {
    const config = { providers: { "llama-cpp": { models: [{ id: "m1" }], modelOverrides: { m1: { contextWindow: 4096 } } } } };
    setSampling(config, "llama-cpp", "m1", "all", "temperature", undefined);
    expect(config.providers["llama-cpp"].modelOverrides.m1).toEqual({ contextWindow: 4096 });
  });
  it("clearing the sampling from an override that also carries other keys keeps those keys", () => {
    const config = { providers: { "llama-cpp": { models: [{ id: "m1" }], modelOverrides: { m1: { samplingParams: { top_k: 20 }, contextWindow: 4096 } } } } };
    setSampling(config, "llama-cpp", "m1", "all", "top_k", undefined);
    expect(config.providers["llama-cpp"].modelOverrides.m1).toEqual({ contextWindow: 4096 });
  });
  it("unknown provider → false, file untouched", () => {
    const config = base();
    expect(setSampling(config, "other", "m1", "all", "temperature", 1)).toBe(false);
    expect(config.providers["other"]).toBeUndefined();
  });
  it("model entry and override may live in different models (no models array needed)", () => {
    const config = { providers: { "llama-cpp": {} } };
    setSampling(config, "llama-cpp", "ghost", "max", "temperature", 0.5);
    expect(config.providers["llama-cpp"].modelOverrides.ghost.samplingParamsByThinkingLevel.max.temperature).toBe(0.5);
  });
});

describe("effectiveOverride", () => {
  const config = {
    providers: {
      "llama-cpp": {
        models: [{
          id: "m1",
          samplingParams: { temperature: 1, top_p: 0.9 },
          samplingParamsByThinkingLevel: { off: { temperature: 0.2, top_k: 40 } },
        }],
        modelOverrides: {
          m1: {
            samplingParams: { top_p: 0.8 },
            samplingParamsByThinkingLevel: { off: { temperature: 0.4 } },
          },
        },
      },
    },
  };
  it("modelOverrides win per key, per level, on top of a hand-written model entry", () => {
    expect(effectiveOverride(config, "llama-cpp", "m1")).toEqual({
      samplingParams: { temperature: 1, top_p: 0.8 },
      samplingParamsByThinkingLevel: { off: { temperature: 0.4, top_k: 40 } },
    });
  });
  it("nothing configured anywhere -> empty object", () => {
    expect(effectiveOverride({ providers: { "llama-cpp": { models: [{ id: "m1" }] } } }, "llama-cpp", "m1")).toEqual({});
    expect(effectiveOverride({}, "llama-cpp", "m1")).toEqual({});
  });
  it("an override-only model (not in models[]) is still reported", () => {
    expect(effectiveOverride(config, "llama-cpp", "ghost")).toEqual({});
  });
});

describe("provenance labels", () => {
  const override = {
    samplingParams: { temperature: 0.7, top_p: 0.9 },
    samplingParamsByThinkingLevel: { high: { temperature: 0.2 } },
  };
  const server = { temperature: 0.8, top_k: 40, top_p: 0.95, min_p: 0.05 };

  it("keyProvenance names the layer a value comes from", () => {
    expect(keyProvenance(override, server, "high", "temperature")).toEqual({ source: "level", value: 0.2 });
    expect(keyProvenance(override, server, "high", "top_p")).toEqual({ source: "global", value: 0.9 });
    expect(keyProvenance(override, server, "high", "top_k")).toEqual({ source: "server", value: 40 });
    expect(keyProvenance(override, server, "high", "min_p")).toEqual({ source: "server", value: 0.05 });
    expect(keyProvenance(override, undefined, "low", "top_p")).toEqual({ source: "global", value: 0.9 });
    expect(keyProvenance(override, undefined, "low", "top_k")).toEqual({ source: "unset" });
    // the global layer never reports a level's own value
    expect(keyProvenance(override, server, "all", "temperature")).toEqual({ source: "global", value: 0.7 });
  });

  it("a level that inherits says so instead of repeating the number as its own", () => {
    expect(formatKeyItem("high", "temperature", keyProvenance(override, server, "high", "temperature")))
      .toBe("temperature = 0.20 (this level)");
    expect(formatKeyItem("high", "top_p", keyProvenance(override, server, "high", "top_p")))
      .toBe("top_p = 0.90 (same as global)");
    expect(formatKeyItem("high", "top_k", keyProvenance(override, server, "high", "top_k")))
      .toBe("top_k = 40 (server)");
    expect(formatKeyItem("low", "min_p", keyProvenance(override, undefined, "low", "min_p")))
      .toBe("min_p — unset");
    // inside the global list the same value is labelled global, not "same as global"
    expect(formatKeyItem("all", "temperature", keyProvenance(override, server, "all", "temperature")))
      .toBe("temperature = 0.70 (global)");
  });

  it("target items show what each target contributes, not the merged result", () => {
    expect(formatTargetItem("all", override)).toBe("all levels (global) — set: temp 0.70 · top_p 0.90");
    expect(formatTargetItem("high", override)).toBe("high — own: temp 0.20");
    expect(formatTargetItem("low", override)).toBe("low — same as global");
    expect(formatTargetItem("all", undefined)).toBe("all levels (global) — nothing set");
  });
});

describe("readOverride / sameSampling / carrySamplingFields", () => {
  it("readOverride returns both containers (missing → undefined fields)", () => {
    const config = { providers: { "llama-cpp": { modelOverrides: { m1: { samplingParams: { top_k: 20 } } } } } };
    expect(readOverride(config, "llama-cpp", "m1")).toEqual({ samplingParams: { top_k: 20 }, samplingParamsByThinkingLevel: undefined });
    expect(readOverride(config, "llama-cpp", "nope")).toBeUndefined();
    expect(readOverride({}, "llama-cpp", "m1")).toBeUndefined();
  });
  it("sameSampling treats missing as equal to missing", () => {
    expect(sameSampling({ samplingParams: { top_k: 20 } }, { samplingParams: { top_k: 20 } })).toBe(true);
    expect(sameSampling({}, {})).toBe(true);
    expect(sameSampling(undefined, { samplingParams: { top_k: 20 } })).toBe(false);
    expect(sameSampling({ samplingParams: { top_k: 20 } }, { samplingParams: { top_k: 21 } })).toBe(false);
    expect(sameSampling({ samplingParams: { top_k: 20 } }, { samplingParamsByThinkingLevel: { off: { top_k: 20 } } })).toBe(false);
  });
  it("carrySamplingFields copies user keys onto a rebuilt entry", () => {
    const entry: any = { id: "m1" };
    expect(carrySamplingFields({ id: "m1", samplingParams: { temperature: 1 }, contextWindow: 8192 }, entry)).toBe(true);
    expect(entry).toEqual({ id: "m1", samplingParams: { temperature: 1 } });
    expect(carrySamplingFields({ id: "m1" }, { id: "m1" })).toBe(false);
    expect(carrySamplingFields(undefined, { id: "m1" })).toBe(false);
  });
  it("carriesSampling", () => {
    expect(carriesSampling({ samplingParamsByThinkingLevel: { off: {} } })).toBe(true);
    expect(carriesSampling({ contextWindow: 1 })).toBe(false);
    expect(carriesSampling(undefined)).toBe(false);
  });
});

describe("formatting", () => {
  it("num: integers stay plain, decimals get 2 places", () => {
    expect(num(40)).toBe("40");
    expect(num(0.8)).toBe("0.80");
    expect(num(1)).toBe("1");
  });
  it("formatSampling: fixed key order, llama-link short labels", () => {
    expect(formatSampling({ min_p: 0.05, top_k: 40, temperature: 0.8 })).toBe("temp 0.80 · top_k 40 · min_p 0.05");
    expect(formatSampling({})).toBe("");
  });
  it("describeOverride: flat first, then levels in pi's order", () => {
    expect(describeOverride(undefined)).toBe("server defaults");
    expect(describeOverride({ samplingParamsByThinkingLevel: { high: { temperature: 1 }, off: { temperature: 0.2 } } }))
      .toBe("off: temp 0.20 · high: temp 1");
    expect(describeOverride({ samplingParams: { top_p: 0.9 }, samplingParamsByThinkingLevel: { high: { top_k: 20 } } }))
      .toBe("global: top_p 0.90 · high: top_k 20");
  });
  it("samplingStatusLine names the source of the values", () => {
    const server = { temperature: 0.8, top_k: 40 };
    expect(samplingStatusLine(undefined, server, "off"))
      .toBe("Sampling [off]: temp 0.80 · top_k 40 (server defaults)");
    expect(samplingStatusLine({ samplingParams: { top_k: 20 } }, server, "off"))
      .toBe("Sampling [off]: temp 0.80 · top_k 20");
    expect(samplingStatusLine({ samplingParamsByThinkingLevel: { high: { min_p: 0.1 } } }, server, "high"))
      .toBe("Sampling [high]: temp 0.80 · top_k 40 · min_p 0.10");
    expect(samplingStatusLine(undefined, undefined, "low"))
      .toBe("Sampling [low]: server values unknown (the model has not answered /props yet)");
  });
});
