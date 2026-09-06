/**
 * PR #3813 regression: sequential background refresh, bounded env config,
 * no trailing sleep, lazy projectId (RAM-only invalidate, stored ID kept).
 * All network/persistence mocked; sleeps injected, fake timers for onboard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetProjectId,
  mockInvalidate,
  mockUpdateConn,
  mockRefreshProviderCreds,
} = vi.hoisted(() => ({
  mockGetProjectId: vi.fn(async () => "pid-new"),
  mockInvalidate: vi.fn(),
  mockUpdateConn: vi.fn(async () => true),
  mockRefreshProviderCreds: vi.fn(async () => ({ accessToken: "new-acc", expiresIn: 3600 })),
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: mockGetProjectId,
  invalidateProjectId: mockInvalidate,
  removeConnection: vi.fn(),
}));
vi.mock("../../src/lib/localDb.js", () => ({ updateProviderConnection: mockUpdateConn }));
vi.mock("open-sse/services/oauthCredentialManager.js", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    refreshProviderCredentials: mockRefreshProviderCreds,
    shouldRefreshCredentials: vi.fn(() => true),
  };
});

import { runBackgroundTokenRefreshTick } from "../../src/sse/services/backgroundTokenRefresh.js";
import { checkAndRefreshToken } from "../../src/sse/services/tokenRefresh.js";

const past = new Date(Date.now() - 60_000).toISOString();
const dueConn = (overrides = {}) => ({
  id: "c1",
  provider: "antigravity",
  authType: "oauth",
  refreshToken: "rt-1",
  expiresAt: past,
  accessToken: "old-acc",
  projectId: "stored-pid",
  connectionId: "c1",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sequential tick (no trailing sleep, #3813)", () => {
  it("single account resolves with zero sleeps", async () => {
    const sleep = vi.fn(async () => {});
    const order = [];
    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [dueConn({ id: "only" })],
      refreshConnection: async (c) => { order.push(c.id); },
      sleep,
    });
    expect(order).toEqual(["only"]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("multi refreshes sequentially with sleeps only between", async () => {
    vi.stubEnv("BG_REFRESH_GOOGLE_DELAY_MS", "10");
    vi.stubEnv("BG_REFRESH_DELAY_MS", "5");
    const sleep = vi.fn(async () => {});
    const order = [];
    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [
        dueConn({ id: "a" }),
        dueConn({ id: "b", provider: "openai" }),
        dueConn({ id: "c" }),
      ],
      refreshConnection: async (c) => { order.push(c.id); },
      sleep,
    });
    expect(order).toEqual(["a", "b", "c"]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(10);
    expect(sleep.mock.calls[0][0]).toBeLessThan(10 + 4000 + 1);
    expect(sleep.mock.calls[1][0]).toBe(5 + 200);
  });

  it.each(["Infinity", "-5", "0", "", "abc"])("invalid BG delay %p falls back to defaults", async (v) => {
    vi.stubEnv("BG_REFRESH_GOOGLE_DELAY_MS", v);
    vi.stubEnv("BG_REFRESH_DELAY_MS", v);
    const sleep = vi.fn(async () => {});
    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [dueConn({ id: "a" }), dueConn({ id: "b", provider: "openai" })],
      refreshConnection: async () => {},
      sleep,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(12_000);
    expect(sleep.mock.calls[0][0]).toBeLessThan(16_001);
  });

  it("huge BG delays are capped", async () => {
    vi.stubEnv("BG_REFRESH_GOOGLE_DELAY_MS", "999999");
    const sleep = vi.fn(async () => {});
    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [dueConn({ id: "a" }), dueConn({ id: "b" })],
      refreshConnection: async () => {},
      sleep,
    });
    expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(60_000 + 4000);
  });

  it.each([[".5", 1500 + 200], ["1.5", 1 + 200]])(
    "BG_REFRESH_DELAY_MS=%p floors before validation: sleep %p ms",
    async (v, expected) => {
      vi.stubEnv("BG_REFRESH_DELAY_MS", v);
      vi.stubEnv("BG_REFRESH_GOOGLE_DELAY_MS", "12000");
      const sleep = vi.fn(async () => {});
      await runBackgroundTokenRefreshTick({
        loadConnections: async () => [
          dueConn({ id: "a", provider: "openai" }),
          dueConn({ id: "b", provider: "openai" }),
        ],
        refreshConnection: async () => {},
        sleep,
      });
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep.mock.calls[0][0]).toBe(expected);
    }
  );
});

describe("lazy projectId gate (RAM-only invalidate, stored ID kept)", () => {
  it("lazy default: no onboard fetch, stored projectId preserved end-to-end", async () => {
    const creds = await checkAndRefreshToken("antigravity", dueConn());
    expect(mockInvalidate).toHaveBeenCalledWith("c1");
    expect(mockGetProjectId).not.toHaveBeenCalled();
    expect(creds.projectId).toBe("stored-pid");
    expect(mockUpdateConn.mock.calls.length).toBeGreaterThan(0);
    for (const [, updates] of mockUpdateConn.mock.calls) {
      expect(updates).not.toHaveProperty("projectId");
    }
  });

  it("eager opt-in passes provider through and persists fetched id", async () => {
    vi.stubEnv("EAGER_PROJECT_ID_REFRESH", "true");
    const creds = await checkAndRefreshToken("antigravity", dueConn());
    expect(mockGetProjectId).toHaveBeenCalledWith("c1", "new-acc", "antigravity");
    await vi.waitFor(() => {
      expect(mockUpdateConn).toHaveBeenCalledWith("c1", expect.objectContaining({ projectId: "pid-new" }));
    });
    expect(creds.projectId).toBe("stored-pid");
  });
});

describe("onboardUser bounds + no trailing sleep (#3813)", () => {
  let pid;
  let fetchMock;
  const onboardCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("onboardUser"));

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("open-sse/services/projectId.js");
    vi.useFakeTimers();
    fetchMock = vi.fn(async (url) => {
      if (String(url).includes("loadCodeAssist")) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      }
      return { ok: true, status: 200, json: async () => ({ done: false }), text: async () => "{}" };
    });
    vi.stubGlobal("fetch", fetchMock);
    pid = await import("open-sse/services/projectId.js");
  });

  it.each([["Infinity", 2], ["-3", 2], ["0", 2], ["", 2], ["999", 5]])(
    "ONBOARD_MAX_ATTEMPTS=%p bounds attempts to %p",
    async (v, expected) => {
      vi.stubEnv("ONBOARD_MAX_ATTEMPTS", v);
      vi.stubEnv("ONBOARD_RETRY_DELAY_MS", "1");
      const p = pid.getProjectIdForConnection("c-bounds", "tok");
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(35_000);
      await expect(p).resolves.toBeNull();
      expect(onboardCalls()).toHaveLength(expected);
    }
  );

  it.each([[".5", 2], ["1.5", 1], ["2.9", 2]])(
    "ONBOARD_MAX_ATTEMPTS=%p floors before validation: %p attempt(s), never zero",
    async (v, expected) => {
      vi.stubEnv("ONBOARD_MAX_ATTEMPTS", v);
      vi.stubEnv("ONBOARD_RETRY_DELAY_MS", "1");
      const p = pid.getProjectIdForConnection("c-frac", "tok");
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(35_000);
      await expect(p).resolves.toBeNull();
      // .5 floors to 0 -> invalid -> default 2; 1.5 floors to 1; 2.9 floors to 2
      expect(onboardCalls()).toHaveLength(expected);
    }
  );

  it("no sleep after final attempt (single-account hang fix)", async () => {
    vi.stubEnv("ONBOARD_MAX_ATTEMPTS", "1");
    vi.stubEnv("ONBOARD_RETRY_DELAY_MS", "12000");
    let settled = false;
    const p = pid
      .getProjectIdForConnection("c-final", "tok")
      .then((r) => { settled = true; return r; });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(settled).toBe(true);
    expect(onboardCalls()).toHaveLength(1);
    await expect(p).resolves.toBeNull();
  });
});
