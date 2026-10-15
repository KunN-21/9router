import { beforeEach, describe, expect, it, vi } from "vitest";

// Pure mock @/lib/localDb — no SQLite, no disk, no DATA_DIR temp dir.
const h = vi.hoisted(() => {
  const store = { connections: [] };
  const mocks = {
    getProviderConnections: vi.fn(),
    validateApiKey: vi.fn(async () => true),
    updateProviderConnection: vi.fn(async () => {}),
    getSettings: vi.fn(async () => ({})),
    getProxyPools: vi.fn(async () => []),
  };
  return { store, mocks };
});

vi.mock("@/lib/localDb", () => ({ ...h.mocks }));

// auth.js imports this module directly; mock so @/models/DB never enters the graph.
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    source: "none",
    proxyPoolId: null,
    proxyPool: null,
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
  })),
  pickProxyPoolId: vi.fn(() => null),
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({ getAntigravityQuotaCache: vi.fn(() => new Map()) }));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const MODEL = "claude-3-7-sonnet"; // matches the model chat.js passes down
const LOCK_KEY = "modelLock_claude-3-7-sonnet"; // getModelLockKey does NOT normalize characters
const seed = (id, o = {}) => h.store.connections.push({
  id,
  provider: "anthropic",
  authType: "apikey",
  apiKey: `k-${id}`,
  name: id,
  isActive: true,
  priority: 1,
  ...o,
});

describe("getProviderCredentials preferredConnectionId (mocked localDb, no real DB)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.store.connections = [];
    // Mock mirrors getProviderConnections semantics: filters isActive when queried.
    h.mocks.getProviderConnections.mockImplementation(async (q = {}) =>
      h.store.connections.filter((c) =>
        (!q.provider || c.provider === q.provider) &&
        (q.isActive !== true || c.isActive === true)));
    h.mocks.getSettings.mockResolvedValue({});
  });

  it("pins to the preferred active account", async () => {
    seed("c1");
    seed("c2");
    const r = await getProviderCredentials("anthropic", null, MODEL, { preferredConnectionId: "c2" });
    expect(r.connectionId).toBe("c2");
  });

  it("falls back to the fill-first account when preferred is unknown, inactive, excluded or locked", async () => {
    const future = new Date(Date.now() + 60000).toISOString();
    seed("c1");
    seed("c-off", { isActive: false });
    seed("c-lock", { [LOCK_KEY]: future });
    seed("c-expired-lock", { [LOCK_KEY]: new Date(Date.now() - 60000).toISOString() });
    seed("c2");

    expect((await getProviderCredentials("anthropic", null, MODEL, { preferredConnectionId: "c-missing" })).connectionId).toBe("c1");
    expect((await getProviderCredentials("anthropic", null, MODEL, { preferredConnectionId: "c-off" })).connectionId).toBe("c1");
    expect((await getProviderCredentials("anthropic", null, MODEL, { preferredConnectionId: "c-lock" })).connectionId).toBe("c1");
    expect((await getProviderCredentials("anthropic", new Set(["c2"]), MODEL, { preferredConnectionId: "c2" })).connectionId).toBe("c1");
    // Expired lock no longer blocks the pin — control for isModelLockActive.
    expect((await getProviderCredentials("anthropic", null, MODEL, { preferredConnectionId: "c-expired-lock" })).connectionId).toBe("c-expired-lock");
  });

  it("keeps byte-identical selection when the header is absent", async () => {
    seed("c1");
    seed("c2");
    expect((await getProviderCredentials("anthropic", null, MODEL)).connectionId).toBe("c1");
    expect((await getProviderCredentials("anthropic", null, MODEL, { preferredConnectionId: null })).connectionId).toBe("c1");
    expect((await getProviderCredentials("anthropic", null, MODEL, {})).connectionId).toBe("c1");
  });
});
