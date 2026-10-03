// B7: tailscale enable uses 20s short wait; background default stays 180s.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const networkMocks = vi.hoisted(() => ({
  resolveDns: vi.fn(async () => true),
  fetch: vi.fn(async () => ({ ok: false })),
}));

vi.mock("@/lib/tunnel/shared/dnsResolver.js", () => ({
  resolveDns: networkMocks.resolveDns,
}));

vi.mock("@/lib/tunnel/shared/state.js", () => ({
  loadState: vi.fn(() => null),
  generateShortId: vi.fn(() => "synthetic"),
}));

vi.mock("@/lib/tunnel/tailscale/tailscale.js", () => ({
  startDaemonWithPassword: vi.fn(async () => true),
  isTailscaleLoggedInStrict: vi.fn(async () => true),
  isTailscaleRunningStrict: vi.fn(async () => true),
  startLogin: vi.fn(async () => ({ authUrl: null })),
  stopFunnel: vi.fn(),
  startFunnel: vi.fn(async () => ({ tunnelUrl: "http://funnel.mock" })),
  provisionCert: vi.fn(async () => true),
  isTailscaleInstalled: vi.fn(async () => true),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => ({})),
}));

vi.mock("@/mitm/manager", () => ({
  getCachedPassword: vi.fn(() => "pass"),
  loadEncryptedPassword: vi.fn(async () => "pass"),
  initDbHooks: vi.fn(),
}));

const { HEALTH_CHECK } = await import("../../src/lib/tunnel/tailscale/config.js");
const health = await import("../../src/lib/tunnel/tailscale/healthCheck.js");
const mgr = await import("../../src/lib/tunnel/tailscale/manager.js");

describe("tailscale timeouts (fake clock, no daemon/network)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    networkMocks.resolveDns.mockResolvedValue(true);
    networkMocks.fetch.mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", networkMocks.fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("exposes enableTimeoutMs 20000 with background default 180000", () => {
    expect(HEALTH_CHECK.enableTimeoutMs).toBe(20000);
    expect(HEALTH_CHECK.timeoutMs).toBe(180000);
  });

  it("explicit short option times out near 20000ms", async () => {
    const url = "http://probe.invalid";
    const p = health.waitForHealth(url, { cancelled: false }, { timeoutMs: 20000 });
    const assertion = expect(p).rejects.toThrow("Health check timeout after 20000ms");
    await vi.advanceTimersByTimeAsync(20000 + 5000);
    await assertion;
    expect(networkMocks.resolveDns).toHaveBeenCalledWith("probe.invalid", HEALTH_CHECK.dnsTimeoutMs);
    expect(networkMocks.fetch).toHaveBeenCalled();
  });

  it("omitted option keeps the 180000ms default", async () => {
    const url = "http://probe.invalid";
    const p = health.waitForHealth(url, { cancelled: false });
    const assertion = expect(p).rejects.toThrow("Health check timeout after 180000ms");
    await vi.advanceTimersByTimeAsync(180000 + 5000);
    await assertion;
    expect(networkMocks.resolveDns).toHaveBeenCalledWith("probe.invalid", HEALTH_CHECK.dnsTimeoutMs);
    expect(networkMocks.fetch).toHaveBeenCalled();
  });

  it("cancellation still raises cancelled", async () => {
    const token = { cancelled: true };
    await expect(health.waitForHealth("http://probe.invalid", token, { timeoutMs: 20000 })).rejects.toThrow("cancelled");
  });

  it("manager passes enableTimeoutMs to waitForHealth", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../src/lib/tunnel/tailscale/manager.js", import.meta.url), "utf-8");
    expect(src).toContain("HEALTH_CHECK.enableTimeoutMs");
    expect(src).toContain("waitForHealth(result.tunnelUrl, token, { timeoutMs: HEALTH_CHECK.enableTimeoutMs })");
  });

  it("manager call enableTailscale actually invokes waitForHealth with 20000ms option", async () => {
    const spy = vi.spyOn(health, "waitForHealth").mockResolvedValue(true);
    try {
      const res = await mgr.enableTailscale(29999);
      expect(res.success).toBe(true);
      expect(spy).toHaveBeenCalledWith(
        "http://funnel.mock",
        expect.any(Object),
        { timeoutMs: 20000 }
      );
    } finally {
      spy.mockRestore();
    }
  });
});
