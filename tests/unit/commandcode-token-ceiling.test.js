import { describe, expect, it } from "vitest";
import { openaiToCommandCodeRequest } from "../../open-sse/translator/request/openai-to-commandcode.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { DEFAULT_MAX_TOKENS } from "../../open-sse/config/runtimeConfig.js";

const MODEL = "moonshotai/Kimi-K2.6";
const msgs = { messages: [{ role: "user", content: "hi" }] };

describe("CommandCode token ceiling boundary", () => {
  it("caps commandcode/cmc capability at 200k schema guard", () => {
    expect(getCapabilitiesForModel("commandcode", MODEL).maxOutput).toBe(200000);
    expect(getCapabilitiesForModel("cmc", MODEL).maxOutput).toBe(200000);
  });
  it("clamps explicit cap above ceiling and preserves valid cap below", () => {
    expect(openaiToCommandCodeRequest(MODEL, { ...msgs, max_tokens: 384000 }, true).params.max_tokens).toBe(200000);
    expect(openaiToCommandCodeRequest(MODEL, { ...msgs, max_tokens: 8192 }, true).params.max_tokens).toBe(8192);
  });
  it("falls back to DEFAULT_MAX_TOKENS when omitted and returns null on invalid explicit cap", () => {
    expect(openaiToCommandCodeRequest(MODEL, msgs, true).params.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    // Translator catches COMMANDCODE_MAX_TOKENS_INVALID then returns null; chatCore.js
    // maps !translatedBody to 400 BAD_REQUEST before touching network. Never throws out.
    expect(openaiToCommandCodeRequest(MODEL, { ...msgs, max_tokens: "384000" }, true)).toBeNull();
    expect(openaiToCommandCodeRequest(MODEL, { ...msgs, max_tokens: -50 }, true)).toBeNull();
  });
  it("throws TypeError from the clamp helper itself (never swallowed)", async () => {
    // Dynamic import: helper missing => only this case fails, translator cases stay independent.
    // typeof guard first: API absence surfaces as AssertionError, not TypeError/import error.
    const mod = await import("../../open-sse/translator/formats/maxTokens.js");
    expect(typeof mod.clampCommandCodeMaxTokens).toBe("function");
    const { clampCommandCodeMaxTokens } = mod;
    expect(() => clampCommandCodeMaxTokens("200000")).toThrow(TypeError);
    expect(() => clampCommandCodeMaxTokens(-50)).toThrow(TypeError);
    expect(clampCommandCodeMaxTokens(undefined)).toBe(DEFAULT_MAX_TOKENS);
    expect(clampCommandCodeMaxTokens(null)).toBe(DEFAULT_MAX_TOKENS);
    expect(clampCommandCodeMaxTokens(384000)).toBe(200000);
    expect(clampCommandCodeMaxTokens(8192)).toBe(8192);
  });
  it("clamps numeric native params in executor, rejects invalid ones", async () => {
    const { CommandCodeExecutor } = await import("../../open-sse/executors/commandcode.js");
    const ex = new CommandCodeExecutor();
    expect(ex.transformRequest(MODEL, { params: { max_tokens: 500000 } }, true).params.max_tokens).toBe(200000);
    expect(() => ex.transformRequest(MODEL, { params: { max_tokens: "500000" } }, true)).toThrow(TypeError);
    expect(() => ex.transformRequest(MODEL, { params: { max_tokens: -1 } }, true)).toThrow(TypeError);
  });
});
