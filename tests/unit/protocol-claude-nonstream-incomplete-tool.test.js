import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse, translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

// Upstream Responses API JSON truncated by max_output_tokens WHILE a tool call
// was open. Truncation must win over tool presence: Claude max_tokens,
// Chat length — same contract as the streaming translator (T7).
const INCOMPLETE_TOOL_JSON = {
  id: "resp_incomplete_tool",
  object: "response",
  created_at: 1700000000,
  model: "gpt-5-codex",
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  output: [
    {
      type: "function_call",
      id: "fc_trunc_1",
      call_id: "call_trunc_1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "a.txt" }),
    },
  ],
  usage: { input_tokens: 50, output_tokens: 100, total_tokens: 150 },
};

const COMPLETED_TOOL_JSON = {
  ...INCOMPLETE_TOOL_JSON,
  id: "resp_completed_tool",
  status: "completed",
  incomplete_details: undefined,
};

const INCOMPLETE_TEXT_JSON = {
  ...INCOMPLETE_TOOL_JSON,
  id: "resp_incomplete_text",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Truncated output...", annotations: [] }],
    },
  ],
};

const baseCtx = (providerResponse, sourceFormat, targetFormat, endpoint) => ({
  providerResponse,
  provider: "opencode",
  model: "muse-spark-1.2-contributor-free",
  sourceFormat,
  targetFormat,
  body: { model: "muse-spark-1.2-contributor-free", stream: false, messages: [{ role: "user", content: "hi" }] },
  stream: false,
  translatedBody: { model: "muse-spark-1.2-contributor-free", input: [], stream: false },
  finalBody: null,
  requestStartTime: Date.now(),
  connectionId: "test-conn",
  apiKey: null,
  clientRawRequest: { endpoint },
  reqLogger: { logTargetRequest: vi.fn(), logError: vi.fn(), logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
  toolNameMap: null,
  customToolNames: null,
  trackDone: vi.fn(),
  appendLog: vi.fn(),
  reqTag: "",
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn() },
});

const jsonResponse = (payload) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "content-type": "application/json" },
});

describe("incomplete max_output_tokens beats tool presence (non-streaming)", () => {
  it("Claude client via handleNonStreamingResponse /v1/messages → max_tokens, tool_use block kept", async () => {
    const ctx = baseCtx(jsonResponse(INCOMPLETE_TOOL_JSON), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "/v1/messages");
    const result = await handleNonStreamingResponse(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("max_tokens");
    const tu = json.content.find((b) => b.type === "tool_use");
    expect(tu).toBeTruthy();
    expect(tu.id).toBe("call_trunc_1");
    expect(tu.input).toEqual({ file_path: "a.txt" });
  });

  it("Chat client via translateNonStreamingResponse → length (tool_calls block kept)", async () => {
    // NOTE: handleNonStreamingResponse post-override forces tool_calls whenever
    // tool_calls exist (nonStreamingHandler.js, not owned here) — so Chat length
    // is asserted at the shared-formatter level, the root fix location.
    const json = translateNonStreamingResponse(INCOMPLETE_TOOL_JSON, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].finish_reason).toBe("length");
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
  });

  it("Claude client via handleForcedSSEToJson forced Responses SSE → max_tokens", async () => {
    const encoder = new TextEncoder();
    const fcItem = {
      type: "function_call",
      id: "fc_sse_1",
      call_id: "call_sse_1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "a.txt" }),
    };
    const raw =
      "event: response.output_item.done\n" +
      `data: ${JSON.stringify({ output_index: 0, item: fcItem })}\n\n` +
      "event: response.completed\n" +
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_sse_trunc", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } } })}\n\n`;
    const ctx = {
      providerResponse: new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(raw)); c.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      model: "gpt-5",
      body: { model: "gpt-5", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/messages" },
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    };
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("max_tokens");
  });

  it("truncated tool args parsing to {} still report max_tokens, not tool_use", async () => {
    const truncatedArgs = {
      ...INCOMPLETE_TOOL_JSON,
      id: "resp_incomplete_truncargs",
      output: [{ ...INCOMPLETE_TOOL_JSON.output[0], arguments: '{"file_path":"/trunc' }],
    };
    const ctx = baseCtx(jsonResponse(truncatedArgs), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "/v1/messages");
    const result = await handleNonStreamingResponse(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.stop_reason).toBe("max_tokens");
    const tu = json.content.find((b) => b.type === "tool_use");
    expect(tu).toBeTruthy();
    expect(tu.input).toEqual({});
  });
});

describe("actual handler root fixes (truncation beats tools, error fails)", () => {
  it("Chat handleNonStreamingResponse truncated max_output_tokens + tool_calls -> length", async () => {
    const ctx = baseCtx(jsonResponse(INCOMPLETE_TOOL_JSON), FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "/v1/chat/completions");
    const result = await handleNonStreamingResponse(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("length");
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
  });

  it("Chat handleForcedSSEToJson truncated max_output_tokens + tool_calls -> length", async () => {
    const encoder = new TextEncoder();
    const fcItem = {
      type: "function_call",
      id: "fc_sse_chat_1",
      call_id: "call_sse_chat_1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "a.txt" }),
    };
    const raw =
      "event: response.output_item.done\n" +
      `data: ${JSON.stringify({ output_index: 0, item: fcItem })}\n\n` +
      "event: response.completed\n" +
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_sse_chat_trunc", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } } })}\n\n`;
    const ctx = {
      providerResponse: new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(raw)); c.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      model: "gpt-5",
      body: { model: "gpt-5", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    };
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("length");
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
  });

  it("incomplete missing incomplete_details + tool -> max_tokens (Claude) / length (Chat)", async () => {
    const missing = {
      ...INCOMPLETE_TOOL_JSON,
      id: "resp_incomplete_nodetails",
      status: "incomplete",
      incomplete_details: undefined,
    };
    delete missing.incomplete_details;
    const claude = await handleNonStreamingResponse(
      baseCtx(jsonResponse(missing), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "/v1/messages")
    );
    expect((await claude.response.json()).stop_reason).toBe("max_tokens");
    const chat = await handleNonStreamingResponse(
      baseCtx(jsonResponse(missing), FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "/v1/chat/completions")
    );
    expect((await chat.response.json()).choices[0].finish_reason).toBe("length");
  });

  it("reason max_tokens variant + tool -> max_tokens (Claude) / length (Chat)", async () => {
    const variant = {
      ...INCOMPLETE_TOOL_JSON,
      id: "resp_incomplete_maxtokens",
      incomplete_details: { reason: "max_tokens" },
    };
    const claude = await handleNonStreamingResponse(
      baseCtx(jsonResponse(variant), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "/v1/messages")
    );
    expect((await claude.response.json()).stop_reason).toBe("max_tokens");
    const chat = await handleNonStreamingResponse(
      baseCtx(jsonResponse(variant), FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "/v1/chat/completions")
    );
    expect((await chat.response.json()).choices[0].finish_reason).toBe("length");
  });

  it("error event before DONE -> 502, no tool_use success body", async () => {
    const encoder = new TextEncoder();
    const fcItem = {
      type: "function_call",
      id: "fc_sse_err_1",
      call_id: "call_sse_err_1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "a.txt" }),
    };
    const raw =
      "event: response.output_item.done\n" +
      `data: ${JSON.stringify({ output_index: 0, item: fcItem })}\n\n` +
      "event: error\n" +
      `data: ${JSON.stringify({ type: "error", error: { message: "upstream overloaded", type: "api_error" } })}\n\n` +
      "event: response.completed\n" +
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_sse_err", status: "completed", usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } } })}\n\n`;
    const ctx = {
      providerResponse: new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(raw)); c.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      model: "gpt-5",
      body: { model: "gpt-5", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/messages" },
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    };
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("Chat forced SSE completed tool_calls stays tool_calls (no over-correction)", async () => {
    const encoder = new TextEncoder();
    const fcItem = {
      type: "function_call",
      id: "fc_sse_ok_1",
      call_id: "call_sse_ok_1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "a.txt" }),
    };
    const raw =
      "event: response.output_item.done\n" +
      `data: ${JSON.stringify({ output_index: 0, item: fcItem })}\n\n` +
      "event: response.completed\n" +
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_sse_ok", status: "completed", usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } } })}\n\n`;
    const ctx = {
      providerResponse: new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(raw)); c.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      model: "gpt-5",
      body: { model: "gpt-5", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    };
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    expect((await result.response.json()).choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("incomplete-tool guards (green before and after)", () => {
  it("completed tool_calls still tool_use (Claude) / tool_calls (Chat)", async () => {
    const claude = await handleNonStreamingResponse(
      baseCtx(jsonResponse(COMPLETED_TOOL_JSON), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "/v1/messages")
    );
    expect((await claude.response.json()).stop_reason).toBe("tool_use");
    const chat = await handleNonStreamingResponse(
      baseCtx(jsonResponse(COMPLETED_TOOL_JSON), FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "/v1/chat/completions")
    );
    expect((await chat.response.json()).choices[0].finish_reason).toBe("tool_calls");
  });

  it("plain incomplete text (no tools) still max_tokens (Claude) / length (Chat)", async () => {
    const claude = await handleNonStreamingResponse(
      baseCtx(jsonResponse(INCOMPLETE_TEXT_JSON), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "/v1/messages")
    );
    const claudeJson = await claude.response.json();
    expect(claudeJson.stop_reason).toBe("max_tokens");
    expect(claudeJson.content[0].text).toBe("Truncated output...");
    const chat = await handleNonStreamingResponse(
      baseCtx(jsonResponse(INCOMPLETE_TEXT_JSON), FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "/v1/chat/completions")
    );
    expect((await chat.response.json()).choices[0].finish_reason).toBe("length");
  });

  it("same-format Responses client stays untouched", async () => {
    const result = await handleNonStreamingResponse(
      baseCtx(jsonResponse(INCOMPLETE_TOOL_JSON), FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "/v1/responses")
    );
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    expect(json.status).toBe("incomplete");
    expect(json.output).toHaveLength(1);
  });
});
