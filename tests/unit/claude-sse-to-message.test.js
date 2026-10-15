import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ execute: executeMock, refreshCredentials: vi.fn().mockResolvedValue(null) })),
}));
vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({ signal: undefined, handleComplete: vi.fn(), handleError: vi.fn() })),
  pipeWithDisconnect: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), appendConvertedChunk: vi.fn(),
  })),
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({ detectClientTool: vi.fn(() => null), isNativePassthrough: vi.fn(() => false) }));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn(), proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/translator/formats/claude.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, normalizeClaudePassthrough: vi.fn(), anchorClaudeCache: vi.fn() };
});
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));
vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(() => null), formatRtkLog: vi.fn(() => "") }));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null), formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""), isHeadroomPhantomSavings: vi.fn(() => false),
}));
vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));
vi.mock("../../open-sse/translator/concerns/modality.js", () => ({ stripUnsupportedModalities: vi.fn(() => false) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("../../open-sse/config/providers.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PROVIDERS: { ...actual.PROVIDERS, opencode: { ...(actual.PROVIDERS?.opencode || {}), forceStream: true } } };
});
vi.mock("../../open-sse/handlers/chatCore/upstreamRoute.js", () => ({
  resolveUpstreamRoute: vi.fn(() => ({ targetFormat: "claude", transport: null })),
}));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
  extractUsageFromResponse: vi.fn(() => ({ prompt_tokens: 0, completion_tokens: 0 })),
  saveUsageStats: vi.fn(() => Promise.resolve()),
  formatDoneLine: vi.fn(() => "done"),
}));
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}), trackPendingRequest: vi.fn(),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

const ctx = (raw, sourceFormat = FORMATS.CLAUDE, targetFormat = FORMATS.CLAUDE) => ({
  providerResponse: new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }),
  provider: "opencode", model: "claude-sonnet-4-5", sourceFormat, targetFormat,
  body: { model: "claude-sonnet-4-5", stream: false, messages: [] }, stream: false,
  translatedBody: null, finalBody: null, requestStartTime: Date.now(), connectionId: "c1", apiKey: null,
  clientRawRequest: { endpoint: "/v1/messages" }, toolNameMap: null, customToolNames: null,
  reqLogger: { logTargetRequest: vi.fn(), logError: vi.fn(), logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
  trackDone: vi.fn(), appendLog: vi.fn(), reqTag: "", log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn() },
});
const F = (event, data) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;

const GOOD = F("message_start", { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } } })
  + F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "Hello " } })
  + F("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } })
  + F("content_block_stop", { type: "content_block_stop", index: 0 })
  + F("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } })
  + F("message_stop", { type: "message_stop" });

describe("claude SSE non-stream via public handler", () => {
  it("Claude SSE non-stream returns a native Message on result.response", async () => {
    const result = await handleNonStreamingResponse(ctx(GOOD));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json).toMatchObject({ type: "message", id: "msg_1", stop_reason: "end_turn", content: [{ type: "text", text: "Hello world" }] });
    // nonStreamingHandler always runs filterUsageForFormat(addBufferToUsage(usage), sourceFormat):
    // BUFFER_TOKENS 2000 lands on input_tokens, so input is never exactly 100.
    expect(json.usage.cache_read_input_tokens).toBe(200);
    expect(json.usage.cache_creation_input_tokens).toBe(30);
    expect(json.usage.output_tokens).toBe(50);
    expect(json.usage.input_tokens).toBeGreaterThanOrEqual(100);
  });

  it("truncated tool_use partial_json is 502, never a success body with input {}", async () => {
    const truncated = F("message_start", { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 10, output_tokens: 1 } } })
      + F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } })
      + F("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path": "/trunc' } })
      + F("content_block_stop", { type: "content_block_stop", index: 0 }) + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(truncated));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("tool_use cut before content_block_stop is 502, never a success body with the seeded input {}", async () => {
    const cut = F("message_start", { type: "message_start", message: { id: "msg_3", usage: { input_tokens: 10, output_tokens: 1 } } })
      + F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "Read", input: {} } })
      + F("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(cut));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("missing message_start is 502", async () => {
    const raw = F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "hi" } })
      + F("content_block_stop", { type: "content_block_stop", index: 0 })
      + F("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("missing message_stop is 502", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_4", usage: { input_tokens: 5, output_tokens: 1 } } })
      + F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "hi" } })
      + F("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } })
      + F("content_block_stop", { type: "content_block_stop", index: 0 })
      + F("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("started block without stop is 502 (block_not_stopped)", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_5", usage: { input_tokens: 5, output_tokens: 1 } } })
      + F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "half " } })
      + F("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "open" } })
      + F("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("cache-only message_start stays success and keeps cache", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_cache", usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 50 } } })
      + F("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toEqual([]);
    expect(json.usage.cache_read_input_tokens).toBe(50);
  });

  it("event:error with parseable payload is 502 without upstream text", async () => {
    const secret = "sk-super-secret-xyz-123";
    const raw = F("message_start", { type: "message_start", message: { id: "msg_6", usage: { input_tokens: 5, output_tokens: 1 } } })
      + `event: error\r\ndata: ${JSON.stringify({ type: "error", error: { message: secret } })}\r\n\r\n`
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    const bodyText = await result.response.text();
    expect(bodyText).not.toContain(secret);
  });

  it("event:error with unparseable data is 502 without echo", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_7", usage: { input_tokens: 5, output_tokens: 1 } } })
      + "event: error\r\ndata: not-json{{{oops\r\n\r\n"
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    const bodyText = await result.response.text();
    expect(bodyText).not.toContain("not-json");
  });

  it("error payload object without event name is 502", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_8", usage: { input_tokens: 5, output_tokens: 1 } } })
      + F("message", { type: "error", error: { message: "overloaded" } })
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("unparseable data frame in a complete stream is 502 (fail closed)", async () => {
    const raw = GOOD + "event: content_block_delta\r\ndata: not-json{{{\r\n\r\n";
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("[DONE] is not a Claude terminal: start + [DONE] without stop is 502", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_done", usage: { input_tokens: 5, output_tokens: 1 } } })
      + "data: [DONE]\r\n\r\n";
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("thinking seeded text plus signature_delta appends, never replaces", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_th", usage: { input_tokens: 5, output_tokens: 1 } } })
      + F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "think ", signature: "sig1" } })
      + F("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "more" } })
      + F("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig2" } })
      + F("content_block_stop", { type: "content_block_stop", index: 0 })
      + F("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } })
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.content[0]).toMatchObject({ type: "thinking", thinking: "think more", signature: "sig1sig2" });
  });

  it("server_tool_use and redacted_thinking stay opaque, never visible thinking", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_op", usage: { input_tokens: 5, output_tokens: 1 } } })
      + F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: { q: "hi" }, extra: "keep" } })
      + F("content_block_stop", { type: "content_block_stop", index: 0 })
      + F("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque-blob" } })
      + F("content_block_stop", { type: "content_block_stop", index: 1 })
      + F("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.content[0]).toMatchObject({ type: "server_tool_use", id: "srv_1", name: "web_search", input: { q: "hi" }, extra: "keep" });
    expect(json.content[1]).toMatchObject({ type: "redacted_thinking", data: "opaque-blob" });
    expect(json.content.find((b) => b.type === "thinking")).toBeUndefined();
  });

  it("multiline data frames and LF-only endings parse", async () => {
    const raw = "event: message_start\n"
      + 'data: {"type": "message_start", "message": {"id": "msg_ml", "usage": {"input_tokens": 7, "output_tokens": 1}}}\n\n'
      + "event: message_delta\n"
      + 'data: {\n'
      + 'data: "type": "message_delta",\n'
      + 'data: "delta": {"stop_reason": "end_turn"},\n'
      + 'data: "usage": {"output_tokens": 4}\n'
      + "data: }\n\n"
      + "event: message_stop\n"
      + 'data: {"type": "message_stop"}\n\n';
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.id).toBe("msg_ml");
    expect(json.stop_reason).toBe("end_turn");
    expect(json.content).toEqual([]);
  });

  it("tool_use with full seeded input and no deltas keeps seeded object", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_seed", usage: { input_tokens: 8, output_tokens: 1 } } })
      + F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "Read", input: { file_path: "/a.txt" } } })
      + F("content_block_stop", { type: "content_block_stop", index: 0 })
      + F("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } })
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.content[0]).toMatchObject({ type: "tool_use", id: "toolu_9", name: "Read", input: { file_path: "/a.txt" } });
  });

  it("message with no blocks yields content []", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_empty", usage: { input_tokens: 3, output_tokens: 1 } } })
      + F("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(true);
    expect((await result.response.json()).content).toEqual([]);
  });

  it("content after message_stop is ignored, original content stands", async () => {
    const extra = F("content_block_start", { type: "content_block_start", index: 9, content_block: { type: "text", text: "LATE" } })
      + F("content_block_delta", { type: "content_block_delta", index: 9, delta: { type: "text_delta", text: "!" } })
      + F("content_block_stop", { type: "content_block_stop", index: 9 });
    const result = await handleNonStreamingResponse(ctx(GOOD + extra));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("error after content still fails, never synthetic success", async () => {
    const raw = F("message_start", { type: "message_start", message: { id: "msg_late", usage: { input_tokens: 5, output_tokens: 1 } } })
      + F("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "hi" } })
      + F("content_block_stop", { type: "content_block_stop", index: 0 })
      + `event: error\r\ndata: ${JSON.stringify({ type: "error", error: { message: "late boom" } })}\r\n\r\n`
      + F("message_stop", { type: "message_stop" });
    const result = await handleNonStreamingResponse(ctx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("old lane: OPENAI_RESPONSES target still uses Responses converter", async () => {
    const enc = new TextEncoder();
    const item = { type: "message", id: "msg_r", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] };
    const raw = "event: response.output_item.done\n" + `data: ${JSON.stringify({ output_index: 0, item })}\n\n`
      + "event: response.completed\n" + `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_r", status: "completed", model: "gpt-5", usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } } })}\n\n`;
    const providerResponse = new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(raw)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const result = await handleNonStreamingResponse({
      ...ctx("", FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES), providerResponse,
      clientRawRequest: { endpoint: "/v1/responses" },
    });
    expect(result.success).toBe(true);
  });

  it("old lane: OPENAI target still uses Chat SSE parser", async () => {
    const raw = 'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
    const result = await handleNonStreamingResponse(ctx(raw, FORMATS.OPENAI, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("hi");
  });
});

describe("forced-stream Claude upstream + JSON client", () => {
  beforeEach(() => { executeMock.mockReset(); });

  it("routes through the Claude parser, not sseToJsonHandler", async () => {
    executeMock.mockResolvedValue({
      response: new Response(GOOD, { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://upstream.example/v1/messages", headers: {}, transformedBody: null,
    });
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const body = { model: "claude-sonnet-4-5", stream: false, messages: [{ role: "user", content: "hi" }] };
    const result = await handleChatCore({
      body, modelInfo: { provider: "opencode", model: "claude-sonnet-4-5" }, credentials: { apiKey: "sk-test" },
      sourceFormatOverride: FORMATS.CLAUDE,
      clientRawRequest: { endpoint: "/v1/messages", body, headers: { accept: "application/json" } },
      connectionId: "forced-claude", log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(result.success).toBe(true);
    expect(executeMock.mock.calls[0][0].stream).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toEqual([{ type: "text", text: "Hello world" }]);
  });
});
