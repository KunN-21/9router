import { describe, expect, it, vi, beforeEach } from "vitest";

const appendRequestLogSpy = vi.fn(async () => {});
const saveRequestDetailSpy = vi.fn(async () => {});
const saveRequestUsageSpy = vi.fn(async () => {});
const trackPendingRequestSpy = vi.fn();

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: (...args) => appendRequestLogSpy(...args),
  saveRequestDetail: (...args) => saveRequestDetailSpy(...args),
  saveRequestUsage: (...args) => saveRequestUsageSpy(...args),
  trackPendingRequest: (...args) => trackPendingRequestSpy(...args),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createSSEStream } = await import("../../open-sse/utils/stream.js");

// Standard-compliant SSE frame parser that respects blank-line delimiters (\n\n)
// and handles multi-line data concatenation per W3C SSE specification.
function parseSSEFrames(rawSSE) {
  const normalized = rawSSE.replace(/\r\n/g, "\n");
  const rawFrames = normalized.split(/\n\n+/);
  const events = [];

  for (const rawFrame of rawFrames) {
    const trimmed = rawFrame.trim();
    if (!trimmed) continue;

    let eventType = null;
    let id = null;
    const dataLines = [];

    const lines = rawFrame.split("\n");
    for (const line of lines) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed || lineTrimmed.startsWith(":")) continue;
      if (lineTrimmed.startsWith("event:")) {
        eventType = lineTrimmed.slice(6).trim();
      } else if (lineTrimmed.startsWith("data:")) {
        dataLines.push(lineTrimmed.slice(5).trim());
      } else if (lineTrimmed.startsWith("id:")) {
        id = lineTrimmed.slice(3).trim();
      }
    }

    if (dataLines.length > 0 || eventType !== null) {
      const rawData = dataLines.join("\n");
      let parsedData = null;
      let jsonParseError = null;
      if (rawData === "[DONE]") {
        parsedData = "[DONE]";
      } else if (rawData) {
        try {
          parsedData = JSON.parse(rawData);
        } catch (e) {
          jsonParseError = e.message;
        }
      }
      events.push({
        event: eventType,
        id,
        data: parsedData,
        rawData,
        rawFrame,
        dataLineCount: dataLines.length,
        jsonParseError,
      });
    }
  }

  return events;
}

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

describe("protocol-stream-terminal-integration: Stream Terminal Integration and Protocol Invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Upstream response.incomplete handling", () => {
    it("1.1 OPENAI_RESPONSES -> CLAUDE: response.incomplete must NOT emit event: error after message_stop", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_inc_1","status":"incomplete","status_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":100,"output_tokens":500}}}\n\n'
      ];

      const rawOutput = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.CLAUDE,
        provider: "openai",
        model: "gpt-5-codex",
        onStreamComplete,
      });

      const frames = parseSSEFrames(rawOutput);

      // Must have message_delta with stop_reason max_tokens
      const deltaFrame = frames.find((f) => f.data?.type === "message_delta");
      expect(deltaFrame).toBeDefined();
      expect(deltaFrame.data.delta?.stop_reason).toBe("max_tokens");

      // Must have message_stop
      const stopFrame = frames.find((f) => f.data?.type === "message_stop");
      expect(stopFrame).toBeDefined();

      // MUST NOT emit event: error frame after or alongside message_stop
      const errorFrame = frames.find((f) => f.event === "error" || f.data?.type === "error");
      expect(errorFrame).toBeUndefined();
    });

    it("1.2 OPENAI_RESPONSES -> CLAUDE: response.incomplete without trailing newline must NOT emit event: error", async () => {
      const onStreamComplete = vi.fn();
      // No trailing newline before stream close
      const chunks = [
        'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_inc_2","status":"incomplete","status_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":80,"output_tokens":400}}}'
      ];

      const rawOutput = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.CLAUDE,
        provider: "openai",
        model: "gpt-5-codex",
        onStreamComplete,
      });

      const frames = parseSSEFrames(rawOutput);
      const errorFrame = frames.find((f) => f.event === "error" || f.data?.type === "error");
      expect(errorFrame).toBeUndefined();
    });

    it("1.3 OPENAI_RESPONSES -> OPENAI_RESPONSES (same-format): response.incomplete must NOT emit response.failed", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_inc_3","status":"incomplete","status_details":{"reason":"max_output_tokens"}}}\n\n'
      ];

      const rawOutput = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        model: "gpt-5-codex",
        onStreamComplete,
      });

      const frames = parseSSEFrames(rawOutput);

      // Must NOT synthesize response.failed for a valid incomplete cutoff
      const failedFrame = frames.find((f) => f.event === "response.failed" || f.data?.type === "response.failed");
      expect(failedFrame).toBeUndefined();
    });
  });

  describe("2. Sticky failure violation: [DONE] after error must not report success", () => {
    it("2.1 Passthrough mode: error followed by [DONE] must NOT report success in callback or appendRequestLog", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n',
        'data: [DONE]\n\n'
      ];

      await runStream(chunks, {
        mode: "passthrough",
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      // Sticky failure: callback must NOT be called with success
      expect(onStreamComplete).not.toHaveBeenCalled();

      // appendRequestLog must NOT be called with status: "200 OK"
      const okCall = appendRequestLogSpy.mock.calls.find((call) => call[0]?.status === "200 OK");
      expect(okCall).toBeUndefined();
    });

    it("2.2 Translate mode (OPENAI -> OPENAI): error followed by [DONE] must NOT report success", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"error":{"message":"quota_exceeded","type":"insufficient_quota"}}\n\n',
        'data: [DONE]\n\n'
      ];

      await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      expect(onStreamComplete).not.toHaveBeenCalled();
      const okCall = appendRequestLogSpy.mock.calls.find((call) => call[0]?.status === "200 OK");
      expect(okCall).toBeUndefined();
    });

    it("2.3 Same-format Responses: response.failed followed by [DONE] must NOT report success", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_fail_1","status":"failed","error":{"message":"internal server error"}}}\n\n',
        'data: [DONE]\n\n'
      ];

      await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        model: "gpt-5-codex",
        onStreamComplete,
      });

      expect(onStreamComplete).not.toHaveBeenCalled();
      const okCall = appendRequestLogSpy.mock.calls.find((call) => call[0]?.status === "200 OK");
      expect(okCall).toBeUndefined();
    });
  });

  describe("3. Premature [DONE] after response.created (missing terminal event)", () => {
    it("3.1 Same-format Responses: response.created then [DONE] must NOT report success in callback or logs", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_premature_1","status":"in_progress"}}\n\n',
        'data: [DONE]\n\n'
      ];

      const rawOutput = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        model: "gpt-5-codex",
        onStreamComplete,
      });

      const frames = parseSSEFrames(rawOutput);
      // It synthesizes response.failed on wire
      const failedFrame = frames.find((f) => f.event === "response.failed" || f.data?.type === "response.failed");
      expect(failedFrame).toBeDefined();

      // But callback and logs must NOT report 200 OK / success!
      expect(onStreamComplete).not.toHaveBeenCalled();
      const okCall = appendRequestLogSpy.mock.calls.find((call) => call[0]?.status === "200 OK");
      expect(okCall).toBeUndefined();
    });

    it("3.2 OPENAI_RESPONSES -> CLAUDE: response.created then [DONE] must emit event: error and NOT report success", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_premature_2","status":"in_progress"}}\n\n',
        'data: [DONE]\n\n'
      ];

      const rawOutput = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.CLAUDE,
        provider: "openai",
        model: "gpt-5-codex",
        onStreamComplete,
      });

      const frames = parseSSEFrames(rawOutput);

      // Claude client MUST receive event: error because upstream terminated prematurely
      const errorFrame = frames.find((f) => f.event === "error" || f.data?.type === "error");
      expect(errorFrame).toBeDefined();

      // Must not report success
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  describe("4. Upstream error to Claude client: wire error contract", () => {
    it("4.1 OPENAI_RESPONSES -> CLAUDE: response.failed must emit event: error, NOT text delta with end_turn", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_fail_3","status":"failed","error":{"message":"Context window exceeded","type":"invalid_request_error"}}}\n\n'
      ];

      const rawOutput = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.CLAUDE,
        provider: "openai",
        model: "gpt-5-codex",
        onStreamComplete,
      });

      const frames = parseSSEFrames(rawOutput);

      // Must emit event: error on wire
      const errorFrame = frames.find((f) => f.event === "error" || f.data?.type === "error");
      expect(errorFrame).toBeDefined();

      // Must NOT convert error into text_delta '[Error] ...' with stop_reason end_turn
      const textDelta = frames.find((f) => f.data?.delta?.type === "text_delta" && f.data?.delta?.text?.startsWith("[Error]"));
      expect(textDelta).toBeUndefined();

      const endTurnDelta = frames.find((f) => f.data?.delta?.stop_reason === "end_turn");
      expect(endTurnDelta).toBeUndefined();
    });

    it("4.2 OPENAI -> CLAUDE: upstream { error } chunk must emit event: error on wire", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"error":{"message":"Invalid API key","type":"authentication_error"}}\n\n'
      ];

      const rawOutput = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.CLAUDE,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      const frames = parseSSEFrames(rawOutput);

      // Claude client MUST receive event: error
      const errorFrame = frames.find((f) => f.event === "error" || f.data?.type === "error");
      expect(errorFrame).toBeDefined();
    });
  });

  describe("5. Chat target to OPENAI_RESPONSES client: missing terminal event contract", () => {
    it("5.1 OPENAI -> OPENAI_RESPONSES: incomplete stream must emit event: response.failed, NOT Chat error format", async () => {
      const onStreamComplete = vi.fn();
      const chunks = [
        'data: {"id":"chatcmpl-inc-1","choices":[{"index":0,"delta":{"content":"partial content"}}]}\n\n'
      ];

      const rawOutput = await runStream(chunks, {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      const frames = parseSSEFrames(rawOutput);

      // Responses client MUST receive event: response.failed
      const failedFrame = frames.find((f) => f.event === "response.failed" || f.data?.type === "response.failed");
      expect(failedFrame).toBeDefined();

      // MUST NOT emit raw Chat completion error format (data: {"error":...})
      const chatErrorFrame = frames.find((f) => f.event === null && f.data?.error && f.data?.type !== "response.failed");
      expect(chatErrorFrame).toBeUndefined();
    });
  });

  describe("6. Tail passthrough data JSON without newline merging with data: [DONE]", () => {
    it("6.1 Passthrough mode: finish chunk without trailing newline must NOT merge with [DONE] into invalid JSON", async () => {
      const onStreamComplete = vi.fn();
      // Chunk 2 has NO trailing newline before EOF
      const chunks = [
        'data: {"id":"chatcmpl-tail-1","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
        'data: {"id":"chatcmpl-tail-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
      ];

      const rawOutput = await runStream(chunks, {
        mode: "passthrough",
        provider: "openai",
        model: "gpt-4o",
        onStreamComplete,
      });

      const frames = parseSSEFrames(rawOutput);

      // Verify no frames failed JSON parsing due to merged lines
      const corruptedFrames = frames.filter((f) => f.jsonParseError !== null);
      expect(corruptedFrames.length).toBe(0);

      // Verify each frame has exactly 1 data line (no merged data lines)
      const mergedFrames = frames.filter((f) => f.dataLineCount > 1);
      expect(mergedFrames.length).toBe(0);

      // Verify [DONE] is in its own separate frame
      const doneFrame = frames.find((f) => f.rawData === "[DONE]");
      expect(doneFrame).toBeDefined();
    });
  });
});
