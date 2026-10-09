import { describe, it, expect } from "vitest";

import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { DEFAULT_MIN_TOKENS } from "../../open-sse/config/runtimeConfig.js";

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

  describe("Single-tool policy translation (PR 4581)", () => {
    it("maps OpenAI parallel_tool_calls:false to Claude disable_parallel_tool_use:true", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, parallel_tool_calls: false }, false);
      expect(res.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    });

    it("maps Claude disable_parallel_tool_use:true to OpenAI parallel_tool_calls:false", () => {
      const res = claudeToOpenAIRequest("gpt-5.5", { messages, tools: claudeTools, tool_choice: { type: "any", disable_parallel_tool_use: true } }, false);
      expect(res.tool_choice).toBe("required");
      expect(res.parallel_tool_calls).toBe(false);
    });
  });

  describe("Explicit max_tokens cap honor (PR 4533)", () => {
    it("honors explicit max_completion_tokens: 1 even with tools present in openaiToClaudeRequest", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, max_completion_tokens: 1 }, false);
      expect(res.max_tokens).toBe(1);
    });

    it("honors explicit max_tokens: 1 even with tools present in openaiToClaudeRequest", () => {
      const res = openaiToClaudeRequest("claude-sonnet-4-6", { messages, tools: openaiTools, max_tokens: 1 }, false);
      expect(res.max_tokens).toBe(1);
    });

    it("keeps tool floor when no explicit cap is small in claudeToOpenAIRequest", () => {
      const res = claudeToOpenAIRequest("gpt-4o", { messages, tools: claudeTools, max_tokens: 4096 }, false);
      expect(res.max_tokens).toBe(DEFAULT_MIN_TOKENS);
    });
  });
});
