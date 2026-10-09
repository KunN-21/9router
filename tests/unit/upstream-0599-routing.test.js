import { describe, it, expect } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("GLM and Muse routing/capabilities selective upstream fixes", () => {
  describe("Muse nested reasoning for Responses target (b00ba1aa)", () => {
    it("nests reasoning_effort into reasoning object for muse openai-responses", () => {
      const body = { reasoning_effort: "high" };
      applyThinking("openai-responses", "muse-spark-1.3", body, "muse");
      expect(body.reasoning).toEqual({
        effort: "high",
        summary: "auto"
      });
      expect(body.reasoning_effort).toBeUndefined();
    });

    it("deletes reasoning when mode is none and can disable", () => {
      const body = { reasoning_effort: "none", reasoning: { effort: "high" } };
      applyThinking("openai-responses", "muse-spark-1.3", body, "muse");
      expect(body.reasoning).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
    });
  });

  describe("GLM-5.3 thinking cannot disable and 1M context (c61ee37, 0f7f6e72)", () => {
    it("marks thinkingCanDisable as false for glm-5.3 and glm-5.3-flash", () => {
      const flashCaps = getCapabilitiesForModel("zai", "glm-5.3-flash");
      const baseCaps = getCapabilitiesForModel("zai", "glm-5.3");
      expect(flashCaps.thinkingCanDisable).toBe(false);
      expect(baseCaps.thinkingCanDisable).toBe(false);
    });

    it("returns 1M contextWindow for glm-5.2 and glm-5.3", () => {
      const v52Caps = getCapabilitiesForModel("zai", "glm-5.2");
      const v53Caps = getCapabilitiesForModel("zai", "glm-5.3");
      expect(v52Caps.contextWindow).toBe(1000000);
      expect(v53Caps.contextWindow).toBe(1000000);
    });

    it("leaves thinking enabled rather than setting enable_thinking:false for glm-5.3", () => {
      for (const id of ["glm-5.3", "glm-5.3-flash"]) {
        const body = { reasoning_effort: "none" };
        applyThinking("claude", id, body, "glm");
        expect(body.enable_thinking).toBeUndefined();
        expect(body.thinking?.type).not.toBe("disabled");
      }
    });
  });
});
