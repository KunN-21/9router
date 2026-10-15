import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(async () => {}),
  clearAntigravityStrikes: vi.fn(() => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(async () => null),
  getSettings: vi.fn(),
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(async (_p, c) => c),
  updateProviderCredentials: vi.fn(async () => {}),
  handleAntigravityQuotaError: vi.fn(async () => null),
  getProjectIdForConnection: vi.fn(async () => null),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: mocks.handleAntigravityQuotaError,
  clearAntigravityStrikes: mocks.clearAntigravityStrikes,
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: mocks.getProjectIdForConnection,
}));

vi.mock("@/lib/headroom/detect", () => ({
  DEFAULT_HEADROOM_URL: "http://localhost:8787",
  parseHeadroomTimeoutMs: () => 30000,
}));

vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/lib/tokenSaver/events.js", () => ({ appendTokenSaverEvent: vi.fn() }));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

const { handleChat } = await import("@/sse/handlers/chat.js");

const req = (h = {}) => new Request("http://localhost:20128/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...h },
  body: JSON.stringify({ model: "anthropic/claude-3-7-sonnet", messages: [{ role: "user", content: "hi" }] }),
});

const okCreds = (connectionId) => ({
  connectionId,
  connectionName: connectionId,
  accessToken: `k-${connectionId}`,
});

describe("Chat account pinning header passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelInfo.mockResolvedValue({ provider: "anthropic", model: "claude-3-7-sonnet" });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getSettings.mockResolvedValue({});
    mocks.checkAndRefreshToken.mockImplementation(async (_p, c) => c);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok", { status: 200 }) });
  });

  it("extracts and trims x-connection-id into preferredConnectionId", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(okCreds("c1"));
    const res = await handleChat(req({ "x-connection-id": "  conn-pinned  " }));
    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "anthropic", expect.any(Set), "claude-3-7-sonnet", { preferredConnectionId: "conn-pinned" },
    );
    // Caller boundary forwards the actually chosen connection downstream.
    expect(mocks.handleChatCore.mock.calls[0][0].connectionId).toBe("c1");
    expect(mocks.handleChatCore.mock.calls[0][0].credentials.connectionId).toBe("c1");
  });

  it("passes null when header is whitespace", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(okCreds("c1"));
    const res = await handleChat(req({ "x-connection-id": "   " }));
    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "anthropic", expect.any(Set), "claude-3-7-sonnet", { preferredConnectionId: null },
    );
  });

  it("passes null when header is absent", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(okCreds("c1"));
    const res = await handleChat(req());
    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "anthropic", expect.any(Set), "claude-3-7-sonnet", { preferredConnectionId: null },
    );
  });

  it("falls back to next account when preferred account fails upstream", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(okCreds("conn-p"))
      .mockResolvedValueOnce(okCreds("conn-next"));
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 429, error: "Rate limit" })
      .mockResolvedValueOnce({ success: true, response: new Response("fallback ok", { status: 200 }) });
    const res = await handleChat(req({ "x-connection-id": "conn-p" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fallback ok");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.getProviderCredentials.mock.calls[1][1].has("conn-p")).toBe(true);
    expect(mocks.handleChatCore.mock.calls[1][0].connectionId).toBe("conn-next");
  });

  it("keeps single-model skipSsePeek false and stops after terminal non-fallback error", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(okCreds("c1"));
    mocks.handleChatCore.mockResolvedValueOnce({
      success: false, status: 400, error: "bad request", response: new Response("bad request", { status: 400 }),
    });
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: false });
    const res = await handleChat(req({ "x-connection-id": "conn-pinned" }));
    expect(res.status).toBe(400);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].skipSsePeek).toBe(false);
  });
});
