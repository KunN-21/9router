import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveRequestUsage: vi.fn(),
  clearAccountError: vi.fn(),
  markAccountUnavailable: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({
    accessToken: "synthetic-token-xyz",
    connectionId: "conn-synthetic-42",
    connectionName: "Codex Synthetic",
  }),
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: (req) => req.headers.get("x-api-key") || "synthetic-client-key",
  isValidApiKey: async () => true,
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "codex", model: "gpt-5.6-sol-image" }),
  getComboModels: async () => null,
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));

vi.mock("../../open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(),
}));

import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";

describe("Upstream 0.5.99 image accounting end-to-end verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.clearAccountError.mockResolvedValue(undefined);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streaming: persists exact usage with all fields and calls callbacks exactly once on success", async () => {
    const sseBody = [
      'event: response.image_generation_call.partial_image\n',
      'data: {"partial_image_b64":"cGFydGlhbF8x","partial_image_index":0}\n\n',
      'event: response.output_item.done\n',
      'data: {"item":{"type":"image_generation_call","result":"final_image_base64"}}\n\n',
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":500,"output_tokens":1200,"total_tokens":1700,"input_tokens_details":{"cached_tokens":150},"output_tokens_details":{"reasoning_tokens":75}}}}\n\n',
    ].join("");

    const fetchMock = vi.fn().mockResolvedValue(new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost:20128/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "X-Api-Key": "my-client-key",
      },
      body: JSON.stringify({
        model: "cx/gpt-5.6-sol-image",
        prompt: "A beautiful mountain sunset",
      }),
    });

    const res = await handleImageGeneration(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: partial_image");
    expect(text).toContain("event: done");
    expect(text).toContain('"b64_json":"final_image_base64"');

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-5.6-sol-image",
      connectionId: "conn-synthetic-42",
      apiKey: "my-client-key",
      endpoint: "/v1/images/generations",
      tokens: {
        prompt_tokens: 500,
        completion_tokens: 1200,
        total_tokens: 1700,
        cached_tokens: 150,
        reasoning_tokens: 75,
      },
      status: "success",
    });
    expect(mocks.clearAccountError).toHaveBeenCalledTimes(1);
  });

  it("streaming: refusal/no-image with actual usage records accounting with error status instead of silently discarding", async () => {
    const sseBody = [
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":350,"output_tokens":0,"total_tokens":350}}}\n\n',
    ].join("");

    const fetchMock = vi.fn().mockResolvedValue(new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost:20128/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "X-Api-Key": "billed-client-key",
      },
      body: JSON.stringify({
        model: "cx/gpt-5.6-sol-image",
        prompt: "Refused prompt violating policy",
      }),
    });

    const res = await handleImageGeneration(req);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("Codex did not return an image");

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-5.6-sol-image",
      connectionId: "conn-synthetic-42",
      apiKey: "billed-client-key",
      endpoint: "/v1/images/generations",
      tokens: {
        prompt_tokens: 350,
        completion_tokens: 0,
        total_tokens: 350,
      },
      status: "error",
    });
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
  });

  it("json: refusal/no-image with actual usage records accounting with error status before failing", async () => {
    const sseBody = [
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":420,"output_tokens":10,"total_tokens":430}}}\n\n',
    ].join("");

    const fetchMock = vi.fn().mockResolvedValue(new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost:20128/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": "json-client-key",
      },
      body: JSON.stringify({
        model: "cx/gpt-5.6-sol-image",
        prompt: "Refused prompt in JSON mode",
      }),
    });

    const res = await handleImageGeneration(req);
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-5.6-sol-image",
      connectionId: "conn-synthetic-42",
      apiKey: "json-client-key",
      endpoint: "/v1/images/generations",
      tokens: {
        prompt_tokens: 420,
        completion_tokens: 10,
        total_tokens: 430,
      },
      status: "error",
    });
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
  });

  it("same-frame: extracts image and usage when response.completed delivers both metadata and image output", async () => {
    const sseBody = [
      'event: response.completed\n',
      'data: {"response":{"output":[{"type":"image_generation_call","result":"same_frame_image_b64"}],"usage":{"input_tokens":100,"output_tokens":200,"total_tokens":300}}}\n\n',
    ].join("");

    const fetchMock = vi.fn().mockResolvedValue(new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost:20128/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cx/gpt-5.6-sol-image",
        prompt: "Same frame test",
      }),
    });

    const res = await handleImageGeneration(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].b64_json).toBe("same_frame_image_b64");

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-5.6-sol-image",
      connectionId: "conn-synthetic-42",
      apiKey: "synthetic-client-key",
      endpoint: "/v1/images/generations",
      tokens: {
        prompt_tokens: 100,
        completion_tokens: 200,
        total_tokens: 300,
      },
      status: "success",
    });
    expect(mocks.clearAccountError).toHaveBeenCalledTimes(1);
  });

  it("zero valid usage: persists valid 0 token usage without error", async () => {
    const sseBody = [
      'event: response.output_item.done\n',
      'data: {"item":{"type":"image_generation_call","result":"zero_usage_b64"}}\n\n',
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n',
    ].join("");

    const fetchMock = vi.fn().mockResolvedValue(new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost:20128/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cx/gpt-5.6-sol-image",
        prompt: "Zero usage test",
      }),
    });

    const res = await handleImageGeneration(req);
    expect(res.status).toBe(200);

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      tokens: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      status: "success",
    }));
  });

  it("missing numeric fields: does not fabricate usage or persist when tokens are invalid", async () => {
    const sseBody = [
      'event: response.output_item.done\n',
      'data: {"item":{"type":"image_generation_call","result":"valid_b64"}}\n\n',
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":"not-a-number","output_tokens":-10}}}\n\n',
    ].join("");

    const fetchMock = vi.fn().mockResolvedValue(new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost:20128/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cx/gpt-5.6-sol-image",
        prompt: "Invalid numeric fields test",
      }),
    });

    const res = await handleImageGeneration(req);
    expect(res.status).toBe(200);
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("error upstream: HTTP 500 error does not persist fabricated usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost:20128/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cx/gpt-5.6-sol-image",
        prompt: "Server failure test",
      }),
    });

    const res = await handleImageGeneration(req);
    expect(res.status).toBe(500);
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });
});
