import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

// Production call shape from chatCore: targetFormat = providerResponseFormat
// (what the UPSTREAM spoke), sourceFormat = CLIENT format.
const baseCtx = (providerResponse, sourceFormat = FORMATS.OPENAI, targetFormat = FORMATS.OPENAI) => ({
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
  clientRawRequest: { endpoint: "/v1/chat/completions" },
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

describe("non-streaming empty JSON guard (Claude Code / Codex clients)", () => {
  it("providerResponse.json()={} returns 502 with provider/model/status, never an empty chat.completion HTTP200", async () => {
    const result = await handleNonStreamingResponse(baseCtx(jsonResponse({})));

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toContain("opencode");
    expect(json.error.message).toContain("muse-spark-1.2-contributor-free");
    expect(json.error.message).toContain("200");
    expect(json).not.toHaveProperty("choices");
    expect(json).not.toHaveProperty("output");
  });

  it("providerResponse={choices:[]} returns 502, never a wrong-shape HTTP200", async () => {
    const result = await handleNonStreamingResponse(baseCtx(jsonResponse({ choices: [] })));

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toContain("opencode");
    expect(json).not.toHaveProperty("choices");
  });

  it("valid Chat Completions JSON passes through unchanged (still HTTP200)", async () => {
    const valid = {
      id: "chatcmpl-abc",
      object: "chat.completion",
      created: 1700000000,
      model: "muse-spark-1.2-contributor-free",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
    const result = await handleNonStreamingResponse(baseCtx(jsonResponse(valid)));

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("hi");
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("valid Responses API JSON (source==target) passes through unchanged", async () => {
    const valid = {
      id: "resp_abc",
      object: "response",
      created_at: 1700000000,
      status: "completed",
      model: "muse-spark-1.2-contributor-free",
      output: [
        { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] },
      ],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    };
    const result = await handleNonStreamingResponse(
      baseCtx(jsonResponse(valid), FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES)
    );

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    expect(json.output).toHaveLength(1);
  });

  // Finding 2: missing terminal in handleNonStreamingResponse must return 502, not 200 OK
  it("Finding 2: handleNonStreamingResponse with Responses API upstream and missing terminal SSE returns 502, not 200", async () => {
    const encoder = new TextEncoder();
    const missingTerminalSSE = new Response(new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x","status":"in_progress"}}\n\n'
        ));
        c.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });

    const ctx = baseCtx(missingTerminalSSE, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const result = await handleNonStreamingResponse(ctx);

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  // Finding 4: sourceFormat CLAUDE must reject error objects and empty Gemini, not return HTTP200 chat.completion
  it("Finding 4: handleNonStreamingResponse with sourceFormat CLAUDE rejects {error:...} object, does not return HTTP200 chat.completion", async () => {
    const errorPayload = { error: { message: "Quota exceeded", code: 429 } };
    const ctx = baseCtx(jsonResponse(errorPayload), FORMATS.CLAUDE, FORMATS.OPENAI);
    ctx.clientRawRequest = { endpoint: "/v1/messages" };
    const result = await handleNonStreamingResponse(ctx);

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("Finding 4: handleNonStreamingResponse with sourceFormat CLAUDE rejects empty Gemini {response:{}}, does not return HTTP200 chat.completion", async () => {
    const geminiPayload = { response: {} };
    const ctx = baseCtx(jsonResponse(geminiPayload), FORMATS.CLAUDE, FORMATS.GEMINI);
    ctx.clientRawRequest = { endpoint: "/v1/messages" };
    const result = await handleNonStreamingResponse(ctx);

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  // Finding 1: /v1/messages client routed to Responses upstream (Codex/OpenCode)
  it("Finding 1: /v1/messages with Responses API upstream converts text, usage, and stop_reason to Claude message", async () => {
    const responsesPayload = {
      id: "resp_test_claude",
      object: "response",
      created_at: 1700000000,
      model: "gpt-5-codex",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from Codex Responses", annotations: [] }]
        }
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20
      }
    };

    const ctx = baseCtx(jsonResponse(responsesPayload), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    ctx.clientRawRequest = { endpoint: "/v1/messages" };
    const result = await handleNonStreamingResponse(ctx);

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.content).toEqual([{ type: "text", text: "Hello from Codex Responses" }]);
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage.input_tokens).toBeGreaterThanOrEqual(100);
    expect(json.usage.output_tokens).toBe(50);
    expect(json.usage.cache_read_input_tokens).toBe(20);
    expect(json).not.toHaveProperty("choices");
  });

  it("Finding 1: /v1/messages preserves parallel same-name tools + IDs and restores fingerprinted names", async () => {
    const responsesPayload = {
      id: "resp_tools",
      object: "response",
      created_at: 1700000000,
      model: "muse-spark-1.3-contributor-free",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_read_1",
          name: "read",
          arguments: JSON.stringify({ file_path: "a.txt" })
        },
        {
          type: "function_call",
          id: "fc_2",
          call_id: "call_read_2",
          name: "read",
          arguments: JSON.stringify({ file_path: "b.txt" })
        }
      ],
      usage: { input_tokens: 10, output_tokens: 20 }
    };

    const toolNameMap = new Map([["read", "Read"]]);
    const ctx = baseCtx(jsonResponse(responsesPayload), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    ctx.toolNameMap = toolNameMap;
    ctx.clientRawRequest = { endpoint: "/v1/messages" };
    const result = await handleNonStreamingResponse(ctx);

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
  });

  it("Finding 1: /v1/messages incomplete status with max_output_tokens maps to max_tokens", async () => {
    const truncatedPayload = {
      id: "resp_trunc",
      object: "response",
      created_at: 1700000000,
      model: "gpt-5-codex",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Truncated output...", annotations: [] }]
        }
      ],
      usage: { input_tokens: 50, output_tokens: 100 }
    };

    const ctx = baseCtx(jsonResponse(truncatedPayload), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    ctx.clientRawRequest = { endpoint: "/v1/messages" };
    const result = await handleNonStreamingResponse(ctx);

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("max_tokens");
    expect(json.content[0].text).toBe("Truncated output...");
  });
});
