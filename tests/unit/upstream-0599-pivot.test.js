import { describe, it, expect } from "vitest";

import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { adjustMaxTokens } from "../../open-sse/translator/formats/maxTokens.js";
import {
  OPENAI_SERVICE_TIERS,
  CLAUDE_TO_OPENAI_SERVICE_TIER,
} from "../../open-sse/translator/schema/index.js";
import {
  OPENAI_SERVICE_TIERS as DEFAULTS_TIERS,
  CLAUDE_TO_OPENAI_SERVICE_TIER as DEFAULTS_MAP,
} from "../../open-sse/translator/schema/defaults.js";
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../open-sse/config/runtimeConfig.js";

const messages = [{ role: "user", content: "hello" }];
const openaiTools = [{ type: "function", function: { name: "probe", parameters: { type: "object", properties: {} } } }];
const claudeTools = [{ name: "probe", input_schema: { type: "object", properties: {} } }];

describe("Generic Claude/OpenAI pivot selective upstream fixes", () => {
  describe("Tool strict preservation (PR 4607)", () => {
    it.each([true, false, undefined])("preserves OpenAI strict:%s on Claude tools", (strict) => {
      const fn = { name: "probe", parameters: { type: "object", properties: {} } };
      if (strict !== undefined) fn.strict = strict;
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: [{ type: "function", function: fn }] }, false);
      expect(res.tools[0].strict).toBe(strict);
      if (strict === undefined) expect(res.tools[0]).not.toHaveProperty("strict");
    });

    it.each([true, false, undefined])("preserves Claude strict:%s on OpenAI tools", (strict) => {
      const tool = { name: "probe", input_schema: { type: "object", properties: {} } };
      if (strict !== undefined) tool.strict = strict;
      const res = claudeToOpenAIRequest("gpt-5.5", { messages, tools: [tool] }, false);
      expect(res.tools[0].function.strict).toBe(strict);
      if (strict === undefined) expect(res.tools[0].function).not.toHaveProperty("strict");
    });
  });

  describe("Tool choice none preservation (PR 4577)", () => {
    it("translates OpenAI tool_choice: 'none' to Claude { type: 'none' }", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, tool_choice: "none" }, false);
      expect(res.tool_choice).toEqual({ type: "none" });
    });

    it("translates Claude tool_choice: { type: 'none' } to OpenAI 'none'", () => {
      const res = claudeToOpenAIRequest("gpt-5.5", { messages, tools: claudeTools, tool_choice: { type: "none" } }, false);
      expect(res.tool_choice).toBe("none");
    });
  });

  describe("Single-tool policy translation (PR 4581) & tool_choice: none repair", () => {
    it("maps OpenAI parallel_tool_calls:false to Claude disable_parallel_tool_use:true for default auto", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, parallel_tool_calls: false }, false);
      expect(res.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    });

    it("maps Claude disable_parallel_tool_use:true to OpenAI parallel_tool_calls:false", () => {
      const res = claudeToOpenAIRequest("gpt-5.5", { messages, tools: claudeTools, tool_choice: { type: "any", disable_parallel_tool_use: true } }, false);
      expect(res.tool_choice).toBe("required");
      expect(res.parallel_tool_calls).toBe(false);
    });

    it("never adds disable_parallel_tool_use to tool_choice: 'none' when parallel_tool_calls is false", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", {
        messages,
        tools: openaiTools,
        tool_choice: "none",
        parallel_tool_calls: false,
      }, false);
      expect(res.tool_choice).toEqual({ type: "none" });
      expect(res.tool_choice).not.toHaveProperty("disable_parallel_tool_use");
    });

    it("never adds disable_parallel_tool_use to tool_choice object with type 'none' when parallel_tool_calls is false", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", {
        messages,
        tools: openaiTools,
        tool_choice: { type: "none" },
        parallel_tool_calls: false,
      }, false);
      expect(res.tool_choice).toEqual({ type: "none" });
      expect(res.tool_choice).not.toHaveProperty("disable_parallel_tool_use");
    });

    it("keeps disable_parallel_tool_use for valid auto/any/tool cases", () => {
      const autoRes = openaiToClaudeRequest("claude-sonnet-4-6", {
        messages,
        tools: openaiTools,
        tool_choice: "auto",
        parallel_tool_calls: false,
      }, false);
      expect(autoRes.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });

      const anyRes = openaiToClaudeRequest("claude-sonnet-4-6", {
        messages,
        tools: openaiTools,
        tool_choice: "required",
        parallel_tool_calls: false,
      }, false);
      expect(anyRes.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });

      const toolRes = openaiToClaudeRequest("claude-sonnet-4-6", {
        messages,
        tools: openaiTools,
        tool_choice: { type: "function", function: { name: "probe" } },
        parallel_tool_calls: false,
      }, false);
      expect(toolRes.tool_choice).toEqual({ type: "tool", name: "probe", disable_parallel_tool_use: true });
    });
  });

  describe("Claude -> OpenAI service_tier (PR 4642)", () => {
    it("exports OPENAI_SERVICE_TIERS and CLAUDE_TO_OPENAI_SERVICE_TIER correctly", () => {
      expect(OPENAI_SERVICE_TIERS).toEqual(["auto", "default", "flex", "priority", "scale"]);
      expect(CLAUDE_TO_OPENAI_SERVICE_TIER).toEqual({ standard_only: "default" });
      expect(DEFAULTS_TIERS).toEqual(OPENAI_SERVICE_TIERS);
      expect(DEFAULTS_MAP).toEqual(CLAUDE_TO_OPENAI_SERVICE_TIER);
    });

    it.each(["auto", "default", "flex", "priority", "scale"])("forwards valid OpenAI tier %s", (tier) => {
      const res = claudeToOpenAIRequest("gpt-5.5", { messages, service_tier: tier }, false);
      expect(res.service_tier).toBe(tier);
    });

    it("maps standard_only to default", () => {
      const res = claudeToOpenAIRequest("gpt-5.5", { messages, service_tier: "standard_only" }, false);
      expect(res.service_tier).toBe("default");
    });

    it.each(["bogus", "premium", "fast", "", 123, null, undefined])("drops unverified tier %j", (tier) => {
      const body = { messages };
      if (tier !== undefined) body.service_tier = tier;
      const res = claudeToOpenAIRequest("gpt-5.5", body, false);
      expect(res.service_tier).toBeUndefined();
    });
  });

  describe("Explicit max_tokens cap honor & validation (PR 4533 + hardening)", () => {
    it("honors explicit max_completion_tokens: 1 even with tools present in openaiToClaudeRequest", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, max_completion_tokens: 1 }, false);
      expect(res.max_tokens).toBe(1);
    });

    it("honors explicit max_tokens: 1 even with tools present in openaiToClaudeRequest", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, max_tokens: 1 }, false);
      expect(res.max_tokens).toBe(1);
    });

    it("prioritizes max_completion_tokens over max_tokens", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, max_completion_tokens: 5, max_tokens: 10 }, false);
      expect(res.max_tokens).toBe(5);
    });

    it("falls back to valid max_tokens when max_completion_tokens is invalid", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, max_completion_tokens: "invalid", max_tokens: 10 }, false);
      expect(res.max_tokens).toBe(10);
    });

    it("keeps tool floor when no explicit cap is small in claudeToOpenAIRequest", () => {
      const res = claudeToOpenAIRequest("gpt-4o", { messages, tools: claudeTools, max_tokens: 4096 }, false);
      expect(res.max_tokens).toBe(DEFAULT_MIN_TOKENS);
    });

    it.each([0, -1, -10, NaN, 12.5, 0.5, "100", "-5", "abc", null, false])(
      "rejects invalid cap %j and falls back to safe ceiling in openaiToClaudeRequest",
      (invalidCap) => {
        const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, max_tokens: invalidCap }, false);
        expect(res.max_tokens).toBeGreaterThan(0);
        expect(Number.isInteger(res.max_tokens)).toBe(true);
        expect(res.max_tokens).toBe(DEFAULT_MAX_TOKENS);
      }
    );

    it.each([0, -1, -10, NaN, 12.5, 0.5, "100", "-5", "abc"])(
      "rejects invalid max_completion_tokens %j and falls back to safe ceiling in openaiToClaudeRequest",
      (invalidCap) => {
        const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, max_completion_tokens: invalidCap }, false);
        expect(res.max_tokens).toBeGreaterThan(0);
        expect(Number.isInteger(res.max_tokens)).toBe(true);
        expect(res.max_tokens).toBe(DEFAULT_MAX_TOKENS);
      }
    );

    it("does not honor invalid cap when tools are present in openaiToClaudeRequest", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, max_tokens: -5 }, false);
      expect(res.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    });

    it("preserves thinking budget constraints over explicit cap in adjustMaxTokens", () => {
      const res = adjustMaxTokens({ thinking: { budget_tokens: 2048 }, max_tokens: 1 }, DEFAULT_MAX_TOKENS, true);
      expect(res).toBe(2048 + 1024);
    });

    it("clamps to ceiling even with explicit cap in adjustMaxTokens", () => {
      const res = adjustMaxTokens({ max_tokens: 100000 }, 4096, true);
      expect(res).toBe(4096);
    });

    it("handles invalid caps in claudeToOpenAIRequest without leaking invalid values", () => {
      const resNeg = claudeToOpenAIRequest("gpt-4o", { messages, max_tokens: -10 }, false);
      expect(resNeg.max_tokens).toBe(DEFAULT_MAX_TOKENS);

      const resZero = claudeToOpenAIRequest("gpt-4o", { messages, max_tokens: 0 }, false);
      expect(resZero.max_tokens).toBe(DEFAULT_MAX_TOKENS);

      const resStr = claudeToOpenAIRequest("gpt-4o", { messages, max_tokens: "100" }, false);
      expect(resStr.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    });
  });
});