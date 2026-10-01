import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  handleSystemoneCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  saveRequestUsage: vi.fn().mockResolvedValue(undefined),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
}));

vi.mock("open-sse/handlers/systemoneCore.js", () => ({
  handleSystemoneCore: mocks.handleSystemoneCore,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: mocks.appendRequestLog,
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn((k) => (k ? k.slice(0, 4) + "***" : "none")),
}));

import { handleSystemone } from "@/sse/handlers/systemone.js";
import { OPTIONS, POST } from "@/app/api/v1/systemone/route.js";

describe("System One (Jev) Route & Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractApiKey.mockReturnValue(null);
    mocks.isValidApiKey.mockResolvedValue(false);
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getModelInfo.mockImplementation(async (modelStr) => {
      if (modelStr === "jev-1.13" || modelStr === "opencode/jev-1.13-free") {
        return { provider: "opencode", model: "jev-1.13-free" };
      }
      if (modelStr === "openrouter/typesafe/jev-1.13") {
        return { provider: "openrouter", model: "typesafe/jev-1.13" };
      }
      if (modelStr.startsWith("unsupported/")) {
        return { provider: "unsupported", model: "some-model" };
      }
      return { provider: null, model: null };
    });
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1",
      connectionName: "OpenCode Account 1",
      apiKey: "sk-provider-1",
      accessToken: "token-1",
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_p, c) => c);
    mocks.handleSystemoneCore.mockImplementation(async ({ onRequestSuccess }) => {
      if (onRequestSuccess) await onRequestSuccess();
      return {
        success: true,
        usage: { prompt_tokens: 150, completion_tokens: 30 },
        response: new Response(JSON.stringify({
          model: "jev-1.13",
          answers: { is_urgent: { type: "noul", noul: 0.95 } },
          usage: { input_tokens: 150, output_tokens: 30 },
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      };
    });
  });

  describe("CORS preflight & Route exports", () => {
    it("handles OPTIONS preflight request with CORS headers", async () => {
      const res = await OPTIONS();
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    });

    it("POST delegates to handleSystemone", async () => {
      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "User order stuck in processing",
          questions: { urgent: { type: "boolean" } },
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.model).toBe("jev-1.13");
    });
  });

  describe("Trust Boundary & Input Validation", () => {
    it("returns 400 for invalid JSON body", async () => {
      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json",
      });
      const res = await handleSystemone(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toContain("Invalid JSON body");
    });

    it("returns 400 for non-object JSON body", async () => {
      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not an object"]),
      });
      const res = await handleSystemone(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toContain("Invalid JSON body");
    });

    it("returns 400 when model is missing or empty", async () => {
      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "hello", questions: {} }),
      });
      const res = await handleSystemone(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toContain("Missing model");
    });

    it("returns 400 when state is missing", async () => {
      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-1.13", questions: {} }),
      });
      const res = await handleSystemone(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toContain("Missing required field: state");
    });

    it("returns 400 when questions is missing or not an object", async () => {
      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-1.13", state: "hello" }),
      });
      const res = await handleSystemone(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toContain("Missing required field: questions");
    });

    it("returns 400 when questions is an array", async () => {
      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-1.13", state: "hello", questions: ["q1"] }),
      });
      const res = await handleSystemone(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toContain("Missing required field: questions");
    });

    it("returns 400 when model format is unrecognized", async () => {
      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nonexistent-model-xyz", state: "hello", questions: {} }),
      });
      const res = await handleSystemone(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toContain("Invalid model format");
    });
  });

  describe("API Key Policy & Parity", () => {
    it("allows local requests without API key when requireApiKey is false", async () => {
      mocks.getSettings.mockResolvedValue({ requireApiKey: false });
      mocks.extractApiKey.mockReturnValue(null);

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "Test situation",
          questions: { urgent: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(200);
      expect(mocks.isValidApiKey).not.toHaveBeenCalled();
      expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
        apiKey: null,
        provider: "opencode",
        model: "jev-1.13-free",
        status: "success",
      }));
    });

    it("allows supplied key in local mode when requireApiKey is false and logs usage with key", async () => {
      mocks.getSettings.mockResolvedValue({ requireApiKey: false });
      mocks.extractApiKey.mockReturnValue("sk-unregistered-local");

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer sk-unregistered-local" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "Test situation",
          questions: { urgent: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(200);
      expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
        apiKey: "sk-unregistered-local",
        provider: "opencode",
        status: "success",
      }));
    });

    it("returns 401 when requireApiKey is true and key is missing", async () => {
      mocks.getSettings.mockResolvedValue({ requireApiKey: true });
      mocks.extractApiKey.mockReturnValue(null);

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "Test situation",
          questions: { urgent: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.message).toBe("Missing API key");
    });

    it("returns 401 when requireApiKey is true and key is invalid", async () => {
      mocks.getSettings.mockResolvedValue({ requireApiKey: true });
      mocks.extractApiKey.mockReturnValue("sk-invalid");
      mocks.isValidApiKey.mockResolvedValue(false);

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "Test situation",
          questions: { urgent: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.message).toBe("Invalid API key");
      expect(mocks.isValidApiKey).toHaveBeenCalledWith("sk-invalid");
    });

    it("succeeds when requireApiKey is true and key is valid", async () => {
      mocks.getSettings.mockResolvedValue({ requireApiKey: true });
      mocks.extractApiKey.mockReturnValue("sk-valid");
      mocks.isValidApiKey.mockResolvedValue(true);

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "Test situation",
          questions: { urgent: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(200);
      expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
        apiKey: "sk-valid",
      }));
    });
  });

  describe("Account Rotation & Fallback", () => {
    it("falls back to second account on 429 rate limit", async () => {
      mocks.getProviderCredentials
        .mockResolvedValueOnce({
          connectionId: "conn-1",
          connectionName: "Account 1",
          apiKey: "key-1",
        })
        .mockResolvedValueOnce({
          connectionId: "conn-2",
          connectionName: "Account 2",
          apiKey: "key-2",
        });

      mocks.handleSystemoneCore
        .mockResolvedValueOnce({
          success: false,
          status: 429,
          error: "Rate limit reached on account 1",
          response: new Response(JSON.stringify({ error: "rate limit" }), { status: 429 }),
        })
        .mockImplementationOnce(async ({ onRequestSuccess }) => {
          if (onRequestSuccess) await onRequestSuccess();
          return {
            success: true,
            usage: { prompt_tokens: 100, completion_tokens: 20 },
            response: new Response(JSON.stringify({
              model: "jev-1.13",
              answers: { ok: true },
            }), { status: 200 }),
          };
        });

      mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "Fall back test",
          questions: { ok: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(200);
      expect(mocks.markAccountUnavailable).toHaveBeenCalledWith("conn-1", 429, "Rate limit reached on account 1", "opencode", "jev-1.13-free");
      expect(mocks.clearAccountError).toHaveBeenCalledWith("conn-2", expect.objectContaining({ connectionId: "conn-2" }), "jev-1.13-free");
    });

    it("returns unavailableResponse when all accounts are rate-limited", async () => {
      mocks.getProviderCredentials.mockResolvedValue({
        allRateLimited: true,
        lastError: "Quota exceeded",
        lastErrorCode: 429,
        retryAfter: "2026-10-01T14:00:00.000Z",
        retryAfterHuman: "15 minutes",
      });

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "All rate limited",
          questions: { q: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
    });

    it("returns 400 when no provider credentials exist", async () => {
      mocks.getProviderCredentials.mockResolvedValue(null);

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "No credentials",
          questions: { q: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toContain("No credentials for provider: opencode");
    });
  });

  describe("Abort Signal & Timeout Handling", () => {
    it("aborts before connection when request.signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "Already aborted",
          questions: { q: { type: "boolean" } },
        }),
        signal: controller.signal,
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(499);
      expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
      expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    });

    it("stops immediately on status 499 without marking account unavailable", async () => {
      mocks.handleSystemoneCore.mockResolvedValue({
        success: false,
        status: 499,
        error: "Request aborted",
        response: new Response(JSON.stringify({ error: "Request aborted" }), { status: 499 }),
      });

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "Abort during fetch",
          questions: { q: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(499);
      expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
      expect(mocks.appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({
        status: "FAILED 499",
      }));
    });
  });

  describe("Usage Tracking & Hit Counter", () => {
    it("saves usage tokens on successful response", async () => {
      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "Usage tracking",
          questions: { q: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(200);
      expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
        provider: "opencode",
        model: "jev-1.13-free",
        connectionId: "conn-1",
        apiKey: null,
        endpoint: "/v1/systemone",
        tokens: {
          prompt_tokens: 150,
          completion_tokens: 30,
          total_tokens: 180,
        },
        status: "success",
      });
    });

    it("records usage hit counter even when upstream returns no usage tokens", async () => {
      mocks.handleSystemoneCore.mockResolvedValue({
        success: true,
        usage: null,
        response: new Response(JSON.stringify({ model: "jev-1.13", answers: {} }), { status: 200 }),
      });

      const req = new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13",
          state: "No tokens",
          questions: { q: { type: "boolean" } },
        }),
      });

      const res = await handleSystemone(req);
      expect(res.status).toBe(200);
      expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
        provider: "opencode",
        model: "jev-1.13-free",
        connectionId: "conn-1",
        apiKey: null,
        endpoint: "/v1/systemone",
        tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        status: "success",
      });
    });
  });
});
