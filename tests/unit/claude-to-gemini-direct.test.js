import { describe, it } from "vitest";
import assert from "node:assert";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../../open-sse/translator/request/claude-to-gemini.js";

const hardBody = () => ({
  system: "sys",
  max_tokens: 1024,
  tool_choice: { type: "tool", name: "get_weather" },
  tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { location: { type: "string" } } } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig123" }, { type: "tool_use", id: "toolu_abc123", name: "get_weather", input: { location: "Boston" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_abc123", content: "sunny 30C" }, { type: "tool_result", tool_use_id: "toolu_abc123", content: "oops fail", is_error: true }] },
  ],
});

describe("claude-to-gemini direct", () => {
  it("preserves spike-measured lossy fields", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.GEMINI, "gemini-3.8-flash", hardBody(), true, null, null, null, [], null, null);
    const parts = out.contents.flatMap(c => c.parts);
    assert.ok(parts.some(p => p.functionCall?.id === "toolu_abc123"));
    assert.ok(out.toolConfig, "tool_choice preserved");
    assert.equal(parts.filter(p => p.functionResponse).length, 2, "no merge of duplicate ids");
    assert.match(out.systemInstruction.parts[0].text, /sys/);
    assert.equal(out.generationConfig.maxOutputTokens, 1024);
  });

  it("does not hijack claude->KIRO", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "gemini-3.8-flash", hardBody(), true, null, null, null, [], null, null);
    assert.ok(!out.contents, "family handler must not run for KIRO target");
  });
});
