import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/bypassResponse.js", () => ({
  createNonStreamingResponse: vi.fn((sourceFormat, model, text) => ({
    kind: "json",
    sourceFormat,
    model,
    text,
  })),
  createStreamingResponse: vi.fn((sourceFormat, model, text) => ({
    kind: "sse",
    sourceFormat,
    model,
    text,
  })),
}));

const detectFormatMock = vi.fn(() => "openai");
vi.mock("../../open-sse/services/provider.js", () => ({
  detectFormat: (...args) => detectFormatMock(...args),
}));

const { handlePonytailCommands } = await import("../../open-sse/utils/tokenSaverBridge.js");
const { createNonStreamingResponse, createStreamingResponse } = await import("../../open-sse/utils/bypassResponse.js");

describe("handlePonytailCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectFormatMock.mockReturnValue("openai");
  });

  it("uses caller-provided sourceFormatOverride and streamOverride", async () => {
    const result = await handlePonytailCommands(
      { messages: [{ role: "user", content: "/ponytail-help" }], stream: true },
      "demo-model",
      {
        helpText: "HELP",
        sourceFormatOverride: "claude",
        streamOverride: false,
      },
    );

    expect(createNonStreamingResponse).toHaveBeenCalledWith("claude", "demo-model", "HELP");
    expect(createStreamingResponse).not.toHaveBeenCalled();
    expect(result.kind).toBe("json");
  });

  it.each(["assistant", "tool"])("does not replay historical commands after %s", async (role) => {
    const result = await handlePonytailCommands({ messages: [
      { role: "user", content: "/ponytail-help" },
      { role, content: "continue" },
    ] }, "demo-model");
    expect(result).toBeNull();
  });

  it("does not load global usage for gain", () => {
    const result = handlePonytailCommands({ stream: false, messages: [{ role: "user", content: "/ponytail-gain" }] }, "demo-model");
    expect(result.text).toMatch(/dashboard/i);
  });

  it("requires explicit stream:true; absent stream answers JSON", () => {
    detectFormatMock.mockReturnValue("gemini");

    const streamed = handlePonytailCommands(
      { messages: [{ role: "user", content: "/ponytail-help" }], stream: true },
      "demo-model",
      { helpText: "HELP" },
    );
    const nonStreamed = handlePonytailCommands(
      { messages: [{ role: "user", content: "/ponytail-help" }] },
      "demo-model",
      { helpText: "HELP" },
    );

    expect(createStreamingResponse).toHaveBeenCalledWith("gemini", "demo-model", "HELP");
    expect(streamed.kind).toBe("sse");
    expect(nonStreamed.kind).toBe("json");
  });
});
