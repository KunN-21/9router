import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), getProxyPools: vi.fn(), getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(), validateApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => mocks);
vi.mock("@/models", () => ({
  getProxyPoolById: async id => id === "missing" ? null : ({
    id, isActive: true, proxyUrl: "https://" + id + ".example", type: "vercel", strictProxy: true,
  }),
}));
const { getProviderCredentials, markAccountUnavailable, clearAccountError } = await import("@/sse/services/auth.js");
const pools = ["pool-a", "pool-b"].map(id => ({ id, isActive: true, proxyUrl: "https://" + id + ".example" }));

describe("noauth proxy failover respects upstream limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ providerStrategies: { opencode: { proxyPoolId: "pool-a", rotateStrategy: "none" } } });
    mocks.getProxyPools.mockResolvedValue(pools);
    mocks.getProviderConnections.mockImplementation(async () => { throw new Error("virtual credentials must not read account DB"); });
  });

  it("labels pinned pool so request exclusions can select next configured pool", async () => {
    const first = await getProviderCredentials("opencode");
    expect(first.connectionId).toBe("proxy:pool-a");
    expect(first.id).toBe("proxy:pool-a");
    expect(first.providerSpecificData.vercelRelayUrl).toBe("https://pool-a.example");
    expect(first.providerSpecificData.strictProxy).toBe(true);
    const failure = await markAccountUnavailable(first.connectionId, 503, "upstream unavailable", "opencode", "big-pickle");
    expect(failure.shouldFallback).toBe(true);
    const second = await getProviderCredentials("opencode", new Set([first.connectionId]));
    expect(second.connectionId).toBe("proxy:pool-b");
    expect(second.providerSpecificData.vercelRelayUrl).toBe("https://pool-b.example");
  });

  it("never leaks to direct egress when all configured pools were excluded", async () => {
    expect(await getProviderCredentials("opencode", new Set(["proxy:pool-a", "proxy:pool-b"]))).toBeNull();
  });

  it("filters excluded pools during configured rotation", async () => {
    mocks.getSettings.mockResolvedValue({ providerStrategies: { opencode: { rotateStrategy: "round-robin" } } });
    expect((await getProviderCredentials("oc", new Set(["proxy:pool-a"]))).connectionId).toBe("proxy:pool-b");
  });

  it.each([401, 402, 403, 429])("does not change egress after upstream status %s", async status => {
    expect(await markAccountUnavailable("proxy:pool-a", status, "upstream denied request", "opencode", "big-pickle"))
      .toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it.each(["rate limit exceeded", "quota exceeded", "FreeTierError", "RegionError", "DataPolicyError"])("does not change egress for %s even with status 503", async message => {
    expect((await markAccountUnavailable("proxy:pool-a", 503, message, "opencode", "big-pickle")).shouldFallback).toBe(false);
  });

  it("does not change egress for invalid requests", async () => {
    expect((await markAccountUnavailable("proxy:pool-a", 400, "invalid parameter", "opencode", "big-pickle")).shouldFallback).toBe(false);
  });

  it("keeps direct noauth credential without configured pool", async () => {
    mocks.getSettings.mockResolvedValue({});
    const credentials = await getProviderCredentials("opencode");
    expect(credentials.connectionId).toBe("noauth");
    expect(credentials.connectionName).toBe("Public");
    expect((await markAccountUnavailable("noauth", 503, "unavailable", "opencode")).shouldFallback).toBe(false);
  });

  it("does not clear virtual proxy errors through account storage", async () => {
    mocks.updateProviderConnection.mockImplementation(async () => { throw new Error("virtual credentials must not write account DB"); });
    await expect(clearAccountError("proxy:pool-a", { testStatus: "unavailable", lastError: "old" })).resolves.toBeUndefined();
  });
});
