import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const ME_URL = "https://ollama.com/api/me";
const BALANCE_URL = "https://ollama.com/api/balance";
const PROXY = { proxyPoolId: "pool-fixture" };
const BALANCE = {
  included: {
    allowance_usd: 20,
    balance_usd: 15,
    session: { remaining_percent: 80, resets_at: "2026-10-11T12:00:00Z" },
    weekly: { remaining_percent: 40, resets_at: "2026-10-18T00:00:00Z" },
    period: { until: "2026-11-01T00:00:00Z" },
  },
  purchased: { balance_usd: 50 },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function usage(body) {
  proxyAwareFetch
    .mockResolvedValueOnce(jsonResponse(body))
    .mockResolvedValueOnce(jsonResponse({ Plan: "max" }));
  return getUsageForProvider(
    { provider: "ollama", apiKey: "k", providerSpecificData: {} },
    PROXY,
  );
}

describe("ollama registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("ollama");
    expect(USAGE_APIKEY_PROVIDERS).toContain("ollama");
  });
});

describe("getUsageForProvider(ollama)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports no limits when no known window is present", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ activity: {}, limits: {} }))
      .mockResolvedValueOnce(jsonResponse({ Plan: "free" }));

    const usageResult = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usageResult.message).toMatch(/no usage limits/i);
    expect(usageResult.quotas).toEqual({});
  });

  it("surfaces invalid key message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, 401),
    );

    const usageResult = await getUsageForProvider({
      provider: "ollama",
      apiKey: "bad",
    });

    expect(usageResult.message).toMatch(/invalid/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("returns message when apiKey missing", async () => {
    const usageResult = await getUsageForProvider({
      provider: "ollama",
      providerSpecificData: {},
    });

    expect(usageResult.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("parseQuotaData(ollama)", () => {
  it("forwards remainingPercentage for dashboard bars", () => {
    const rows = parseQuotaData("ollama", {
      plan: "Max",
      quotas: {
        "Session (5h)": {
          used: 0,
          total: 100,
          remainingPercentage: 100,
          resetAt: null,
        },
        "Weekly (7d)": {
          used: 100,
          total: 100,
          remainingPercentage: 0,
          resetAt: null,
        },
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Session (5h)",
      used: 0,
      total: 100,
      remainingPercentage: 100,
    });
    expect(rows[1]).toMatchObject({
      name: "Weekly (7d)",
      used: 100,
      total: 100,
      remainingPercentage: 0,
    });
  });
});

describe("ollama /api/balance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GETs /api/balance and forwards proxyOptions to both calls", async () => {
    await usage(BALANCE);
    const [balanceUrl, balanceOpts, balanceProxy] = proxyAwareFetch.mock.calls[0];
    expect(balanceUrl).toBe(BALANCE_URL);
    expect(balanceOpts.headers.Authorization).toBe("Bearer k");
    expect(balanceProxy).toBe(PROXY);
    const [meUrl, meOpts, meProxy] = proxyAwareFetch.mock.calls[1];
    expect(meUrl).toBe(ME_URL);
    expect(meOpts.method).toBe("POST");
    expect(meProxy).toBe(PROXY);
  });

  it("builds Monthly, Session, Weekly and Purchased (USD) rows", async () => {
    const res = await usage(BALANCE);
    expect(res.plan).toBe("Max");
    expect(res.quotas.Monthly).toMatchObject({
      used: 25,
      total: 100,
      remainingPercentage: 75,
      unlimited: false,
      resetAt: "2026-11-01T00:00:00.000Z",
    });
    expect(res.quotas["Session (5h)"]).toMatchObject({
      used: 20,
      remainingPercentage: 80,
      resetAt: "2026-10-11T12:00:00.000Z",
    });
    expect(res.quotas["Weekly (7d)"]).toMatchObject({
      used: 60,
      remainingPercentage: 40,
      resetAt: "2026-10-18T00:00:00.000Z",
    });
    expect(res.quotas["Purchased (USD)"]).toEqual({
      used: 0,
      total: 50,
      resetAt: null,
      isCreditBalance: true,
      currency: "USD",
    });
    const purchased = res.quotas["Purchased (USD)"];
    expect([purchased.remainingPercentage, purchased.unlimited]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("ignores legacy limits and never invents a spent-down monthly quota", async () => {
    const res = await usage({
      included: { allowance_usd: 20 },
      limits: { session: { usage: 0 } },
    });
    expect(res.quotas).toEqual({});
    expect(res.message).toMatch(/no usage limits/i);
  });

  it("forwards isCreditBalance and currency to the dashboard", () => {
    const rows = parseQuotaData("ollama", {
      quotas: {
        "Purchased (USD)": {
          used: 0,
          total: 50,
          isCreditBalance: true,
          currency: "USD",
        },
      },
    });
    expect(rows[0]).toMatchObject({
      name: "Purchased (USD)",
      isCreditBalance: true,
      currency: "USD",
    });
  });

  it("does not invent a monthly quota when balance_usd is missing", async () => {
    const res = await usage({
      included: {
        allowance_usd: 20,
        session: { remaining_percent: 80, resets_at: "2026-10-11T12:00:00Z" },
      },
    });
    expect(res.quotas.Monthly).toBeUndefined();
    expect(res.quotas["Session (5h)"]).toMatchObject({
      used: 20,
      remainingPercentage: 80,
    });
  });

  it("drops a window whose remaining_percent is not a finite number", async () => {
    const missing = await usage({
      included: {
        session: { remaining_percent: null },
        weekly: { remaining_percent: 40 },
      },
    });
    expect(missing.quotas["Session (5h)"]).toBeUndefined();
    expect(missing.quotas["Weekly (7d)"]).toMatchObject({
      used: 60,
      remainingPercentage: 40,
    });
  });

  it("drops numbers that arrive as strings or booleans", async () => {
    const asString = await usage({
      included: {
        allowance_usd: "20",
        balance_usd: 15,
        session: { remaining_percent: "80", resets_at: "2026-10-11T12:00:00Z" },
        weekly: { remaining_percent: 40 },
      },
      purchased: { balance_usd: true },
    });
    expect(asString.quotas).toEqual({
      "Weekly (7d)": {
        used: 60,
        total: 100,
        remainingPercentage: 40,
        resetAt: null,
        unlimited: false,
      },
    });
    const asBool = await usage({
      included: {
        allowance_usd: true,
        balance_usd: 15,
        session: { remaining_percent: false },
      },
      purchased: { balance_usd: 1 },
    });
    expect(asBool.quotas).toEqual({
      "Purchased (USD)": {
        used: 0,
        total: 1,
        resetAt: null,
        isCreditBalance: true,
        currency: "USD",
      },
    });
  });

  it("keeps quotas when the /api/me plan call fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(BALANCE))
      .mockRejectedValueOnce(new Error("me down"));
    const res = await getUsageForProvider(
      { provider: "ollama", apiKey: "k", providerSpecificData: {} },
      PROXY,
    );
    expect(res.plan).toBe("Ollama Cloud");
    expect(res.quotas.Monthly).toMatchObject({
      used: 25,
      total: 100,
      remainingPercentage: 75,
    });
    expect(res.quotas["Session (5h)"]).toMatchObject({
      used: 20,
      remainingPercentage: 80,
    });
  });

  it("keeps Accept, Content-Length and plan controls on the new endpoints", async () => {
    const res = await usage(BALANCE);
    const [, balanceOpts] = proxyAwareFetch.mock.calls[0];
    const [, meOpts] = proxyAwareFetch.mock.calls[1];
    expect(balanceOpts.headers.Accept).toBe("application/json");
    expect(meOpts.headers.Authorization).toBe("Bearer k");
    expect(meOpts.headers["Content-Length"]).toBe("0");
    expect(res.message).toBeUndefined();
    expect(res.plan).toBe("Max");
  });

  it("treats explicit zero and empty/nonfinite fields without inventing quota", async () => {
    const zeroPurchased = await usage({
      included: {
        allowance_usd: 20,
        balance_usd: 15,
        period: { until: "2026-11-01T00:00:00Z" },
      },
      purchased: { balance_usd: 0 },
    });
    expect(zeroPurchased.quotas["Purchased (USD)"]).toBeUndefined();
    expect(zeroPurchased.quotas.Monthly).toMatchObject({
      used: 25,
      total: 100,
      remainingPercentage: 75,
    });
    const zeroBalance = await usage({
      included: {
        allowance_usd: 20,
        balance_usd: 0,
        period: { until: "2026-11-01T00:00:00Z" },
      },
    });
    expect(zeroBalance.quotas.Monthly).toMatchObject({
      used: 100,
      total: 100,
      remainingPercentage: 0,
    });
    const junk = await usage({
      included: {
        allowance_usd: null,
        balance_usd: 15,
        session: { remaining_percent: [80] },
        weekly: { remaining_percent: {} },
        period: {},
      },
      purchased: { balance_usd: "" },
    });
    expect(junk.quotas).toEqual({});
    expect(junk.message).toMatch(/no usage limits/i);
  });

  it("never derives monthly reset from signup date when period is missing or invalid", async () => {
    const missing = await usage({
      included: {
        allowance_usd: 20,
        balance_usd: 15,
        session: { remaining_percent: 80, resets_at: "2026-10-11T12:00:00Z" },
      },
    });
    expect(missing.quotas.Monthly.resetAt).toBeNull();
    expect(missing.quotas["Session (5h)"]).toMatchObject({
      used: 20,
      remainingPercentage: 80,
    });
    const invalid = await usage({
      included: {
        allowance_usd: 20,
        balance_usd: 15,
        period: { until: "not-a-date" },
      },
    });
    expect(invalid.quotas.Monthly.resetAt).toBeNull();
  });
});
