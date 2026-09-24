import { describe, expect, it, vi, beforeEach } from "vitest";

const { pipeMock } = vi.hoisted(() => ({ pipeMock: vi.fn() }));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
  pipeWithDisconnect: pipeMock,
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((d) => d),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(() => ""),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleStreamingResponse } = await import(
  "../../open-sse/handlers/chatCore/streamingHandler.js"
);
const { FORMATS } = await import("../../open-sse/translator/formats.js");

function sseResponse() {
  return new Response("data: {\"ok\":true}\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function baseArgs(sourceFormat, targetFormat) {
  return {
    providerResponse: sseResponse(),
    provider: "openai",
    model: "gpt-4o",
    sourceFormat,
    targetFormat,
    userAgent: "test",
    body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    stream: true,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "policy-test",
    apiKey: "sk-test",
    clientRawRequest: null,
    onRequestSuccess: null,
    reqLogger: null,
    toolNameMap: null,
    customToolNames: null,
    streamController: { handleError: vi.fn() },
    onStreamComplete: vi.fn(),
    streamDetailId: "policy-1",
    pxpipe: null,
    reqTag: "",
    log: null,
    credentials: null,
  };
}

describe("clientStallTimeout depends on sourceFormat only", () => {
  beforeEach(() => pipeMock.mockClear());

  it("arms client stall for claude source", async () => {
    await handleStreamingResponse(baseArgs(FORMATS.CLAUDE, FORMATS.OPENAI));
    expect(pipeMock.mock.calls[0][5]).toBeGreaterThan(0);
  });

  it("does NOT arm client stall for openai source with claude target", async () => {
    await handleStreamingResponse(baseArgs(FORMATS.OPENAI, FORMATS.CLAUDE));
    expect(pipeMock.mock.calls[0][5]).toBeNull();
  });

  it("does NOT arm client stall for openai-responses source with claude target", async () => {
    await handleStreamingResponse(baseArgs(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE));
    expect(pipeMock.mock.calls[0][5]).toBeNull();
  });
});
