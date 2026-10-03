// B8b: chart-data aggregation semantics — requests counts + All Time civil-date gap fill.
// Mocks imported driver before usageRepo import. No initDb, no real DB.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ all: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({ all: mocks.all })),
}));

const { getChartData } = await import("@/lib/db/repos/usageRepo.js");

const FIXED_NOW = new Date(2026, 9, 3, 12, 0, 0);

function dateKeyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  mocks.all.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getChartData requests + all", () => {
  it("today branch counts one request per actual row (same hour, zero-token row) and filters out-of-day rows", async () => {
    const iso = (h, m) => new Date(2026, 9, 3, h, m, 0).toISOString();
    const outOfBoundsBefore = new Date(2026, 9, 2, 23, 59, 0).toISOString();
    const outOfBoundsAfter = new Date(2026, 9, 4, 0, 1, 0).toISOString();
    mocks.all.mockReturnValue([
      { timestamp: outOfBoundsBefore, promptTokens: 10, completionTokens: 10, cost: 1 },
      { timestamp: iso(1, 5), promptTokens: 5, completionTokens: 3, cost: 0.2 },
      { timestamp: iso(1, 40), promptTokens: 0, completionTokens: 0, cost: 0 },
      { timestamp: iso(2, 5), promptTokens: 4, completionTokens: 1, cost: 0.1 },
      { timestamp: outOfBoundsAfter, promptTokens: 10, completionTokens: 10, cost: 1 },
    ]);
    const buckets = await getChartData("today");
    expect(buckets.length).toBe(24);
    expect(buckets[1].requests).toBe(2);
    expect(buckets[1].tokens).toBe(8);
    expect(buckets[2].requests).toBe(1);
    const total = buckets.reduce((s, b) => s + b.requests, 0);
    expect(total).toBe(3);
  });

  it("24h branch aggregates rolling 24 hourly buckets and filters out-of-bounds rows", async () => {
    const nowMs = FIXED_NOW.getTime();
    const oneHour = 3600000;
    mocks.all.mockReturnValue([
      // row too old (> 24h ago)
      { timestamp: new Date(nowMs - 25 * oneHour).toISOString(), promptTokens: 10, completionTokens: 0, cost: 0.1 },
      // row in rolling window: 2 hours ago
      { timestamp: new Date(nowMs - 2 * oneHour + 1000).toISOString(), promptTokens: 6, completionTokens: 2, cost: 0.2 },
      // another row 2 hours ago
      { timestamp: new Date(nowMs - 2 * oneHour + 5000).toISOString(), promptTokens: 0, completionTokens: 0, cost: 0 },
      // row in future (> now)
      { timestamp: new Date(nowMs + 10000).toISOString(), promptTokens: 50, completionTokens: 50, cost: 5 },
    ]);
    const buckets = await getChartData("24h");
    expect(buckets.length).toBe(24);
    const totalRequests = buckets.reduce((s, b) => s + b.requests, 0);
    expect(totalRequests).toBe(2);
    // The bucket for ~2 hours ago should have requests = 2, tokens = 8
    const bucket2hAgo = buckets[22];
    expect(bucket2hAgo.requests).toBe(2);
    expect(bucket2hAgo.tokens).toBe(8);
  });

  it("finite branches (7d, 30d, 60d) return correct bucket count, ordering, and use dayData.requests", async () => {
    const today = new Date(2026, 9, 3);
    const key = dateKeyOf(today);
    mocks.all.mockReturnValue([
      { dateKey: key, data: JSON.stringify({ requests: 4, promptTokens: 10, completionTokens: 5, cost: 0.5 }) },
    ]);
    const b7 = await getChartData("7d");
    expect(b7.length).toBe(7);
    expect(b7[6]).toMatchObject({ requests: 4, tokens: 15, cost: 0.5 });
    expect(mocks.all.mock.calls[0][0]).toMatch(/ORDER BY dateKey ASC/);

    const b30 = await getChartData("30d");
    expect(b30.length).toBe(30);

    const b60 = await getChartData("60d");
    expect(b60.length).toBe(60);
  });

  it("all branch fills gaps with zero buckets in order, no future buckets", async () => {
    mocks.all.mockReturnValue([
      { dateKey: "2026-10-01", data: JSON.stringify({ requests: 7, promptTokens: 11, completionTokens: 2, cost: 0.3 }) },
      { dateKey: "2026-10-03", data: JSON.stringify({ requests: 2, promptTokens: 4, completionTokens: 1, cost: 0.1 }) },
    ]);
    const result = await getChartData("all");
    expect(result.map(({ requests, tokens }) => ({ requests, tokens }))).toEqual([
      { requests: 7, tokens: 13 },
      { requests: 0, tokens: 0 },
      { requests: 2, tokens: 5 },
    ]);
    expect(mocks.all.mock.calls[0][0]).toMatch(/ORDER BY dateKey ASC/);
  });

  it("all branch returns [] on empty history and spans month boundary", async () => {
    mocks.all.mockReturnValue([]);
    expect(await getChartData("all")).toEqual([]);
    mocks.all.mockReturnValue([
      { dateKey: "2026-09-30", data: JSON.stringify({ requests: 1, promptTokens: 2, completionTokens: 1, cost: 0.05 }) },
      { dateKey: "2026-10-01", data: JSON.stringify({ requests: 3, promptTokens: 6, completionTokens: 0, cost: 0.1 }) },
    ]);
    const result = await getChartData("all");
    expect(result.length).toBe(4);
    expect(result[0]).toMatchObject({ requests: 1, tokens: 3 });
    expect(result[3]).toMatchObject({ requests: 0, tokens: 0 });
  });

  it("all branch spans leap day", async () => {
    vi.setSystemTime(new Date(2024, 2, 2, 12, 0, 0));
    mocks.all.mockReturnValue([
      { dateKey: "2024-02-28", data: JSON.stringify({ requests: 1, promptTokens: 1, completionTokens: 0, cost: 0 }) },
      { dateKey: "2024-03-01", data: JSON.stringify({ requests: 2, promptTokens: 2, completionTokens: 0, cost: 0 }) },
    ]);
    const result = await getChartData("all");
    // Feb 28, Feb 29 (leap day gap), Mar 1, Mar 2 (today gap)
    expect(result.map((b) => b.requests)).toEqual([1, 0, 2, 0]);
  });

  it("all branch spans year boundary without duration drift", async () => {
    vi.setSystemTime(new Date(2026, 0, 2, 12, 0, 0));
    mocks.all.mockReturnValue([
      { dateKey: "2025-12-31", data: JSON.stringify({ requests: 5, promptTokens: 10, completionTokens: 0, cost: 0.5 }) },
      { dateKey: "2026-01-02", data: JSON.stringify({ requests: 3, promptTokens: 6, completionTokens: 0, cost: 0.3 }) },
    ]);
    const result = await getChartData("all");
    // Dec 31, Jan 1 (gap), Jan 2 (today)
    expect(result.length).toBe(3);
    expect(result[0].requests).toBe(5);
    expect(result[1].requests).toBe(0);
    expect(result[2].requests).toBe(3);
  });

  it("all branch returns single bucket for today-only record", async () => {
    mocks.all.mockReturnValue([
      { dateKey: "2026-10-03", data: JSON.stringify({ requests: 9, promptTokens: 20, completionTokens: 10, cost: 1.0 }) },
    ]);
    const result = await getChartData("all");
    expect(result.length).toBe(1);
    expect(result[0]).toMatchObject({ requests: 9, tokens: 30, cost: 1.0 });
  });

  it("all branch returns [] and does NOT emit future bucket when earliest > today (B8b-MAIN-05)", async () => {
    // Clock rollback scenario: today is 2026-10-03, but DB contains record for 2026-10-05
    mocks.all.mockReturnValue([
      { dateKey: "2026-10-05", data: JSON.stringify({ requests: 2, promptTokens: 4, completionTokens: 1, cost: 0.1 }) },
    ]);
    const result = await getChartData("all");
    // Must NOT emit a future bucket for Oct 5
    expect(result).toEqual([]);
  });
});
