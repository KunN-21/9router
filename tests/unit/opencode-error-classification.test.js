import { describe, it, expect, vi } from "vitest";
import {
  parseUpstreamError,
  buildErrorBody,
  createErrorResult,
  errorResponse,
} from "../../open-sse/utils/error.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

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

describe("OpenCode error classification", () => {
  it("parseUpstreamError preserves FreeTierError from upstream 403 JSON without leaking internal structures", async () => {
    const body = JSON.stringify({
      error: {
        type: "FreeTierError",
        message: "Free tier limit reached",
        internal_relay_ip: "10.0.0.123",
        proxy_url: "http://user:secret@10.0.0.1:8080",
      },
    });
    const response = new Response(body, {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });

    const parsed = await parseUpstreamError(response);
    expect(parsed.statusCode).toBe(403);
    expect(parsed.errorType).toBe("FreeTierError");
    expect(parsed.message).toBe("Free tier limit reached");
    expect(parsed.message).not.toContain("10.0.0.123");
    expect(parsed.message).not.toContain("secret");
  });

  it("parseUpstreamError preserves RegionError and exact upstream message", async () => {
    const body = JSON.stringify({
      error: {
        type: "RegionError",
        message: "Models hosted in China require workspace consent.",
      },
    });
    const response = new Response(body, {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });

    const parsed = await parseUpstreamError(response);
    expect(parsed.statusCode).toBe(403);
    expect(parsed.errorType).toBe("RegionError");
    expect(parsed.message).toBe("Models hosted in China require workspace consent.");
  });

  it("buildErrorBody maps FreeTierError to { type: 'permission_error', code: 'free_tier_restricted' }, not 'insufficient_quota'", () => {
    const errBody = buildErrorBody(403, "Free tier limit reached", "FreeTierError");
    expect(errBody.error.type).toBe("permission_error");
    expect(errBody.error.code).toBe("free_tier_restricted");
    expect(errBody.error.code).not.toBe("insufficient_quota");
    expect(errBody.error.message).toBe("Free tier limit reached");
    expect(errBody.error.upstream_type).toBe("FreeTierError");
  });

  it("createErrorResult and errorResponse forward errorType and errorCode cleanly to client Response", async () => {
    const result = createErrorResult(
      403,
      "Region restricted request",
      null,
      null,
      null,
      "RegionError",
      "region_restricted"
    );

    expect(result.status).toBe(403);
    expect(result.errorType).toBe("RegionError");
    expect(result.errorCode).toBe("region_restricted");

    const json = await result.response.json();
    expect(result.response.status).toBe(403);
    expect(json.error.type).toBe("permission_error");
    expect(json.error.code).toBe("region_restricted");
    expect(json.error.upstream_type).toBe("RegionError");
    expect(json.error.message).toBe("Region restricted request");
  });

  it("End-to-end handleChatCore returns HTTP 403 with preserved FreeTierError and exact upstream message", async () => {
    const upstreamBody = JSON.stringify({
      error: {
        type: "FreeTierError",
        message: "Streaming is required on the free tier.",
      },
    });
    executeMock.mockResolvedValueOnce({
      response: new Response(upstreamBody, {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
      url: "https://opencode.ai/zen/v1/chat/completions",
    });

    const result = await handleChatCore({
      body: {
        model: "opencode/muse-spark-1.2-contributor-free",
        messages: [{ role: "user", content: "Hi" }],
      },
      modelInfo: {
        provider: "opencode",
        model: "muse-spark-1.2-contributor-free",
      },
      credentials: {},
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(403);

    const clientJson = await result.response.json();
    expect(result.response.status).toBe(403);
    expect(clientJson.error.type).toBe("permission_error");
    expect(clientJson.error.code).toBe("free_tier_restricted");
    expect(clientJson.error.code).not.toBe("insufficient_quota");
    expect(clientJson.error.upstream_type).toBe("FreeTierError");
    expect(clientJson.error.message).toContain("Streaming is required on the free tier.");
  });
  it("parseUpstreamError preserves custom executor diagnostic message over generic upstream JSON message", async () => {
    const mockExecutor = {
      parseError: (res, bodyText) => ({
        status: 403,
        message: "Custom executor diagnostic: account trial blocked",
        resetsAtMs: 1728900000000,
      }),
    };
    const response = new Response(
      JSON.stringify({ error: { message: "raw generic upstream error" } }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );

    const parsed = await parseUpstreamError(response, mockExecutor);
    expect(parsed.statusCode).toBe(403);
    expect(parsed.message).toBe("Custom executor diagnostic: account trial blocked");
    expect(parsed.resetsAtMs).toBe(1728900000000);
  });

  it("parseUpstreamError falls through to JSON parsing when executor returns default BaseExecutor bodyText", async () => {
    const body = JSON.stringify({
      error: {
        type: "FreeTierError",
        message: "Streaming is required on the free tier.",
      },
    });
    const baseExecutor = {
      parseError: (res, bodyText) => ({
        status: res.status,
        message: bodyText,
      }),
    };
    const response = new Response(body, {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });

    const parsed = await parseUpstreamError(response, baseExecutor);
    expect(parsed.statusCode).toBe(403);
    expect(parsed.errorType).toBe("FreeTierError");
    expect(parsed.message).toBe("Streaming is required on the free tier.");
  });

  it("buildErrorBody preserves frozen preOpenCode non-target known403 semantics with upstream arbitrary type and code", () => {
    const errBody = buildErrorBody(403, "Access denied", "arbitrary_upstream_type", "arbitrary_upstream_code");
    expect(errBody.error.type).toBe("permission_error");
    expect(errBody.error.code).toBe("insufficient_quota");
    expect(errBody.error.upstream_type).toBeUndefined();
    expect(errBody.error.message).toBe("Access denied");
  });

  it("buildErrorBody does not resolve prototype properties as OpenCode policy keys", () => {
    const errBody = buildErrorBody(403, "Forbidden", "toString", null);
    expect(errBody.error.type).toBe("permission_error");
    expect(errBody.error.code).toBe("insufficient_quota");
    expect(errBody.error.upstream_type).toBeUndefined();
  });

  it("End-to-end handleChatCore keeps non-target arbitrary 403 upstream errors as standard permission_error without type leak", async () => {
    const upstreamBody = JSON.stringify({
      error: {
        type: "ArbitraryVendorError",
        code: "arbitrary_vendor_code",
        message: "Payment method required for model access.",
      },
    });
    executeMock.mockResolvedValueOnce({
      response: new Response(upstreamBody, {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
      url: "https://api.openai.com/v1/chat/completions",
    });

    const result = await handleChatCore({
      body: {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      },
      modelInfo: {
        provider: "openai",
        model: "gpt-4o",
      },
      credentials: {},
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(403);

    const clientJson = await result.response.json();
    expect(result.response.status).toBe(403);
    expect(clientJson.error.type).toBe("permission_error");
    expect(clientJson.error.code).toBe("insufficient_quota");
    expect(clientJson.error.upstream_type).toBeUndefined();
    expect(clientJson.error.message).toContain("Payment method required for model access.");
  });
});
