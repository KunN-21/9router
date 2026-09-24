import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createSSEStream, createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");

async function runStream(chunks, streamOptions) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
  const transformStream = createSSEStream(streamOptions);
  const output = stream.pipeThrough(transformStream);
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function splitFrames(text) {
  return text.split("\n\n").filter((f) => f.trim() !== "");
}

async function runHandleStreamingResponse({ upstreamBody, provider, sourceFormat, targetFormat, model }) {
  const providerResponse = new Response(upstreamBody, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const onStreamComplete = vi.fn();
  const streamController = createStreamController({ provider, model });
  const result = await handleStreamingResponse({
    providerResponse, provider, model, sourceFormat, targetFormat,
    userAgent: "test", body: { model }, stream: true,
    translatedBody: null, finalBody: null, requestStartTime: Date.now(),
    connectionId: "test-conn", apiKey: null, clientRawRequest: null,
    onRequestSuccess: null, reqLogger: null, toolNameMap: null,
    customToolNames: null, streamController, onStreamComplete,
    streamDetailId: "test", pxpipe: null, reqTag: "test", log: null,
    credentials: null,
  });
  const text = await result.response.text();
  return { text, onStreamComplete };
}

describe("protocol-stream-final-gaps", () => {
  describe("gap1: error before DONE, once, nothing after", () => {
    it("translate Responses->Chat: created then [DONE] emits error BEFORE [DONE], DONE once, nothing after", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
        "data: [DONE]\n\n",
      ];
      const output = await runStream(chunks, {
        mode: "translate", targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI, provider: "codex",
        model: "gpt-5-codex", onStreamComplete,
      });
      expect(output).toContain('"error"');
      expect(output).toContain("data: [DONE]");
      expect(output.match(/data: \[DONE\]/g)?.length).toBe(1);
      const errIdx = output.indexOf('"error"');
      const doneIdx = output.indexOf("data: [DONE]");
      expect(errIdx).toBeGreaterThanOrEqual(0);
      expect(errIdx).toBeLessThan(doneIdx);
      const after = output.slice(doneIdx + "data: [DONE]".length);
      expect(after.trim()).toBe("");
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("translate Chat->Responses: upstream Chat error then [DONE] emits response.failed BEFORE [DONE], DONE once", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"error":{"message":"boom","type":"server_error"}}\n\n',
        "data: [DONE]\n\n",
      ];
      const output = await runStream(chunks, {
        mode: "translate", targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI_RESPONSES, provider: "openai",
        model: "gpt-4o", onStreamComplete,
      });
      expect(output).toContain("response.failed");
      expect(output).toContain("data: [DONE]");
      expect(output.match(/data: \[DONE\]/g)?.length).toBe(1);
      const errIdx = output.indexOf("response.failed");
      const doneIdx = output.indexOf("data: [DONE]");
      expect(errIdx).toBeLessThan(doneIdx);
      const after = output.slice(doneIdx + "data: [DONE]".length);
      expect(after.trim()).toBe("");
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("Responses error source to Chat must be wire {error}, not success text/STOP", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"type":"server_error","message":"boom"}}}\n\n',
      ];
      const output = await runStream(chunks, {
        mode: "translate", targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI, provider: "codex",
        model: "gpt-5-codex", onStreamComplete,
      });
      expect(output).toContain('"error"');
      expect(output).not.toContain("[Error]");
      expect(output).not.toContain('"finish_reason":"stop"');
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  describe("gap2: real passthrough caller passes formats", () => {
    it("Claude same-format via handleStreamingResponse emits message_stop only, no [DONE]", async () => {
      const upstreamBody =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"x"}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      const { text, onStreamComplete } = await runHandleStreamingResponse({
        upstreamBody, provider: "anthropic", sourceFormat: FORMATS.CLAUDE,
        targetFormat: FORMATS.CLAUDE, model: "claude-3-5-sonnet",
      });
      expect(text).toContain("message_stop");
      expect(text).not.toContain("[DONE]");
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("Claude incomplete via handleStreamingResponse emits event:error, not Chat error, no [DONE]", async () => {
      const upstreamBody =
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n';
      const { text, onStreamComplete } = await runHandleStreamingResponse({
        upstreamBody, provider: "anthropic", sourceFormat: FORMATS.CLAUDE,
        targetFormat: FORMATS.CLAUDE, model: "claude-3-5-sonnet",
      });
      expect(text).toContain("event: error");
      expect(text.match(/event: error/g)?.length).toBe(1);
      expect(text).not.toContain("[DONE]");
      expect(text).not.toContain('"code":"stream_incomplete"');
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("Codex Responses created+[DONE] via handleStreamingResponse is failure, not success", async () => {
      const upstreamBody =
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n' +
        "data: [DONE]\n\n";
      const { text, onStreamComplete } = await runHandleStreamingResponse({
        upstreamBody, provider: "codex", sourceFormat: FORMATS.OPENAI_RESPONSES,
        targetFormat: FORMATS.OPENAI_RESPONSES, model: "gpt-5-codex",
      });
      expect(text).toContain("response.failed");
      expect(text).toContain("data: [DONE]");
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("createPassthroughStreamWithLogger passes explicit formats to the real wrapper (backwards compat provider inference)", async () => {
      const upstreamBody =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"x"}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      // Explicit Claude formats via the real wrapper: same-format passthrough,
      // so the stream ends at message_stop with no Chat [DONE].
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(upstreamBody));
          c.close();
        },
      });
      const passthrough = createPassthroughStreamWithLogger({
        provider: "anthropic", reqLogger: null, model: "claude-3-5-sonnet",
        connectionId: "test-conn", body: { model: "claude-3-5-sonnet" },
        onStreamComplete: vi.fn(), apiKey: null,
        sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.CLAUDE,
      });
      const reader = stream.pipeThrough(passthrough).getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      expect(text).toContain("message_stop");
      expect(text).not.toContain("[DONE]");
    });
  });

  describe("gap3: frame-local event state and tail separator", () => {
    it("stale event:error header must not poison next data-only success frame", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        "event: error\n\n",
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const output = await runStream(chunks, {
        mode: "translate", targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI, provider: "openai",
        model: "gpt-4o", onStreamComplete,
      });
      expect(output).not.toContain('"error"');
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("stale event:message_stop header must not mark incomplete data-only tail as success", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        "event: message_stop\n\n",
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      ];
      const output = await runStream(chunks, {
        mode: "translate", targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI, provider: "openai",
        model: "gpt-4o", onStreamComplete,
      });
      expect(output).toContain('"error"');
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("single-newline data tail gets blank separator before DONE", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
      ];
      const output = await runStream(chunks, {
        mode: "passthrough", provider: "openai",
        sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
        model: "gpt-4o", onStreamComplete,
      });
      expect(output).toContain("data: [DONE]");
      expect(output).toMatch(/\}\n\ndata: \[DONE\]/);
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("gap4: incomplete/failed mapping", () => {
    it("response.incomplete max_output_tokens via incomplete_details maps to length and keeps usage details", async () => {
      const { openaiResponsesToOpenAIResponse } = await import("../../open-sse/translator/response/openai-responses.js");
      const state = {
        started: true, chatId: "chatcmpl-1", created: 1, model: "gpt-5",
        toolCallIndex: 0, currentToolCallId: null, finishReasonSent: false,
      };
      const out = openaiResponsesToOpenAIResponse({
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: {
            input_tokens: 10, output_tokens: 20, total_tokens: 30,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens_details: { reasoning_tokens: 6 },
          },
        },
      }, state);
      expect(out).not.toBeNull();
      expect(out.choices?.[0]?.finish_reason).toBe("length");
      expect(out.usage?.prompt_tokens).toBe(10);
      expect(out.usage?.completion_tokens).toBe(20);
    });

    it("response.incomplete max_output_tokens wins over tool_calls (LENGTH first)", async () => {
      const { openaiResponsesToOpenAIResponse } = await import("../../open-sse/translator/response/openai-responses.js");
      const state = {
        started: true, chatId: "chatcmpl-1", created: 1, model: "gpt-5",
        toolCallIndex: 1, currentToolCallId: "call_1", finishReasonSent: false,
      };
      const out = openaiResponsesToOpenAIResponse({
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      }, state);
      expect(out?.choices?.[0]?.finish_reason).toBe("length");
    });

    it("response.done status failed must not emit success", async () => {
      const { openaiResponsesToOpenAIResponse } = await import("../../open-sse/translator/response/openai-responses.js");
      const state = {
        started: true, chatId: "chatcmpl-1", created: 1, model: "gpt-5",
        toolCallIndex: 0, currentToolCallId: null, finishReasonSent: false,
      };
      const out = openaiResponsesToOpenAIResponse({
        type: "response.done",
        response: { status: "failed", error: { message: "boom", type: "server_error" } },
      }, state);
      expect(out?.error).toBeDefined();
      expect(out?.choices?.[0]?.finish_reason).toBeFalsy();
    });

    it("response.failed+error duplicate to Claude emits exactly 1 wire error, no message_stop", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"type":"server_error","message":"boom"}}}\n\n',
        'event: error\ndata: {"type":"error","error":{"type":"server_error","message":"boom"}}\n\n',
      ];
      const output = await runStream(chunks, {
        mode: "translate", targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.CLAUDE, provider: "codex",
        model: "gpt-5-codex", onStreamComplete,
      });
      expect(output.match(/event: error/g)?.length).toBe(1);
      expect(output).not.toContain("message_stop");
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("translate Responses->Chat: Chat client receives data: [DONE] upon completion", async () => {
      const chunks = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
      ];
      const output = await runStream(chunks, {
        mode: "translate", targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI, provider: "codex",
        model: "gpt-5-codex",
      });
      expect(output).toContain("data: [DONE]");
      expect(output.match(/data: \[DONE\]/g)?.length).toBe(1);
    });

    it("translate to Responses: response.failed does not duplicate on flush", async () => {
      const chunks = [
        'data: {"error":{"message":"service down","type":"server_error"}}\n\n',
      ];
      const output = await runStream(chunks, {
        mode: "translate", targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI_RESPONSES, provider: "openai",
        model: "gpt-4o",
      });
      expect(output).toContain("response.failed");
      expect(output.match(/response\.failed/g)?.length).toBe(2); // 1 in event, 1 in type
      expect(output.match(/event: response\.failed/g)?.length).toBe(1);
    });

    it("passthrough Responses: response.failed terminal does not duplicate on flush", async () => {
      const chunks = [
        'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_err_1","status":"failed","error":{"type":"server_error","message":"quota_exceeded"}}}\n\n',
      ];
      const output = await runStream(chunks, {
        mode: "passthrough", targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI_RESPONSES, provider: "codex",
        model: "gpt-5-codex",
      });
      expect(output).toContain("response.failed");
      expect(output.match(/event: response\.failed/g)?.length).toBe(1);
      expect(output).toContain("data: [DONE]");
      expect(output.match(/data: \[DONE\]/g)?.length).toBe(1);
    });
  });
});
