import { describe, it, expect, vi } from "vitest";
import {
  parseUpstreamError,
  buildErrorBody,
  createErrorResult,
} from "../../open-sse/utils/error.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (mimeType, base64) => `data:${mimeType};base64,${base64}`,
  parseDataUri: (url) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    return m ? { mimeType: m[1], base64: m[2] } : null;
  },
}));

describe("OpenCode policy errors contract", () => {
  const opencodeExecutor = new OpenCodeExecutor();

  it("actual OpenCode executor parse chain extracts DataPolicyError as data_policy_restricted", async () => {
    const body = JSON.stringify({
      error: {
        type: "DataPolicyError",
        message: "Data policy consent required for training data.",
      },
    });
    const upstream = new Response(body, {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });

    const parsed = await parseUpstreamError(upstream, opencodeExecutor);
    expect(parsed.statusCode).toBe(403);
    expect(parsed.errorType).toBe("DataPolicyError");
    expect(parsed.message).toBe("Data policy consent required for training data.");

    const errBody = buildErrorBody(parsed.statusCode, parsed.message, parsed.errorType, parsed.errorCode);
    expect(errBody.error.type).toBe("permission_error");
    expect(errBody.error.code).toBe("data_policy_restricted");
    expect(errBody.error.upstream_type).toBe("DataPolicyError");
  });

  it("non-OpenCode standard 403 error preserves insufficient_quota without policy rewrite", () => {
    const errBody = buildErrorBody(403, "You exceeded your current quota");
    expect(errBody.error.type).toBe("permission_error");
    expect(errBody.error.code).toBe("insufficient_quota");
    expect(errBody.error.upstream_type).toBeUndefined();
  });

  it("handleChatCore preserves status 403 and policy identifier for OpenAI client format", async () => {
    executeMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          error: {
            type: "RegionError",
            message: "Models hosted in China require workspace consent.",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      ),
      url: "https://opencode.ai/zen/v1/chat/completions",
    });

    const result = await handleChatCore({
      body: {
        model: "opencode/muse-spark-1.2-contributor-free",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
      modelInfo: {
        provider: "opencode",
        model: "muse-spark-1.2-contributor-free",
      },
      credentials: {},
    });

    expect(result.status).toBe(403);
    const json = await result.response.json();
    expect(json.error.type).toBe("permission_error");
    expect(json.error.code).toBe("region_restricted");
    expect(json.error.upstream_type).toBe("RegionError");
    expect(json.error.message).toContain("Models hosted in China require workspace consent.");
  });

  it("configured mixed combo RegionError advances only before accepted content", async () => {
    const body = { messages: [{ role: "user", content: "Test combo" }] };
    const models = [
      "opencode/muse-spark-1.2-contributor-free",
      "openai/gpt-4o",
    ];

    const regionErr = Response.json(
      {
        error: {
          message: "RegionError: Region not allowed",
          type: "permission_error",
          code: "region_restricted",
        },
      },
      { status: 403 }
    );

    const gpt4oSuccess = Response.json(
      { choices: [{ message: { content: "Answer from second provider" } }] },
      { status: 200 }
    );

    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(regionErr)
      .mockResolvedValueOnce(gpt4oSuccess);

    const result = await handleComboChat({
      body,
      models,
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "mixed-policy-combo",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result).toBe(gpt4oSuccess);
  });
});
