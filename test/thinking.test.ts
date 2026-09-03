import { describe, it, expect } from "vitest";
import {
  applyEnableThinkingSupport,
  applyEffortThinkingSupport,
  thinkingBudgetFor,
  TOGGLE_THINKING_LEVEL_MAP,
} from "../thinking";

describe("applyEnableThinkingSupport", () => {
  it("sets reasoning, toggle level map, and enable_thinking kwargs", () => {
    const model: Record<string, any> = {};
    applyEnableThinkingSupport(model);
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap).toBe(TOGGLE_THINKING_LEVEL_MAP);
    expect(model.compat.thinkingFormat).toBe("chat-template");
    expect(model.compat.chatTemplateKwargs).toEqual({
      "enable_thinking": { "$var": "thinking.enabled" },
      "preserve_thinking": true,
    });
  });

  it("preserves existing compat fields", () => {
    const model: Record<string, any> = { compat: { existing: 1 } };
    applyEnableThinkingSupport(model);
    expect(model.compat.existing).toBe(1);
  });
});

describe("applyEffortThinkingSupport", () => {
  it("emits only the var names the template references", () => {
    const model: Record<string, any> = {};
    applyEffortThinkingSupport(model, {
      levels: ["xhigh", "medium", "low"],
      off: false,
      varNames: ["reasoning_effort"],
    });
    expect(model.compat.chatTemplateKwargs).toEqual({
      reasoning_effort: { "$var": "thinking.effort" },
    });
  });

  it("falls back to both var names when detection was caps-only", () => {
    const model: Record<string, any> = {};
    applyEffortThinkingSupport(model, { levels: ["low"], off: false });
    expect(model.compat.chatTemplateKwargs).toEqual({
      reasoning_effort: { "$var": "thinking.effort" },
      reasoning_strength: { "$var": "thinking.effort" },
    });
  });

  it("adds enable_thinking only when the template gates on it (off path)", () => {
    const model: Record<string, any> = {};
    applyEffortThinkingSupport(model, { levels: ["low"], off: true, varNames: ["reasoning_effort"] });
    expect(model.compat.chatTemplateKwargs["enable_thinking"]).toEqual({
      "$var": "thinking.enabled",
    });
    expect(model.thinkingLevelMap.off).toBe("none");
  });
});

describe("thinkingBudgetFor", () => {
  const level = (model: Record<string, any>) => (lvl: string) => thinkingBudgetFor(model, lvl);

  it("never injects for non-reasoning models", () => {
    expect(level({ reasoning: false })("low")).toBeUndefined();
    expect(level({})("low")).toBeUndefined();
  });

  it("never injects for effort-style models (they consume effort strings)", () => {
    const model = {
      reasoning: true,
      compat: { chatTemplateKwargs: { reasoning_effort: { "$var": "thinking.effort" } } },
    };
    expect(level(model)("low")).toBeUndefined();
  });

  it("maps low→512 and high→8192", () => {
    const toggle: Record<string, any> = {};
    applyEnableThinkingSupport(toggle);
    expect(level(toggle)("low")).toBe(512);
    expect(level(toggle)("high")).toBe(8192);
  });

  it("leaves off/max/medium at the server default", () => {
    const toggle: Record<string, any> = {};
    applyEnableThinkingSupport(toggle);
    expect(level(toggle)("off")).toBeUndefined();
    expect(level(toggle)("max")).toBeUndefined();
    expect(level(toggle)("medium")).toBeUndefined();
  });
});
