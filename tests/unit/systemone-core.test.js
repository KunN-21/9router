import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  generateSessionId: vi.fn(() => "test-session-12345"),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("open-sse/executors/opencode-zen.js", () => ({
  generateSessionId: mocks.generateSessionId,
}));

import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import { PROVIDER_MEDIA } from "open-sse/providers/index.js";

describe("System One Core Handler (systemoneCore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 if provider does not support System One", async () => {
    const result = await handleSystemoneCore({
      body: { state: "test", questions: { q: { type: "boolean" } } },
      modelInfo: { provider: "unsupported-provider", model: "m1" },
      credentials: {},
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support System One");
  });

  it("returns 400 if state is missing", async () => {
    const result = await handleSystemoneCore({
      body: { questions: { q: { type: "boolean" } } },
      modelInfo: { provider: "opencode", model: "jev-1.13-free" },
      credentials: {},
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Missing required field: state");
  });

  it("returns 400 if questions is missing or invalid", async () => {
    const result = await handleSystemoneCore({
      body: { state: "valid-state" },
      modelInfo: { provider: "opencode", model: "jev-1.13-free" },
      credentials: {},
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Missing required field: questions");
  });

  it("sends request with headers, body, session id, and proxy options", async () => {
    const fakeResponse = new Response(JSON.stringify({
      model: "jev-1.13",
      answers: { is_urgent: { type: "noul", noul: 0.99 } },
      usage: { input_tokens: 312, output_tokens: 48 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    mocks.proxyAwareFetch.mockResolvedValue(fakeResponse);

    const onRequestSuccess = vi.fn();
    const result = await handleSystemoneCore({
      body: { state: "Situation description", questions: { is_urgent: { type: "noul" } } },
      modelInfo: { provider: "opencode", model: "jev-1.13-free" },
      credentials: {
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://127.0.0.1:8080",
        },
      },
      onRequestSuccess,
    });

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalled();
    expect(result.usage).toEqual({ prompt_tokens: 312, completion_tokens: 48 });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/v1/systemone",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "Authorization": "Bearer public",
          "x-opencode-session": "test-session-12345",
          "x-opencode-client": "desktop",
        }),
        body: JSON.stringify({
          state: "Situation description",
          questions: { is_urgent: { type: "noul" } },
          model: "jev-1.13-free",
        }),
      }),
      expect.objectContaining({
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://127.0.0.1:8080",
      })
    );
  });

  it("handles upstream error response", async () => {
    const errorResponse = new Response(JSON.stringify({
      error: { message: "Internal engine fault", code: "engine_error" },
    }), { status: 500, statusText: "Internal Server Error" });

    mocks.proxyAwareFetch.mockResolvedValue(errorResponse);

    const result = await handleSystemoneCore({
      body: { state: "Situation", questions: { q: { type: "boolean" } } },
      modelInfo: { provider: "opencode", model: "jev-1.13-free" },
      credentials: {},
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain("Internal engine fault");
  });

  it("handles client abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    mocks.proxyAwareFetch.mockRejectedValue(new Error("The user aborted a request."));

    const result = await handleSystemoneCore({
      body: { state: "Situation", questions: { q: { type: "boolean" } } },
      modelInfo: { provider: "opencode", model: "jev-1.13-free" },
      credentials: {},
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(result.error).toContain("Request aborted");
  });

  it("handles upstream timeout", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";

    mocks.proxyAwareFetch.mockRejectedValue(timeoutErr);

    const result = await handleSystemoneCore({
      body: { state: "Situation", questions: { q: { type: "boolean" } } },
      modelInfo: { provider: "opencode", model: "jev-1.13-free" },
      credentials: {},
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toContain("Upstream connection timeout");
  });
});
