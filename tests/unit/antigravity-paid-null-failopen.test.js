import { describe, expect, it, vi, beforeEach } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

const MODELS_5H = {
  "gemini-3.7-flash-high": {
    displayName: "Gemini 3.7 Flash (High)",
    quotaInfo: { remainingFraction: 0.85, resetTime: "2026-09-04T00:00:00Z" },
  },
  "claude-sonnet-4-6": {
    displayName: "Claude Sonnet 4.6",
    quotaInfo: { remainingFraction: 0.5, resetTime: "2026-09-04T00:00:00Z" },
  },
};

const WEEKLY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          remainingFraction: 0.9,
          resetTime: "2026-09-10T15:50:40Z",
        },
      ],
    },
  ],
};

function mockMain(subscriptionJson, models = MODELS_5H, weeklyJson = WEEKLY) {
  proxyAwareFetch.mockImplementation(async (url) => {
    if (url.includes(":loadCodeAssist")) {
      if (subscriptionJson === null || subscriptionJson === undefined) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => subscriptionJson };
    }
    if (url.includes(":fetchAvailableModels")) {
      return { ok: true, status: 200, json: async () => ({ models }) };
    }
    if (url.includes(":retrieveUserQuotaSummary")) {
      if (!weeklyJson) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => weeklyJson };
    }
    return { ok: false, status: 404 };
  });
}

describe("Antigravity paid-null fail-open (no free borrow on unknown tier)", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
  });

  it("subscription null + valid data.models => full 5h quotas, plan Unknown", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    mockMain(null);

    const usage = await getAntigravityUsage("probe-token", {});

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Unknown");
    expect(usage.quotas["gemini-3.7-flash-high"]).toMatchObject({
      used: 150,
      total: 1000,
      remainingPercentage: 85,
    });
    expect(usage.quotas["claude-sonnet-4-6"]).toMatchObject({
      used: 500,
      total: 1000,
      remainingPercentage: 50,
    });
  });

  it("explicit free-tier still skips 5h models, weekly only", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    mockMain({
      cloudaicompanionProject: "p1",
      currentTier: { name: "Starter" },
      paidTier: { id: "free-tier", name: "Antigravity Starter Quota" },
    });

    const usage = await getAntigravityUsage("probe-token", {});

    expect(usage.message).toBeUndefined();
    expect(usage.quotas["gemini-3.7-flash-high"]).toBeUndefined();
    expect(usage.quotas["claude-sonnet-4-6"]).toBeUndefined();
    expect(usage.quotas["gemini_weekly"]).toBeDefined();
  });

  it("absent paidTier with project parses 5h (unknown tier fail-open)", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    mockMain({ cloudaicompanionProject: "p1", currentTier: { name: "Pro" } });

    const usage = await getAntigravityUsage("probe-token", {});

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Pro");
    expect(usage.quotas["gemini-3.7-flash-high"]).toBeDefined();
    expect(usage.quotas["gemini_weekly"]).toBeDefined();
  });

  it("future paid tier id parses 5h", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    mockMain({
      cloudaicompanionProject: "p1",
      currentTier: { name: "Ultra" },
      paidTier: { id: "g9-ultra-tier", name: "Google AI Ultra" },
    });

    const usage = await getAntigravityUsage("probe-token", {});

    expect(usage.message).toBeUndefined();
    expect(usage.quotas["gemini-3.7-flash-high"]).toBeDefined();
  });

  it("401 quota response bypasses tier gate with message + empty quotas", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    proxyAwareFetch.mockImplementation(async (url) => {
      if (url.includes(":loadCodeAssist")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            cloudaicompanionProject: "p1",
            currentTier: { name: "Pro" },
            paidTier: { id: "g1-pro-tier" },
          }),
        };
      }
      if (url.includes(":fetchAvailableModels")) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return { ok: false, status: 404 };
    });

    const usage = await getAntigravityUsage("probe-token", {});

    expect(usage.message).toMatch(/authentication expired/);
    expect(usage.quotas).toEqual({});
  });

  it("403 quota response bypasses tier gate with message + empty quotas", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    proxyAwareFetch.mockImplementation(async (url) => {
      if (url.includes(":loadCodeAssist")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            cloudaicompanionProject: "p1",
            currentTier: { name: "Pro" },
            paidTier: { id: "g1-pro-tier" },
          }),
        };
      }
      if (url.includes(":fetchAvailableModels")) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      return { ok: false, status: 404 };
    });

    const usage = await getAntigravityUsage("probe-token", {});

    expect(usage.message).toMatch(/forbidden/);
    expect(usage.quotas).toEqual({});
  });

  it.each([null, undefined, ""])("paidTier %p parses 5h, no falsy-skip", async (tierId) => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    mockMain({
      cloudaicompanionProject: "p1",
      currentTier: { name: "Pro" },
      paidTier: tierId == null ? tierId : { id: tierId },
    });

    const usage = await getAntigravityUsage("probe-token", {});

    expect(usage.message).toBeUndefined();
    expect(usage.quotas["gemini-3.7-flash-high"]).toBeDefined();
    expect(usage.quotas["claude-sonnet-4-6"]).toBeDefined();
  });
});
