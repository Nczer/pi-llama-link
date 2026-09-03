import { describe, it, expect } from "vitest";
import {
  classifyThinkingStyle,
  parseEffortTemplate,
  buildEffortLevelMap,
  GENERIC_EFFORT_LEVELS,
} from "../thinking-style";

describe("classifyThinkingStyle", () => {
  it("detects effort from the supports_reasoning_effort cap alone", () => {
    const s = classifyThinkingStyle({
      chat_template: "",
      chat_template_caps: { supports_reasoning_effort: true },
    });
    expect(s.style).toBe("effort");
    expect(s.effort?.varNames).toBeUndefined(); // caps-only → unknown → send both
  });

  it("detects effort from template text and records referenced var names", () => {
    const ct = "{% if reasoning_effort is defined %}{{ reasoning_effort }}{% endif %}";
    const s = classifyThinkingStyle({ chat_template: ct, chat_template_caps: null });
    expect(s.style).toBe("effort");
    expect(s.effort?.varNames).toEqual(["reasoning_effort"]);
  });

  it("records both var names when the template reads both", () => {
    const ct = "x = reasoning_strength if reasoning_effort is absent else reasoning_effort";
    const s = classifyThinkingStyle({ chat_template: ct });
    expect(s.effort?.varNames).toEqual(["reasoning_effort", "reasoning_strength"]);
  });

  it("classifies real DeepSeek V3.1 shape (thinking + enable_thinking) as toggle", () => {
    const ct = [
      "{%- if not thinking is defined -%}",
      "  {%- if enable_thinking is defined -%}",
      "    {%- set thinking = enable_thinking -%}",
      "  {%- endif -%}",
      "{%- endif -%}",
      "{%- if thinking -%}on{%- endif -%}",
    ].join("\n");
    expect(classifyThinkingStyle({ chat_template: ct }).style).toBe("toggle");
  });

  it("bare `{% if thinking %}` references classify as none (no chat-template style)", () => {
    expect(classifyThinkingStyle({ chat_template: "{% if thinking %}" }).style).toBe("none");
  });

  it("classifies an enable_thinking-only template as toggle", () => {
    expect(classifyThinkingStyle({ chat_template: "{% if enable_thinking %}" }).style).toBe(
      "toggle",
    );
  });

  it("returns none for a plain template", () => {
    expect(classifyThinkingStyle({ chat_template: "{{ messages }}" }).style).toBe("none");
    expect(classifyThinkingStyle({}).style).toBe("none");
  });

  it("effort wins over toggle (Qwen-style templates have both)", () => {
    const ct = "{% if enable_thinking %}{% if reasoning_effort %}{{ reasoning_effort }}{% endif %}{% endif %}";
    expect(classifyThinkingStyle({ chat_template: ct }).style).toBe("effort");
  });
});

describe("parseEffortTemplate", () => {
  it("parses the membership tuple as the level list", () => {
    const ct = "{% if x not in ('xhigh', 'medium', 'low') %}raise{% endif %}";
    expect(parseEffortTemplate(ct).levels).toEqual(["xhigh", "medium", "low"]);
  });

  it("ignores tuples of non-effort values (modality lists etc.)", () => {
    const ct = "{% if mod not in ('text', 'image') %}{% endif %}";
    expect(parseEffortTemplate(ct).levels).toBeUndefined();
  });

  it("parses the raise message as a fallback level list", () => {
    const ct = "raise_exception('Invalid value. Supported types are xhigh (default), medium, and low.')";
    expect(parseEffortTemplate(ct).levels).toEqual(["xhigh", "medium", "low"]);
  });

  it("parses effort aliases (== 'high' … set … = 'xhigh')", () => {
    const ct = "if effort == 'high': set effort = 'xhigh'";
    expect(parseEffortTemplate(ct).aliases).toEqual({ high: "xhigh" });
  });

  it("rejects alias pairs outside the effort vocabulary", () => {
    const ct = "if x == 'tool' set x = 'image'";
    expect(parseEffortTemplate(ct).aliases).toBeUndefined();
  });

  it("sets off when the template gates on enable_thinking", () => {
    expect(parseEffortTemplate("{% if enable_thinking %}").off).toBe(true);
    expect(parseEffortTemplate("{% if x %}").off).toBe(false);
  });

  it("free-form templates get no levels (generic set applies)", () => {
    const ct = "{% if reasoning_effort is defined %}use it{% endif %}";
    const e = parseEffortTemplate(ct);
    expect(e.levels).toBeUndefined();
    expect(GENERIC_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh"]);
  });
});

describe("buildEffortLevelMap", () => {
  const base = () => ({ off: false, varNames: ["reasoning_effort"] });

  it("maps every exact level to itself, hides the rest", () => {
    const map = buildEffortLevelMap({ levels: ["xhigh", "medium", "low"], ...base() });
    expect(map).toEqual({
      off: null, minimal: null, low: "low", medium: "medium",
      high: null, xhigh: "xhigh", max: null,
    });
  });

  it("falls back to the generic set when levels are unknown", () => {
    const map = buildEffortLevelMap(base());
    expect(map).toEqual({
      off: null, minimal: null, low: "low", medium: "medium",
      high: "high", xhigh: "xhigh", max: null,
    });
  });

  it("exposes off→none only when the template gates on enable_thinking", () => {
    expect(buildEffortLevelMap({ levels: ["low"], off: true }).off).toBe("none");
    expect(buildEffortLevelMap({ levels: ["low"], off: false }).off).toBe(null);
  });

  // Documents current behaviour: an alias whose target is itself an exposed
  // level is a no-op (pass 2's guard `!claimed.has(to)` is always false when
  // set.includes(to), since pass 1 claims the whole set). Qwen3.8 therefore
  // keeps `high` hidden instead of exposing it as an alias of xhigh.
  it("alias to an already-exposed tier is a no-op (Qwen3.8 shape)", () => {
    const map = buildEffortLevelMap({
      levels: ["xhigh", "medium", "low"],
      aliases: { high: "xhigh" },
      ...base(),
    });
    expect(map.high).toBeNull();
    expect(map.xhigh).toBe("xhigh");
  });
});
