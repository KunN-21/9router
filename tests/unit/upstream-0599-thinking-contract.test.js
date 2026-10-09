import { describe, it, expect, vi, beforeEach } from "vitest";

import { applyThinking, clampNativeThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
  pipeWithDisconnect: vi.fn(async () => {}),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

describe("Upstream 0.5.99 Thinking & Stream Contracts", () => {
  describe("GLM-5.3 exact capabilities entry (restore thinkingEffortSupported)", () => {
    it("restores thinkingEffortSupported:true on exact glm-5.3-flash entry", () => {
      const caps = getCapabilitiesForModel("zai", "glm-5.3-flash");
      expect(caps.thinkingEffortSupported).toBe(true);
      expect(caps.thinkingFormat).toBe("zai");
      expect(caps.thinkingCanDisable).toBe(false);
      expect(caps.contextWindow).toBe(1000000);
      expect(caps.maxOutput).toBe(131072);
    });

    it("preserves glm-5.3 pattern capabilities", () => {
      const caps = getCapabilitiesForModel("zai", "glm-5.3");
      expect(caps.thinkingEffortSupported).toBe(true);
      expect(caps.thinkingCanDisable).toBe(false);
    });
  });

  describe("Native GLM-5.3 effort clamp per PR #4636", () => {
    it("restricts GLM-5.3 thinking levels to low, high, max", () => {
      const levels = getThinkingLevels("anthropic-compatible-alibaba-sg", "glm-5.3");
      expect(levels).toEqual(["low", "high", "max"]);
    });

    it("does not catch glm-5.3-prime with exact-suffix pattern", () => {
      const levels = getThinkingLevels("anthropic-compatible-alibaba-sg", "glm-5.3-prime");
      expect(levels).not.toEqual(["low", "high", "max"]);
    });

    it("clamps xhigh to max for zai models on native Claude passthrough", () => {
      const body = { output_config: { effort: "xhigh" } };
      clampNativeThinking(body, "anthropic-compatible-alibaba-sg", "glm-5.3");
      expect(body.output_config.effort).toBe("max");
    });

    it("keeps supported levels unchanged in clampNativeThinking", () => {
      const body = { output_config: { effort: "high" } };
      clampNativeThinking(body, "anthropic-compatible-alibaba-sg", "glm-5.3");
      expect(body.output_config.effort).toBe("high");
    });

    it("does not clamp non-zai models", () => {
      const body = { output_config: { effort: "xhigh" } };
      clampNativeThinking(body, "anthropic", "claude-sonnet-4-5");
      expect(body.output_config.effort).toBe("xhigh");
    });

    it("restricts glm-5.3-flash thinking levels to low, high, max", () => {
      expect(getThinkingLevels("zai", "glm-5.3-flash")).toEqual(["low", "high", "max"]);
      expect(getThinkingLevels("anthropic-compatible-alibaba-sg", "glm-5.3-flash")).toEqual(["low", "high", "max"]);
    });

    it("clamps xhigh to max and medium to high for glm-5.3-flash", () => {
      const xhigh = { output_config: { effort: "xhigh" } };
      clampNativeThinking(xhigh, "zai", "glm-5.3-flash");
      expect(xhigh.output_config.effort).toBe("max");
      const medium = { output_config: { effort: "medium" } };
      clampNativeThinking(medium, "zai", "glm-5.3-flash");
      expect(medium.output_config.effort).toBe("high");
    });

    it.each(["glm-5.3(high)", "glm-5.3-flash(high)", "vendor/glm-5.3-flash(xhigh)"])(
      "resolves GLM supported levels after stripping effort suffix from %s",
      (model) => {
        expect(getThinkingLevels("zai", model)).toEqual(["low", "high", "max"]);
      },
    );

    it("clamps a passthrough copy without mutating caller output_config", () => {
      const original = { output_config: Object.freeze({ effort: "xhigh", format: { type: "text" } }) };
      const attempt = { ...original };
      clampNativeThinking(attempt, "anthropic-compatible-alibaba-sg", "glm-5.3-flash");
      expect(attempt.output_config.effort).toBe("max");
      expect(attempt.output_config.format).toEqual({ type: "text" });
      expect(attempt.output_config).not.toBe(original.output_config);
      expect(original.output_config.effort).toBe("xhigh");
    });

    it("leaves glm-5.3-prime effort untouched", () => {
      const body = { output_config: { effort: "xhigh" } };
      clampNativeThinking(body, "anthropic-compatible-alibaba-sg", "glm-5.3-prime");
      expect(body.output_config.effort).toBe("xhigh");
    });
  });

  describe("Responses reasoning wire format (#4610) with conservative provider scoping", () => {
    it("formats reasoning.effort for Codex Responses target", () => {
      const body = { reasoning_effort: "high" };
      applyThinking("openai-responses", "gpt-5.6-sol", body, "codex");
      expect(body.reasoning).toEqual({
        effort: "high",
        summary: "auto",
      });
      expect(body.reasoning_effort).toBeUndefined();
    });

    it("formats reasoning.effort for Muse Responses target", () => {
      const body = { reasoning_effort: "high" };
      applyThinking("openai-responses", "muse-spark-1.3", body, "muse");
      expect(body.reasoning).toEqual({
        effort: "high",
        summary: "auto",
      });
      expect(body.reasoning_effort).toBeUndefined();
    });

    it("formats reasoning.effort for non-Muse Responses target (openai-compatible-custom)", () => {
      const body = { reasoning_effort: "high" };
      applyThinking("openai-responses", "gpt-5.6-sol", body, "openai-compatible-custom");
      expect(body.reasoning).toEqual({
        effort: "high",
        summary: "auto",
      });
      expect(body.reasoning_effort).toBeUndefined();
    });

    it.each(["kimi", "openai-compatible-custom", "opencode-go"])(
      "sends Responses-native reasoning through real translation and DefaultExecutor for %s",
      (provider) => {
        const model = provider === "kimi" ? "kimi-k3" : "gpt-5.6-sol";
        const credentials = { apiKey: "synthetic-key", runtimeTransport: {
          format: "openai-responses", baseUrl: "https://synthetic.invalid/v1/responses",
        }, providerSpecificData: { apiType: "responses" } };
        const request = translateRequest("openai", "openai-responses", model, {
          messages: [{ role: "user", content: "hello" }],
          reasoning: { effort: "high", summary: "detailed" },
        }, true, credentials, provider);
        const wire = JSON.parse(JSON.stringify(new DefaultExecutor(provider).transformRequest(model, request, true, credentials)));
        expect(wire.reasoning).toEqual({ effort: "high", summary: "detailed" });
        expect(wire.reasoning_effort).toBeUndefined();
      },
    );

    it("preserves Chat-shaped reasoning_effort when target is openai (Chat Completions)", () => {
      const body = { reasoning_effort: "high" };
      applyThinking("openai", "gpt-5.6-sol", body, "openai");
      expect(body.reasoning_effort).toBe("high");
      expect(body.reasoning).toBeUndefined();
    });
  });

  describe("Responses reasoning summary preservation and continuity input", () => {
    it("preserves explicit reasoning.summary without overwriting with auto", () => {
      const body = {
        reasoning: { effort: "high", summary: "detailed" },
      };
      applyThinking("openai-responses", "gpt-5.6-sol", body, "codex");
      expect(body.reasoning).toEqual({
        effort: "high",
        summary: "detailed",
      });
      expect(body.reasoning.encrypted_content).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
    });

    it("does not leak arbitrary reasoning configuration fields to Responses wire", () => {
      const body = { reasoning: { effort: "high", summary: "detailed", foo: "bar", encrypted_content: "continuity-only" } };
      applyThinking("openai-responses", "gpt-5.6-sol", body, "codex");
      expect(body.reasoning).toEqual({ effort: "high", summary: "detailed" });
    });

    it("drops encrypted_content from the reasoning wire object", () => {
      const body = { reasoning: { effort: "high", summary: "detailed", encrypted_content: "blob123" } };
      applyThinking("openai-responses", "gpt-5.6-sol", body, "codex");
      expect(body.reasoning).toEqual({ effort: "high", summary: "detailed" });
    });

    it("preserves reasoning input items with encrypted_content in body.input", () => {
      const continuationItem = {
        type: "reasoning",
        encrypted_content: "enc_continuity_blob_999",
        summary: [{ type: "summary_text", text: "step 1" }],
      };
      const userMessage = { type: "message", role: "user", content: "hello" };
      const body = {
        reasoning: { effort: "medium", summary: "concise" },
        input: [continuationItem, userMessage],
      };
      applyThinking("openai-responses", "muse-spark-1.3", body, "muse");
      expect(body.reasoning).toEqual({
        effort: "medium",
        summary: "concise",
      });
      expect(body.input).toHaveLength(2);
      expect(body.input[0]).toEqual(continuationItem);
      expect(body.input[0].encrypted_content).toBe("enc_continuity_blob_999");
    });
  });

  describe("Stream defaults (#4579) and propagation without caller mutation (#4634)", () => {
    beforeEach(() => {
      executeMock.mockReset();
      executeMock.mockRejectedValue(new Error("upstream test error"));
    });

    function makeOptions(provider, bodyStream, accept = "*/*") {
      const body = {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hello" }],
      };
      if (bodyStream !== undefined) body.stream = bodyStream;

      return {
        body,
        modelInfo: { provider, model: "deepseek-chat" },
        credentials: { apiKey: "sk-test" },
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body,
          headers: { accept },
        },
        connectionId: "test-conn",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };
    }

    it("defaults omitted stream to JSON (false) for non-forced provider with neutral Accept", async () => {
      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
      const opts = makeOptions("deepseek", undefined, "*/*");
      await handleChatCore(opts);

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock.mock.calls[0][0].stream).toBe(false);
      // Caller original body must NOT be mutated
      expect(opts.body.stream).toBeUndefined();
    });

    it("propagates resolved stream into attempt body when omitted without mutating caller", async () => {
      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
      // Forced stream provider like codex
      const opts = makeOptions("codex", undefined, "*/*");
      await handleChatCore(opts);

      expect(executeMock).toHaveBeenCalledTimes(1);
      const call = executeMock.mock.calls[0][0];
      expect(call.stream).toBe(true);
      expect(call.body.stream).toBe(true);
      // Caller original body must NOT be mutated
      expect(opts.body.stream).toBeUndefined();
    });

    it("respects explicit stream:true for non-forced provider", async () => {
      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
      const opts = makeOptions("deepseek", true, "*/*");
      await handleChatCore(opts);

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock.mock.calls[0][0].stream).toBe(true);
      expect(opts.body.stream).toBe(true);
    });

    it("respects explicit stream:false for non-forced provider", async () => {
      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
      const opts = makeOptions("deepseek", false, "*/*");
      await handleChatCore(opts);

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock.mock.calls[0][0].stream).toBe(false);
      expect(opts.body.stream).toBe(false);
    });

    it.each(["gemini", "gemini-cli", "antigravity"])(
      "keeps %s streaming without adding an unsupported body.stream field",
      async (format) => {
        const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
        const body = format === "gemini" || format === "gemini-cli"
          ? { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
          : { request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] } };
        const opts = {
          body,
          modelInfo: { provider: format, model: "gemini-3.6-flash" },
          sourceFormatOverride: format,
          credentials: { accessToken: "synthetic-token" },
          clientRawRequest: { endpoint: "/v1beta/models/test:streamGenerateContent", body, headers: {} },
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        };
        await handleChatCore(opts);
        expect(executeMock).toHaveBeenCalledTimes(1);
        const call = executeMock.mock.calls[0][0];
        expect(call.stream).toBe(true);
        expect(Object.hasOwn(call.body, "stream")).toBe(false);
        expect(Object.hasOwn(opts.body, "stream")).toBe(false);
      },
    );

    it("keeps forced-stream provider (codex) streaming even when client asked JSON", async () => {
      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
      const opts = makeOptions("codex", false, "application/json");
      await handleChatCore(opts);

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock.mock.calls[0][0].stream).toBe(true);
      expect(opts.body.stream).toBe(false);
    });
  });
});
