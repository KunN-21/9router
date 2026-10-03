// B8b: chart route accepts all/default, rejects invalid, maps repository failure to 500.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ getChartData: vi.fn() }));
vi.mock("@/lib/usageDb", () => ({ getChartData: mocks.getChartData }));

const { GET } = await import("@/app/api/usage/chart/route.js");

const url = (qs) => new Request(`http://127.0.0.1:39129/api/usage/chart${qs}`);

beforeEach(() => {
  mocks.getChartData.mockReset();
});

describe("GET /api/usage/chart", () => {
  it("passes all through to repository and returns array envelope unchanged", async () => {
    mocks.getChartData.mockResolvedValue([{ label: "Oct 3", tokens: 5, cost: 0.1, requests: 2 }]);
    const response = await GET(url("?period=all"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ label: "Oct 3", tokens: 5, cost: 0.1, requests: 2 }]);
    expect(mocks.getChartData).toHaveBeenCalledWith("all");
  });

  it("defaults missing period to 7d", async () => {
    mocks.getChartData.mockResolvedValue([]);
    const response = await GET(url(""));
    expect(response.status).toBe(200);
    expect(mocks.getChartData).toHaveBeenCalledWith("7d");
  });

  it("rejects invalid period with 400 without calling repository", async () => {
    const response = await GET(url("?period=year"));
    expect(response.status).toBe(400);
    expect(mocks.getChartData).not.toHaveBeenCalled();
  });

  it("maps repository rejection to 500", async () => {
    mocks.getChartData.mockRejectedValue(new Error("db down"));
    const response = await GET(url("?period=7d"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch chart data" });
  });
});
