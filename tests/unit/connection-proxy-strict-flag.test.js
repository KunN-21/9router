import { beforeEach, expect, it, vi } from "vitest";

// vi.mock is hoisted, so getProxyPoolById binding must be created in vi.hoisted
const { getProxyPoolById } = vi.hoisted(() => ({ getProxyPoolById: vi.fn() }));
vi.mock("@/models", () => ({ getProxyPoolById }));

const { resolveConnectionProxyConfig } = await import("@/lib/network/connectionProxy.js");

beforeEach(() => vi.clearAllMocks());

it("active pool authority wins over legacy strict flag", async () => {
  getProxyPoolById.mockResolvedValue({
    id: "p1",
    isActive: true,
    proxyUrl: "http://pool:8080",
    strictProxy: false,
  });
  const r = await resolveConnectionProxyConfig({
    proxyPoolId: "p1",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://leg:9",
    strictProxy: true,
  });
  expect(r.source).toBe("pool");
  expect(r.strictProxy).toBe(false);
  expect(r.proxyPoolId).toBe("p1");
});

it("keeps intended strict flag through a resolver throw", async () => {
  getProxyPoolById.mockRejectedValue(new Error("db down"));
  const r = await resolveConnectionProxyConfig({
    proxyPoolId: "p1",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://leg:9",
    strictProxy: true,
  });
  expect(r.source).toBe("error");
  expect(r.strictProxy).toBe(true);
});

it("preserves pool-only configured intent on resolver throw", async () => {
  getProxyPoolById.mockRejectedValue(new Error("db connection timeout"));
  const r = await resolveConnectionProxyConfig({
    proxyPoolId: "pool-alpha",
    strictProxy: true,
  });
  expect(r.source).toBe("error");
  expect(r.strictProxy).toBe(true);
  expect(r.proxyPoolId).toBe("pool-alpha");
  expect(r.connectionProxyEnabled).toBe(false);
  expect(r.connectionProxyUrl).toBe("");
});

it("preserves legacy enabled and url configured intent on resolver throw", async () => {
  getProxyPoolById.mockRejectedValue(new Error("db query failed"));
  const r = await resolveConnectionProxyConfig({
    proxyPoolId: "pool-beta",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://proxy.corporate.internal:8080",
    connectionNoProxy: "localhost,127.0.0.1",
    strictProxy: true,
  });
  expect(r.source).toBe("error");
  expect(r.strictProxy).toBe(true);
  expect(r.proxyPoolId).toBe("pool-beta");
  expect(r.connectionProxyEnabled).toBe(true);
  expect(r.connectionProxyUrl).toBe("http://proxy.corporate.internal:8080");
  expect(r.connectionNoProxy).toBe("localhost,127.0.0.1");
});

it("normalizes __none__ sentinel ID to null on resolver throw", async () => {
  // Even if an unexpected error occurs, __none__ represents explicitly disabled pool
  getProxyPoolById.mockImplementation(() => {
    throw new Error("should not be called for none");
  });
  const r = await resolveConnectionProxyConfig({
    proxyPoolId: "__none__",
    strictProxy: true,
  });
  expect(r.source).toBe("none");
  expect(r.strictProxy).toBe(true);
  expect(r.proxyPoolId).toBe(null);
});

it("preserves strict false with intent on resolver throw", async () => {
  getProxyPoolById.mockRejectedValue(new Error("db down"));
  const r = await resolveConnectionProxyConfig({
    proxyPoolId: "pool-gamma",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://proxy.test:8080",
    connectionNoProxy: "localhost",
    strictProxy: false,
  });
  expect(r.source).toBe("error");
  expect(r.strictProxy).toBe(false);
  expect(r.proxyPoolId).toBe(null);
  expect(r.proxyPool).toBe(null);
  expect(r.connectionProxyEnabled).toBe(false);
  expect(r.connectionProxyUrl).toBe("");
  expect(r.connectionNoProxy).toBe("");
});

it("disables proxy on resolver throw when strictProxy is absent", async () => {
  getProxyPoolById.mockRejectedValue(new Error("db down"));
  const r = await resolveConnectionProxyConfig({
    proxyPoolId: "pool-delta",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://proxy.test:8080",
    connectionNoProxy: "localhost",
  });
  expect(r.source).toBe("error");
  expect(r.strictProxy).toBe(false);
  expect(r.proxyPoolId).toBe(null);
  expect(r.proxyPool).toBe(null);
  expect(r.connectionProxyEnabled).toBe(false);
  expect(r.connectionProxyUrl).toBe("");
  expect(r.connectionNoProxy).toBe("");
});

it("handles strict true without any proxy intent on resolver throw", async () => {
  getProxyPoolById.mockRejectedValue(new Error("db down"));
  const r = await resolveConnectionProxyConfig({
    strictProxy: true,
  });
  expect(r.source).toBe("none");
  expect(r.strictProxy).toBe(true);
  expect(r.proxyPoolId).toBe(null);
  expect(r.connectionProxyEnabled).toBe(false);
  expect(r.connectionProxyUrl).toBe("");
});
