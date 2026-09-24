import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const {
  handleForcedSSEToJson,
  parseSSEToOpenAIResponse
} = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const sseCtx = (raw, provider = "op-test-chat") => {
  const encoder = new TextEncoder();
  return {
    providerResponse: new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
    }), { headers: { "content-type": "text/event-stream" } }),
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    provider,
    model: "gpt-x",
    body: { model: "gpt-x", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn()
  };
};

describe("parseSSEToOpenAIResponse giữ lỗi text/HTML", () => {
  // Intentional change for security: diagnostics are count-only, raw HTML/payload is never echoed
  it("SSE toàn text/HTML trả error kèm đếm dòng, không echo raw payload hay null im lặng", () => {
    const raw = [
      "data: <html><body>Bad Gateway SYNTHETIC_SECRET_LEAK_TEST</body></html>",
      "data: upstream proxy error line two",
      "data: [DONE]"
    ].join("\n");
    const parsed = parseSSEToOpenAIResponse(raw, "gpt-x");
    expect(parsed).not.toBeNull();
    expect(parsed.error).toBeTruthy();
    expect(parsed.error.message).toContain("2 non-JSON data line(s) skipped");
    expect(parsed.error.message).not.toContain("Bad Gateway");
    expect(parsed.error.message).not.toContain("SYNTHETIC_SECRET_LEAK_TEST");
  });

  it("data JSON dạng chunk.error vẫn trả error như cũ", () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
      'data: {"error":{"message":"boom","code":"upstream_fail"}}',
      "data: [DONE]"
    ].join("\n\n");
    expect(parseSSEToOpenAIResponse(raw, "gpt-x")).toEqual({
      error: { message: "boom", code: "upstream_fail" }
    });
  });

  it("SSE rỗng hoàn toàn vẫn null để handler trả 502 chung", () => {
    expect(parseSSEToOpenAIResponse("", "gpt-x")).toBeNull();
    expect(parseSSEToOpenAIResponse("data: [DONE]\n", "gpt-x")).toBeNull();
  });
});

describe("handleForcedSSEToJson SSE text/HTML trả 502 kèm mẫu, không raw 200", () => {
  // Intentional change for security: 502 message contains count-only diagnostics, never raw HTML
  it("SSE toàn text/HTML trả 502, message kèm đếm dòng, không echo raw HTML", async () => {
    const raw = "data: <html>Bad Gateway SYNTHETIC_SECRET_LEAK_TEST</html>\ndata: [DONE]\n";
    const result = await handleForcedSSEToJson(sseCtx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toContain("1 non-JSON data line(s) skipped");
    expect(json.error.message).not.toContain("Bad Gateway");
    expect(json.error.message).not.toContain("SYNTHETIC_SECRET_LEAK_TEST");
    expect(json).not.toHaveProperty("choices");
  });
});

describe("handleForcedSSEToJson Responses SSE rỗng/thiếu terminal trả failed 502", () => {
  const responsesCtx = (raw) => {
    const encoder = new TextEncoder();
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
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
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it("Responses SSE rỗng trả failed 502, không in_progress 200", async () => {
    const result = await handleForcedSSEToJson(responsesCtx(""));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toContain("failed");
    expect(json).not.toHaveProperty("choices");
  });

  // Finding 3: parseSSEToOpenAIResponse must not echo raw payload into error message
  it("Finding 3: parseSSEToOpenAIResponse returns count-only diagnostics (no raw payload echo)", async () => {
    const raw = "data: <html><body>BLOCKED_MARKER_12345</body></html>\ndata: [DONE]\n";
    const parsed = parseSSEToOpenAIResponse(raw, "gpt-x");
    expect(parsed).not.toBeNull();
    expect(parsed.error).toBeTruthy();
    expect(parsed.error.message).toContain("1");
    expect(parsed.error.message).not.toContain("BLOCKED_MARKER_12345");
  });

  // Finding 1: handleForcedSSEToJson with sourceFormat CLAUDE must return Claude message, not Chat Completions
  it("Finding 1: handleForcedSSEToJson with sourceFormat CLAUDE returns Claude message, not Chat Completions", async () => {
    const encoder = new TextEncoder();
    const raw =
      'data: {"id":"chatcmpl-1","object":"chat.completion","created":1700000000,"model":"gpt-x","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n' +
      'data: {"id":"chatcmpl-1","object":"chat.completion","created":1700000000,"model":"gpt-x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n' +
      "data: [DONE]\n";
    const ctx = {
      ...sseCtx(raw),
      sourceFormat: FORMATS.CLAUDE,
      clientRawRequest: { endpoint: "/v1/messages" },
      reqTag: "",
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, line: () => {} },
    };
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json).not.toHaveProperty("choices");
    expect(json.type).toBe("message");
    expect(json.content).toBeDefined();
  });

  it("Finding 1: handleForcedSSEToJson with sourceFormat CLAUDE and parallel same-name tool deltas preserves names + IDs", async () => {
    const encoder = new TextEncoder();
    const raw =
      'data: {"id":"chatcmpl-2","object":"chat.completion","created":1700000000,"model":"gpt-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_read_1","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"a.txt\\"}"}}]},"finish_reason":null}]}\n' +
      'data: {"id":"chatcmpl-2","object":"chat.completion","created":1700000000,"model":"gpt-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_read_2","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"b.txt\\"}"}}]},"finish_reason":null}]}\n' +
      'data: {"id":"chatcmpl-2","object":"chat.completion","created":1700000000,"model":"gpt-x","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n' +
      "data: [DONE]\n";
    const ctx = {
      ...sseCtx(raw),
      sourceFormat: FORMATS.CLAUDE,
      clientRawRequest: { endpoint: "/v1/messages" },
      reqTag: "",
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, line: () => {} },
    };
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("tool_use");
    expect(json.content).toHaveLength(2);
    expect(json.content[0]).toEqual({
      type: "tool_use",
      id: "call_read_1",
      name: "Read",
      input: { file_path: "a.txt" }
    });
    expect(json.content[1]).toEqual({
      type: "tool_use",
      id: "call_read_2",
      name: "Read",
      input: { file_path: "b.txt" }
    });
    expect(json).not.toHaveProperty("choices");
  });

  it("Finding 1: handleForcedSSEToJson with sourceFormat OPENAI_RESPONSES returns Responses object, not Chat Completions", async () => {
    const encoder = new TextEncoder();
    const raw =
      'data: {"id":"chatcmpl-1","object":"chat.completion","created":1700000000,"model":"gpt-x","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n' +
      'data: {"id":"chatcmpl-1","object":"chat.completion","created":1700000000,"model":"gpt-x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n' +
      "data: [DONE]\n";
    const ctx = {
      ...sseCtx(raw),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      clientRawRequest: { endpoint: "/v1/responses" },
      reqTag: "",
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, line: () => {} },
    };
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json).not.toHaveProperty("choices");
    expect(json.object).toBe("response");
  });

  it("Finding 1: handleForcedSSEToJson with sourceFormat OPENAI returns Chat Completions (no shape regression)", async () => {
    const encoder = new TextEncoder();
    const raw =
      'data: {"id":"chatcmpl-1","object":"chat.completion","created":1700000000,"model":"gpt-x","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n' +
      'data: {"id":"chatcmpl-1","object":"chat.completion","created":1700000000,"model":"gpt-x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n' +
      "data: [DONE]\n";
    const result = await handleForcedSSEToJson(sseCtx(raw));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices).toHaveLength(1);
  });

  it("Responses SSE thiếu terminal trả failed 502", async () => {
    const raw =
      "event: response.created\n" +
      'data: {"type":"response.created","response":{"id":"resp_x","status":"in_progress"}}\n\n' +
      "event: response.output_item.done\n" +
      'data: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial","annotations":[]}]}}\n\n';
    const result = await handleForcedSSEToJson(responsesCtx(raw));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });
});
