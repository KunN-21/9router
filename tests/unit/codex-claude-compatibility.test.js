import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/executors/antigravity.js", () => ({ AntigravityExecutor: class {} }));
vi.mock("../../open-sse/services/thoughtSignatureStore.js", () => ({
  storeGeminiThoughtSignature: vi.fn(),
  getGeminiThoughtSignature: vi.fn(async () => null),
  getGeminiThoughtSignatureSync: vi.fn(() => null),
  signatureFamily: vi.fn(() => null),
}));

const { responsesToClaudeResponse } = await import("../../open-sse/translator/response/responses-to-claude.js");
const { claudeToResponsesRequest } = await import("../../open-sse/translator/request/claude-to-responses.js");
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { translateRequest } = await import("../../open-sse/translator/index.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const fixtureCredentials = { connectionId: "compatibility-fixture" };
const { responsesToClaudeMessage } = await import("../../open-sse/handlers/chatCore/nonStreamingFormatters.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { canonicalizeUsage } = await import("../../open-sse/utils/usageTracking.js");
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const usageDb = await import("@/lib/usageDb.js");

const run = (events) => {
  const state = {};
  return events.flatMap((event) => responsesToClaudeResponse(event, state) || []);
};

describe("claude-to-responses request mapping (F6/F7/F8)", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "Zml4" } };

  it("keeps mixed text and images inside one ordered message", () => {
    const body = claudeToResponsesRequest("gpt-6.1-sol", {
      messages: [{ role: "user", content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] }],
    }, true, fixtureCredentials);
    expect(body.input).toEqual([{ type: "message", role: "user", content: [
      { type: "input_text", text: "before" },
      { type: "input_image", image_url: "data:image/png;base64,Zml4", detail: "auto" },
      { type: "input_text", text: "after" },
    ] }]);
  });

  it("wraps image-only input inside a user message", () => {
    const body = claudeToResponsesRequest("gpt-6.1-sol", { messages: [{ role: "user", content: [image] }] }, true, fixtureCredentials);
    expect(body.input).toEqual([{ type: "message", role: "user", content: [
      { type: "input_image", image_url: "data:image/png;base64,Zml4", detail: "auto" },
    ] }]);
    const final = new CodexExecutor().transformRequest("gpt-6.1-sol", body, true, fixtureCredentials);
    expect(final.input.some((item) => item.type === "input_image")).toBe(false);
    expect(final.input.find((item) => item.role === "user").content[0].type).toBe("input_image");
  });

  it("keeps image messages on their side of a tool result", () => {
    const body = claudeToResponsesRequest("gpt-6.1-sol", {
      messages: [{ role: "user", content: [
        { type: "text", text: "before" }, image,
        { type: "tool_result", tool_use_id: "call_fixture", content: "ok" },
        image, { type: "text", text: "after" },
      ] }],
    }, true, fixtureCredentials);
    expect(body.input.map((item) => item.type)).toEqual(["message", "function_call_output", "message"]);
    expect(body.input[0].content.map((part) => part.type)).toEqual(["input_text", "input_image"]);
    expect(body.input[2].content.map((part) => part.type)).toEqual(["input_image", "input_text"]);
  });

  it.each([
    [{ type: "none" }, "none"],
    [{ type: "auto" }, "auto"],
    [{ type: "any" }, "required"],
    [{ type: "tool", name: "Read" }, { type: "function", name: "Read" }],
  ])("preserves tool_choice %j through the direct route and Codex Lite", (tool_choice, expected) => {
    const translated = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "gpt-6.1-sol", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
      tool_choice,
    }, true, fixtureCredentials, "codex");
    expect(translated.tool_choice).toEqual(expected);
    const final = new CodexExecutor().transformRequest("gpt-6.1-sol", translated, true, fixtureCredentials);
    expect(final.tool_choice).toEqual(expected);
  });

  it("does not send the unsupported output limit to Codex", () => {
    const translated = claudeToResponsesRequest("gpt-6.1-sol", {
      max_tokens: 1234, messages: [{ role: "user", content: "hi" }],
    }, true, fixtureCredentials);
    expect(translated.max_output_tokens).toBe(1234);
    const final = new CodexExecutor().transformRequest("gpt-6.1-sol", translated, true, fixtureCredentials);
    expect(final).not.toHaveProperty("max_output_tokens");
  });
});

const usageCases = [
  { name: "cache read", raw: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 } }, wire: { input_tokens: 20, output_tokens: 20, cache_read_input_tokens: 80 }, prompt: 100 },
  { name: "cache read and write", raw: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 } }, wire: { input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 60 }, prompt: 100 },
  { name: "cache write only", raw: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 60 } }, wire: { input_tokens: 40, output_tokens: 20, cache_creation_input_tokens: 60 }, prompt: 100 },
  { name: "flat inclusive cache", raw: { input_tokens: 100, output_tokens: 20, cached_tokens: 80 }, wire: { input_tokens: 20, output_tokens: 20, cache_read_input_tokens: 80 }, prompt: 100 },
  { name: "legacy exclusive cache", raw: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 }, wire: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 }, prompt: 190 },
  { name: "no cache", raw: { input_tokens: 100, output_tokens: 20 }, wire: { input_tokens: 100, output_tokens: 20 }, prompt: 100 },
  { name: "zero usage", raw: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, wire: { input_tokens: 0, output_tokens: 0 }, prompt: 0 },
];

const sseFrame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const usageResponse = (usage) => ({
  id: "resp_usage_fixture", object: "response", status: "completed", model: "gpt-6.1-sol",
  output: [{ type: "message", id: "msg_usage_fixture", role: "assistant", content: [{ type: "output_text", text: "final text" }] }],
  usage,
});

describe("Responses usage conversion (F9)", () => {
  it.each(usageCases)("maps $name to exclusive Claude stream usage", ({ raw, wire, prompt }) => {
    const out = run([{ type: "response.completed", response: usageResponse(raw) }]);
    const usage = out.find((event) => event.type === "message_delta").usage;
    expect(usage).toEqual(wire);
    expect(canonicalizeUsage(usage).prompt_tokens).toBe(prompt);
  });

  it.each(usageCases)("maps $name to exclusive Claude non-stream usage", ({ raw, wire, prompt }) => {
    const response = responsesToClaudeMessage(usageResponse(raw));
    expect(response.content).toEqual([{ type: "text", text: "final text" }]);
    expect(response.usage).toEqual(wire);
    expect(canonicalizeUsage(response.usage).prompt_tokens).toBe(prompt);
  });

  it("keeps stream wire and completion accounting on the same inclusive total", async () => {
    const response = usageResponse({ input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 } });
    let capturedUsage;
    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex", null, null,
      "gpt-6.1-sol", "compatibility-fixture", null,
      (_content, usage) => { capturedUsage = usage; }
    );
    const raw = sseFrame({ type: "response.created", response: { id: response.id } })
      + sseFrame({ type: "response.output_item.done", output_index: 0, item: response.output[0] })
      + sseFrame({ type: "response.completed", response });
    const wireText = await new Response(new Response(raw).body.pipeThrough(transform)).text();
    const frames = wireText.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
    expect(frames.find((event) => event.type === "message_delta").usage).toEqual({ input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 60 });
    expect(canonicalizeUsage(capturedUsage)).toMatchObject({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 40, cache_creation_input_tokens: 60 });
  });

  it.each([FORMATS.CLAUDE, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])("keeps forced SSE JSON and recorded usage consistent for %s", async (sourceFormat) => {
    vi.clearAllMocks();
    const response = usageResponse({ input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 } });
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(sseFrame({ type: "response.completed", response }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat, targetFormat: FORMATS.OPENAI_RESPONSES, provider: "codex", model: "gpt-6.1-sol",
      body: { messages: [{ role: "user", content: "fixture" }] }, stream: false,
      requestStartTime: Date.now(), connectionId: "compatibility-fixture", apiKey: null,
      clientRawRequest: { endpoint: "/v1/messages" }, trackDone: vi.fn(), appendLog: vi.fn(), log: null,
    });
    expect(result.success).toBe(true);
    const body = await result.response.json();
    if (sourceFormat === FORMATS.CLAUDE) {
      expect(body.usage).toEqual({ input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 60 });
      expect(body.content).toEqual([{ type: "text", text: "final text" }]);
    } else if (sourceFormat === FORMATS.OPENAI) {
      expect(body.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40, cache_creation_tokens: 60 } });
    } else {
      expect(body.usage).toEqual(response.usage);
    }
    expect(usageDb.saveRequestUsage.mock.lastCall[0].tokens).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 40, cache_creation_input_tokens: 60 });
    expect(usageDb.saveRequestDetail.mock.lastCall[0].tokens).toMatchObject({ prompt_tokens: 100, completion_tokens: 20 });
  });
});

describe("responses-to-claude response event coverage (F4/F5)", () => {
  it("forwards response.reasoning_text.delta as thinking", () => {
    const out = run([
      { type: "response.created", response: { id: "resp_reasoning_text" } },
      { type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "visible reasoning" },
    ]);
    expect(out.some((event) => event.delta?.thinking === "visible reasoning")).toBe(true);
  });

  it("preserves complete text delivered only via output_item.done", () => {
    const out = run([
      { type: "response.created", response: { id: "resp_done_text" } },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "final text" }],
        },
      },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    const texts = out.filter((event) => event.delta?.text === "final text");
    expect(texts).toHaveLength(1);
    expect(out.filter((event) => event.type === "message_stop")).toHaveLength(1);
    expect(out.filter((event) => event.type === "content_block_start")).toHaveLength(1);
    expect(out.filter((event) => event.type === "content_block_stop")).toHaveLength(1);
  });

  it.each([
    ["final text", "final text"],
    ["final ", "final text"],
  ])("deduplicates done text after delta %s", (delta, text) => {
    const done = {
      type: "response.output_item.done", output_index: 0,
      item: { type: "message", id: "msg_dedup", role: "assistant", content: [{ type: "output_text", text }] },
    };
    const out = run([
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_dedup", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta },
      done, done,
      { type: "response.completed", response: { status: "completed" } },
    ]);
    expect(out.map((event) => event.delta?.text || "").join("")).toBe("final text");
    expect(out.filter((event) => event.type === "content_block_start")).toHaveLength(1);
    expect(out.filter((event) => event.type === "content_block_stop")).toHaveLength(1);
  });

  it("deduplicates an item_id-only delta when done supplies output_index", () => {
    const out = run([
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_alias", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_alias", content_index: 0, delta: "prefix " },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "prefix suffix" }] } },
    ]);
    expect(out.map((event) => event.delta?.text || "").join("")).toBe("prefix suffix");
  });

  it("keeps identical text in different message items and content parts", () => {
    const out = run([0, 1].map((output_index) => ({
      type: "response.output_item.done", output_index,
      item: { type: "message", id: `msg_${output_index}`, role: "assistant", content: [
        { type: "output_text", text: "same" }, { type: "output_text", text: "same" },
      ] },
    })));
    expect(out.map((event) => event.delta?.text || "").join("")).toBe("samesamesamesame");
  });
});
