import { describe, it } from "vitest";
import assert from "node:assert";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../../open-sse/translator/request/claude-to-responses.js";

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

describe("claude-to-responses direct", () => {
  for (const m of ["muse-spark-1.3-contributor-free", "gpt-astra-6"]) {
    it(`preserves fields for ${m}`, () => {
      const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, m, hardBody(), true, null, null, null, [], null, null);
      const calls = out.input.filter(i => i.type === "function_call");
      assert.equal(calls.length, 1);
      assert.match(calls[0].call_id, /toolu_abc123|call_/);
      assert.ok(out.tools.some(t => t.name === "get_weather"));
      assert.equal(out.max_output_tokens, 1024);
      assert.equal(out.store, false);
    });
  }

  it("does not hijack claude->KIRO", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "muse-spark-1.3-contributor-free", hardBody(), true, null, null, null, [], null, null);
    assert.ok(!out.input, "family handler must not run for KIRO target");
  });

  it("sanitizes MCP-style names to Codex pattern and restores them", () => {
    const body = hardBody();
    body.tools.push({ name: "mcp__plugin__my.tool:name", description: "m", input_schema: { type: "object", properties: {} } });
    body.messages[1].content.push({ type: "tool_use", id: "toolu_mcp1", name: "mcp__plugin__my.tool:name", input: {} });
    body.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mcp1", content: "done" }] });
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "gpt-astra-6", body, true, null, null, null, [], null, null);
    const pat = /^[a-zA-Z0-9_-]+$/;
    for (const t of out.tools) assert.match(t.name, pat, `tool decl ${t.name}`);
    for (const i of out.input.filter((x) => x.name)) assert.match(i.name, pat, `input ${i.type} ${i.name}`);
    assert.ok(out._toolNameMap?.get("mcp__plugin__my_tool_name") === "mcp__plugin__my.tool:name", "restore map present");
  });

  it("dedupes colliding sanitized names", () => {
    const body = hardBody();
    body.tools = [
      { name: "a.b", description: "x", input_schema: { type: "object", properties: {} } },
      { name: "a:b", description: "y", input_schema: { type: "object", properties: {} } },
    ];
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "gpt-astra-6", body, true, null, null, null, [], null, null);
    const names = out.tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "no collision");
  });
});
