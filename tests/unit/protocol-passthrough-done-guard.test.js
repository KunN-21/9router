import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const { createSSEStream, createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");

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

describe("protocol-passthrough-done-guard: Passthrough [DONE] guard and incomplete stream handling", () => {
  describe("Guards against duplicate [DONE] in passthrough mode", () => {
    it("emits [DONE] exactly once when upstream already sent data: [DONE]", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "passthrough",
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      expect(output).toContain("data: [DONE]");
      const doneMatches = output.match(/data: \[DONE\]/g);
      expect(doneMatches?.length).toBe(1);
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("emits [DONE] exactly once when upstream sent data: [DONE] with CRLF", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"hello"}}]}\r\n\r\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n'
      ];

      const output = await runStream(chunks, {
        mode: "passthrough",
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      expect(output).toContain("data: [DONE]");
      const doneMatches = output.match(/data: \[DONE\]/g);
      expect(doneMatches?.length).toBe(1);
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("Gemini-family passthrough [DONE] suppression", () => {
    it("never emits [DONE] for provider antigravity", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "passthrough",
        provider: "antigravity",
        model: "gemini-2.0-flash",
        onStreamComplete,
      });

      expect(output).not.toContain("[DONE]");
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("never emits [DONE] for provider gemini", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "passthrough",
        provider: "gemini",
        model: "gemini-2.0-flash",
        onStreamComplete,
      });

      expect(output).not.toContain("[DONE]");
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("never emits [DONE] for provider vertex", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "passthrough",
        provider: "vertex",
        model: "gemini-2.0-flash",
        onStreamComplete,
      });

      expect(output).not.toContain("[DONE]");
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("Incomplete passthrough stream handling", () => {
    it("incomplete OpenAI passthrough emits error frame + [DONE] and does not report fake success", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"partial passthrough"}}]}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "passthrough",
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      // Must emit error frame
      expect(output).toContain('"error"');
      // Must emit [DONE] exactly once
      expect(output).toContain("data: [DONE]");
      const doneMatches = output.match(/data: \[DONE\]/g);
      expect(doneMatches?.length).toBe(1);
      // Callback success must NOT be called
      expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it("incomplete Gemini-family passthrough does not emit [DONE] and does not report fake success", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'
      ];

      const output = await runStream(chunks, {
        mode: "passthrough",
        provider: "gemini",
        model: "gemini-2.0-flash",
        onStreamComplete,
      });

      expect(output).not.toContain("[DONE]");
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });
});
