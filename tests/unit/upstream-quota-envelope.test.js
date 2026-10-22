import { describe, expect, it } from "vitest";
import { parseUpstreamError } from "open-sse/utils/error.js";

function res(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseUpstreamError quota envelope", () => {
  it("reads retryAfter and cap from a FreeUsageLimitError 429", async () => {
    const before = Date.now();
    const parsed = await parseUpstreamError(res(429, {
      type: "error",
      error: { type: "RateLimit.FreeUsageLimitError", message: "free usage limit" },
      retryAfter: 3600,
      cap: { reason: "requests", scope: "shared", limit: 200, usage: 200 },
    }));
    expect(parsed.statusCode).toBe(429);
    expect(parsed.errorType).toBe("RateLimit.FreeUsageLimitError");
    expect(parsed.cap).toEqual({ reason: "requests", scope: "shared", limit: 200, usage: 200 });
    // retryAfter is relative seconds; convert to an absolute epoch for cooldowns.
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it("keeps a model-scoped cap distinguishable from a shared one", async () => {
    const parsed = await parseUpstreamError(res(429, {
      error: { type: "RateLimit.FreeUsageLimitError", message: "cap" },
      retryAfter: 60,
      cap: { reason: "spend", scope: "model", limit: 5, usage: 5 },
    }));
    expect(parsed.cap.scope).toBe("model");
    expect(parsed.cap.reason).toBe("spend");
  });

  it("ignores a malformed cap instead of inventing one", async () => {
    const parsed = await parseUpstreamError(res(429, {
      error: { type: "RateLimit.Exceeded", message: "slow down" },
    }));
    expect(parsed.cap).toBeUndefined();
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("does not shift resetsAtMs when retryAfter is absent", async () => {
    const parsed = await parseUpstreamError(res(500, {
      error: { type: "server_error", message: "boom" },
    }));
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});
