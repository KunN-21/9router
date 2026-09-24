import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createSSEStream } = await import("../../open-sse/utils/stream.js");

// Helper to run chunks through createSSEStream and collect SSE output
async function runStream(chunks, streamOptions) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
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

describe("protocol-stream-missing-terminal: Incomplete upstream detection and terminal enforcement", () => {
  describe("Upstream Chat/OpenAI incomplete (missing terminal)", () => {
    it("Client OpenAI receives error frame + [DONE] exactly once when upstream ends without finish_reason or [DONE]", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"incomplete text"}}]}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      // Must emit error frame
      expect(output).toContain('"error"');
      // Must emit [DONE]
      expect(output).toContain("data: [DONE]");
      // [DONE] must appear exactly once
      const doneMatches = output.match(/data: \[DONE\]/g);
      expect(doneMatches?.length).toBe(1);
      // Callback success must NOT be called with fake success
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("Client Claude receives event: error exactly once (and no [DONE]) when upstream ends without terminal", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"partial content"}}]}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.CLAUDE,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      // Must emit event: error
      expect(output).toContain("event: error");
      const errorMatches = output.match(/event: error/g);
      expect(errorMatches?.length).toBe(1);
      // Claude clients must NOT receive [DONE]
      expect(output).not.toContain("[DONE]");
      // Must not report fake success
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  describe("Upstream Claude incomplete (missing message_stop / stop_reason)", () => {
    it("Client OpenAI receives error frame + [DONE] exactly once when Claude upstream ends without message_stop", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello world"}}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.OPENAI,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        onStreamComplete,
      });

      expect(output).toContain('"error"');
      expect(output).toContain("data: [DONE]");
      const doneMatches = output.match(/data: \[DONE\]/g);
      expect(doneMatches?.length).toBe(1);
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("Client Claude receives event: error exactly once when Claude upstream ends without message_stop", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"truncated"}}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.CLAUDE,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        onStreamComplete,
      });

      expect(output).toContain("event: error");
      const errorMatches = output.match(/event: error/g);
      expect(errorMatches?.length).toBe(1);
      expect(output).not.toContain("[DONE]");
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  describe("Upstream Gemini incomplete (missing finishReason)", () => {
    it("Client OpenAI receives error frame + [DONE] exactly once when Gemini upstream ends without finishReason", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"gemini partial"}]}}]}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.GEMINI,
        sourceFormat: FORMATS.OPENAI,
        provider: "gemini",
        model: "gemini-2.0-flash",
        onStreamComplete,
      });

      expect(output).toContain('"error"');
      expect(output).toContain("data: [DONE]");
      const doneMatches = output.match(/data: \[DONE\]/g);
      expect(doneMatches?.length).toBe(1);
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("Client Gemini/Antigravity does NOT receive [DONE], and incomplete stream does not report fake success", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"gemini incomplete"}]}}]}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.GEMINI,
        sourceFormat: FORMATS.ANTIGRAVITY,
        provider: "antigravity",
        model: "gemini-2.0-flash",
        onStreamComplete,
      });

      // Must never force [DONE] for Gemini/Antigravity
      expect(output).not.toContain("[DONE]");
      // Candidate in output must NOT claim finishReason when upstream didn't have it
      expect(output).not.toContain('"finishReason"');
      // Must not report fake success
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  describe("Responses API passthrough incomplete (preserves existing response.failed)", () => {
    it("Responses passthrough emits response.failed + [DONE] when terminal event is missing", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        model: "gpt-5-codex",
        onStreamComplete,
      });

      expect(output).toContain("event: response.failed");
      expect(output).toContain('"status":"failed"');
      expect(output).toContain("data: [DONE]");
      const doneMatches = output.match(/data: \[DONE\]/g);
      expect(doneMatches?.length).toBe(1);
    });
  });

  describe("Valid terminal streams must succeed and not emit error", () => {
    it("Valid complete Chat/OpenAI stream emits [DONE] exactly once and calls onStreamComplete", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"complete"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      expect(output).not.toContain('"error"');
      expect(output).toContain("data: [DONE]");
      const doneMatches = output.match(/data: \[DONE\]/g);
      expect(doneMatches?.length).toBe(1);
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("Valid complete Claude stream emits message_stop and calls onStreamComplete", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.CLAUDE,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        onStreamComplete,
      });

      expect(output).not.toContain("event: error");
      expect(output).toContain("event: message_stop");
      expect(output).not.toContain("[DONE]");
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("Valid complete Gemini stream with finishReason: STOP translates finishReason and calls onStreamComplete", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.GEMINI,
        sourceFormat: FORMATS.OPENAI,
        provider: "gemini",
        model: "gemini-2.0-flash",
        onStreamComplete,
      });

      expect(output).not.toContain('"error"');
      expect(output).toContain('"finish_reason":"stop"');
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("Valid stream ending with data: [DONE] sentinel without finish_reason succeeds and calls onStreamComplete", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"hello done sentinel"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      expect(output).not.toContain('"error"');
      expect(output).toContain("data: [DONE]");
      const doneMatches = output.match(/data: \[DONE\]/g);
      expect(doneMatches?.length).toBe(1);
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("CRLF and chunk boundary handling", () => {
    it("handles CRLF line endings without failing terminal detection", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"crlf test"},"finish_reason":null}]}\r\n\r\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      expect(output).not.toContain('"error"');
      expect(output).toContain("data: [DONE]");
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("handles final event without trailing newline without failing terminal detection", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"no trailing newline"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      expect(output).not.toContain('"error"');
      expect(output).toContain("data: [DONE]");
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("handles multi-byte UTF-8 split across chunks in incomplete stream", async () => {
      const onStreamComplete = vi.fn();
      const encoder = new TextEncoder();
      const fullText = 'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Xin chào thế giới"}}]}\n\n';
      const encoded = encoder.encode(fullText);
      // Split right in the middle of a multi-byte character
      const mid = Math.floor(encoded.length / 2);
      const chunk1 = encoded.slice(0, mid);
      const chunk2 = encoded.slice(mid);

      const output = await runStream([chunk1, chunk2], {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      expect(output).toContain('"error"');
      expect(output).toContain("data: [DONE]");
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  describe("Upstream error terminal handling", () => {
    it("Upstream OpenAI error terminal emits error and does not report fake success", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      expect(output).toContain('"error"');
      expect(output).toContain("Rate limit exceeded");
      expect(output).toContain("data: [DONE]");
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  describe("Responses API incomplete streams", () => {
    it("Responses-to-Claude incomplete stream emits event: error and no message_stop or fake success", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"hello from codex"}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.CLAUDE,
        provider: "codex",
        model: "gpt-5-codex",
        onStreamComplete,
      });

      expect(output).toContain("event: error");
      const errorMatches = output.match(/event: error/g);
      expect(errorMatches?.length).toBe(1);
      expect(output).not.toContain("event: message_stop");
      expect(output).not.toContain("[DONE]");
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });
});
