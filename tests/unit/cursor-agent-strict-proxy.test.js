import { beforeEach, describe, expect, it, vi } from "vitest";

const { getProxyPoolById, getProviderConnections, getSettings, getProxyPools } = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/models", () => ({ getProxyPoolById }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections,
  getSettings,
  getProxyPools,
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  getActiveRequests: vi.fn(() => 0),
  getUsageHistory: vi.fn(async () => []),
  getUsageStats: vi.fn(async () => ({})),
  getChartData: vi.fn(async () => ({})),
  getRecentLogs: vi.fn(async () => []),
  getRequestDetails: vi.fn(async () => []),
  getRequestDetailById: vi.fn(async () => null),
  statsEmitter: { emit: vi.fn(), on: vi.fn() },
}));

// Stub nội bộ: không network, không HTTP/2 thật.
import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { getProviderCredentials } from "../../src/sse/services/auth.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

const STUB = () => ({
  responseHeaders: Promise.resolve({ ":status": 200 }),
  write: vi.fn(),
  end: vi.fn(),
  close: vi.fn(),
  read: vi.fn().mockResolvedValue({ value: undefined, done: true }),
});
const BODY = { messages: [{ role: "user", content: "hi" }] };

describe("Cursor AgentService strict proxy fail-closed", () => {
  let ex;
  let connectStub;
  beforeEach(() => {
    vi.clearAllMocks();
    connectStub = vi.fn(() => STUB());
    ex = getExecutor("cursor");
    ex.openAgentHttp2Stream = connectStub;
    ex.buildHeaders = () => ({ "Content-Type": "application/json" });
    getSettings.mockResolvedValue({});
    getProxyPools.mockResolvedValue([]);
  });
  const run = (p) =>
    ex.executeAgent({
      model: "cursor-small",
      body: BODY,
      stream: false,
      credentials: { accessToken: "tok" },
      proxyOptions: p,
    });

  it.each([
    ["pool", { strictProxy: true, proxyPoolId: "p1" }],
    ["relay", { strictProxy: true, vercelRelayUrl: "https://relay.test" }],
    [
      "legacy url",
      {
        strictProxy: true,
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://127.0.0.1:8080",
      },
    ],
  ])("fails closed when strict intent meets %s", async (_label, p) => {
    await expect(run(p)).rejects.toThrow(/strict proxy/i);
    expect(connectStub).not.toHaveBeenCalled();
  });

  it("allows direct connection when strictProxy is false or absent", async () => {
    expect(
      (
        await run({
          strictProxy: false,
          vercelRelayUrl: "https://relay.test",
        })
      ).response.status,
    ).toBe(200);
    expect((await run(null)).response.status).toBe(200);
    expect((await run({ strictProxy: true })).response.status).toBe(200);
    expect(connectStub).toHaveBeenCalledTimes(3);
  });

  it("does not leak secrets and forwards proxyOptions from execute", async () => {
    // HEAD: execute không truyền proxyOptions
    try {
      await run({
        strictProxy: true,
        connectionProxyUrl: "http://u:secretPass@p.int:9",
      });
      expect.unreachable();
    } catch (e) {
      expect(e.message).not.toContain("secretPass");
    }
    const res = await ex.execute({
      model: "cursor-small",
      body: BODY,
      stream: false,
      credentials: { accessToken: "tok" },
      proxyOptions: { strictProxy: true, proxyPoolId: "p1" },
    });
    expect(res.response.status).toBe(500);
    expect((await res.response.json()).error.message).toMatch(/strict proxy/i);
  });

  describe("End-to-End Real Flow: resolver throw -> auth projection -> guard", () => {
    it("fails closed on real resolver throw when connection has poolId + strictProxy", async () => {
      getProxyPoolById.mockRejectedValue(new Error("Database pool connection offline"));
      getProviderConnections.mockResolvedValue([
        {
          id: "conn-cursor-1",
          authType: "oauth",
          accessToken: "valid-tok",
          isActive: true,
          provider: "cursor",
          providerSpecificData: {
            machineId: "mock-machine-id",
            proxyPoolId: "pool-prod-restricted",
            strictProxy: true,
          },
        },
      ]);

      const creds = await getProviderCredentials("cursor");
      expect(creds).not.toBeNull();

      // Real flow through handleChatCore: exercises actual resolver output projection and CursorExecutor guard
      const result = await handleChatCore({
        body: {
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        },
        modelInfo: { provider: "cursor", model: "cursor-small" },
        credentials: creds,
      });

      expect(connectStub).not.toHaveBeenCalled();
      expect(result.status).toBe(500);
      expect(result.error).toMatch(/strict proxy/i);
    });

    it("fails closed on real resolver throw when connection has legacy url + strictProxy", async () => {
      getProxyPoolById.mockRejectedValue(new Error("Database offline"));
      getProviderConnections.mockResolvedValue([
        {
          id: "conn-cursor-2",
          authType: "oauth",
          accessToken: "valid-tok",
          isActive: true,
          provider: "cursor",
          providerSpecificData: {
            machineId: "mock-machine-id",
            proxyPoolId: "pool-fallback-trigger",
            connectionProxyEnabled: true,
            connectionProxyUrl: "http://proxy.secure.zone:3128",
            strictProxy: true,
          },
        },
      ]);

      const creds = await getProviderCredentials("cursor");
      expect(creds).not.toBeNull();

      const result = await handleChatCore({
        body: {
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        },
        modelInfo: { provider: "cursor", model: "cursor-small" },
        credentials: creds,
      });

      expect(connectStub).not.toHaveBeenCalled();
      expect(result.status).toBe(500);
      expect(result.error).toMatch(/strict proxy/i);
    });

    it("allows direct connection on resolver throw when connection has strictProxy false", async () => {
      getProxyPoolById.mockRejectedValue(new Error("Database offline"));
      getProviderConnections.mockResolvedValue([
        {
          id: "conn-cursor-3",
          authType: "oauth",
          accessToken: "valid-tok",
          isActive: true,
          provider: "cursor",
          providerSpecificData: {
            machineId: "mock-machine-id",
            proxyPoolId: "pool-optional",
            connectionProxyEnabled: true,
            connectionProxyUrl: "http://legacy.proxy:8080",
            connectionNoProxy: "localhost",
            strictProxy: false,
          },
        },
      ]);

      const creds = await getProviderCredentials("cursor");
      expect(creds).not.toBeNull();
      expect(creds.providerSpecificData.connectionProxyEnabled).toBe(false);
      expect(creds.providerSpecificData.connectionProxyUrl).toBe("");
      expect(creds.providerSpecificData.connectionNoProxy).toBe("");
      expect(creds.providerSpecificData.connectionProxyPoolId).toBe(null);
      expect(creds.providerSpecificData.strictProxy).toBe(false);

      const result = await handleChatCore({
        body: {
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        },
        modelInfo: { provider: "cursor", model: "cursor-small" },
        credentials: creds,
      });

      expect(connectStub).toHaveBeenCalledTimes(1);
      expect(result.response.status).toBe(200);
    });

    it("allows direct connection on resolver throw when strictProxy is absent", async () => {
      getProxyPoolById.mockRejectedValue(new Error("Database offline"));
      getProviderConnections.mockResolvedValue([
        {
          id: "conn-cursor-4",
          authType: "oauth",
          accessToken: "valid-tok",
          isActive: true,
          provider: "cursor",
          providerSpecificData: {
            machineId: "mock-machine-id",
            proxyPoolId: "pool-optional-2",
            connectionProxyEnabled: true,
            connectionProxyUrl: "http://legacy.proxy:8080",
            connectionNoProxy: "localhost",
          },
        },
      ]);

      const creds = await getProviderCredentials("cursor");
      expect(creds).not.toBeNull();
      expect(creds.providerSpecificData.connectionProxyEnabled).toBe(false);
      expect(creds.providerSpecificData.connectionProxyUrl).toBe("");
      expect(creds.providerSpecificData.connectionNoProxy).toBe("");
      expect(creds.providerSpecificData.connectionProxyPoolId).toBe(null);
      expect(creds.providerSpecificData.strictProxy).toBe(false);

      const result = await handleChatCore({
        body: {
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        },
        modelInfo: { provider: "cursor", model: "cursor-small" },
        credentials: creds,
      });

      expect(connectStub).toHaveBeenCalledTimes(1);
      expect(result.response.status).toBe(200);
    });
  });
});
