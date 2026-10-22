import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { opencodeFamilyFormats } from "../../open-sse/providers/models/helpers.js";

const CHAT = ["openai"];
const WIDE = ["openai", "claude", "openai-responses"];

describe("OpenCode PR15 transport contracts", () => {
  it("declares Responses reasoning shape on OpenCode Go transport", () => {
    expect(PROVIDERS["opencode-go"].transports.find(t => t.format === "openai-responses").thinkingFormat).toBe("openai-responses");
  });

  it("keeps nested reasoning and summary on Responses", () => {
    const body = { reasoning: { effort: "high", summary: "concise" } };
    applyThinking("openai-responses", "deepseek-v4.1-flash", body, "opencode-go");
    expect(body.reasoning).toEqual({ effort: "high", summary: "concise" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("keeps model-native reasoning on Chat Completions", () => {
    const body = { reasoning_effort: "high" };
    applyThinking("openai", "deepseek-v4.1-flash", body, "opencode-go");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
  });

  it("keeps local Responses normalization without a transport declaration", () => {
    const body = { reasoning_effort: "high" };
    applyThinking("openai-responses", "muse-spark-1.3-contributor-free", body, "opencode");
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("routes Zen V4.1 Flash and free variants through Chat Completions", () => {
    for (const model of ["deepseek-v4.1-flash", "deepseek-v4.1-flash-free", "deepseek-v4.1-flash-free(high)"]) {
      expect(opencodeFamilyFormats(model)?.supportedFormats).toEqual(CHAT);
    }
    expect(getModelSupportedFormats("oc", "deepseek-v4.1-flash-free")).toEqual(CHAT);
    expect(getModelSupportedFormats("ocz", "deepseek-v4.1-flash-free")).toEqual(CHAT);
    expect(getModelSupportedFormats("ocz", "deepseek-v4.1-flash")).toEqual(CHAT);
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4.1-flash")).toEqual(WIDE);
    expect(opencodeFamilyFormats("deepseek-v4-flash").supportedFormats).toEqual(WIDE);
  });
});
