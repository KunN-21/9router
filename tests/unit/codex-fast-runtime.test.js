import { beforeEach, describe, expect, it, vi } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import "../../tests/translator/registerAll.js";
import "../../open-sse/translator/request/claude-to-responses.js";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(async () => {}),
  clearAntigravityStrikes: vi.fn(() => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
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

function makeRequest(body, headers = {}) {
  return new Request("http://localhost:20128/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeCreds(connectionId = "conn-codex-1", psd = {}, provider = "codex") {
  return {
    connectionId,
    connectionName: `Conn-${connectionId}`,
    provider,
    accessToken: `key-${connectionId}`,
    providerSpecificData: psd,
  };
}

describe("Gateway Tri-State Precedence & Fast Mode Runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelInfo.mockImplementation(async (m) => {
      if (m === "codex-combo" || m === "codex-antigravity-combo") {
        return { provider: null, model: null };
      }
      if (m.startsWith("antigravity/")) {
        return { provider: "antigravity", model: m.slice("antigravity/".length) };
      }
      if (m.startsWith("codex/")) {
        return { provider: "codex", model: m.slice("codex/".length) };
      }
      return { provider: "codex", model: m };
    });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getSettings.mockResolvedValue({});
    mocks.checkAndRefreshToken.mockImplementation(async (_p, c) => c);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleChatCore.mockResolvedValue({
      success: true,
      response: new Response("ok", { status: 200, headers: { "Content-Type": "application/json" } }),
    });
  });

  it("injects priority tier for client speed fast on Codex attempt", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", {}));
    const body = {
      model: "codex/gpt-6.1-sol",
      speed: "fast",
      messages: [{ role: "user", content: "hello" }],
    };
    const res = await handleChat(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    const downstreamBody = mocks.handleChatCore.mock.calls[0][0].body;
    expect(downstreamBody.service_tier).toBe("priority");
  });

  it("injects priority tier when client intent is absent and account codexFastMode is true", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }));
    const body = {
      model: "codex/gpt-6.1-sol",
      messages: [{ role: "user", content: "hello" }],
    };
    const res = await handleChat(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    const downstreamBody = mocks.handleChatCore.mock.calls[0][0].body;
    expect(downstreamBody.service_tier).toBe("priority");
  });

  it("does not inject priority when intent and account flag are absent", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", {}));
    const body = {
      model: "codex/gpt-6.1-sol",
      messages: [{ role: "user", content: "hello" }],
    };
    const res = await handleChat(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    const downstreamBody = mocks.handleChatCore.mock.calls[0][0].body;
    expect(downstreamBody.service_tier).toBeUndefined();
  });

  it("preserves explicit service_tier priority", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: false }));
    const body = {
      model: "codex/gpt-6.1-sol",
      service_tier: "priority",
      messages: [{ role: "user", content: "hello" }],
    };
    const res = await handleChat(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    const downstreamBody = mocks.handleChatCore.mock.calls[0][0].body;
    expect(downstreamBody.service_tier).toBe("priority");
  });

  it("normalizes explicit service_tier fast to priority for Codex attempt", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", {}));
    const body = {
      model: "codex/gpt-6.1-sol",
      service_tier: "fast",
      messages: [{ role: "user", content: "hello" }],
    };
    const res = await handleChat(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    const downstreamBody = mocks.handleChatCore.mock.calls[0][0].body;
    expect(downstreamBody.service_tier).toBe("priority");
  });

  it("preserves explicit standard and flex tiers and suppresses account default", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }));
    const bodyStandard = {
      model: "codex/gpt-6.1-sol",
      service_tier: "standard",
      messages: [{ role: "user", content: "hello" }],
    };
    await handleChat(makeRequest(bodyStandard));
    expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBe("standard");

    mocks.handleChatCore.mockClear();
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }));
    const bodyFlex = {
      model: "codex/gpt-6.1-sol",
      service_tier: "flex",
      messages: [{ role: "user", content: "hello" }],
    };
    await handleChat(makeRequest(bodyFlex));
    expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBe("flex");
  });

  it("preserves explicit malformed service_tier and suppresses auto-injection", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }));
    const bodyNull = {
      model: "codex/gpt-6.1-sol",
      service_tier: null,
      messages: [{ role: "user", content: "hello" }],
    };
    await handleChat(makeRequest(bodyNull));
    expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBeNull();

    mocks.handleChatCore.mockClear();
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }));
    const bodyNum = {
      model: "codex/gpt-6.1-sol",
      service_tier: 123,
      messages: [{ role: "user", content: "hello" }],
    };
    await handleChat(makeRequest(bodyNum));
    expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBe(123);
  });

  it("suppresses account default when speed standard is explicit", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }));
    const body = {
      model: "codex/gpt-6.1-sol",
      speed: "standard",
      messages: [{ role: "user", content: "hello" }],
    };
    await handleChat(makeRequest(body));
    expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBeUndefined();
  });

  it("suppresses account default and never coerces to priority on invalid speed", async () => {
    for (const invalidSpeed of ["turbo", 123, null, ""]) {
      mocks.handleChatCore.mockClear();
      mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }));
      const body = {
        model: "codex/gpt-6.1-sol",
        speed: invalidSpeed,
        messages: [{ role: "user", content: "hello" }],
      };
      await handleChat(makeRequest(body));
      expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBeUndefined();
    }
  });

  it("requires strict boolean true for account codexFastMode", async () => {
    for (const invalidFlag of ["true", 1, {}, [], "1"]) {
      mocks.handleChatCore.mockClear();
      mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: invalidFlag }));
      const body = {
        model: "codex/gpt-6.1-sol",
        messages: [{ role: "user", content: "hello" }],
      };
      await handleChat(makeRequest(body));
      expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBeUndefined();
    }
  });

  it("does not inject priority on non-Codex providers regardless of speed or account flags", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }, "antigravity"));
    const body = {
      model: "antigravity/claude-3-7-sonnet",
      speed: "fast",
      messages: [{ role: "user", content: "hello" }],
    };
    await handleChat(makeRequest(body));
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBeUndefined();
  });

  it("evaluates account flag per attempt on account retry", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(makeCreds("c1", { codexFastMode: false }))
      .mockResolvedValueOnce(makeCreds("c2", { codexFastMode: true }));

    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 500, error: "Outage", response: new Response("err", { status: 500 }) })
      .mockResolvedValueOnce({ success: true, response: new Response("ok", { status: 200, headers: { "Content-Type": "application/json" } }) });

    const body = {
      model: "codex/gpt-6.1-sol",
      messages: [{ role: "user", content: "hello" }],
    };
    const res = await handleChat(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBeUndefined();
    expect(mocks.handleChatCore.mock.calls[1][0].body.service_tier).toBe("priority");
  });

  it("retains client speed fast across combo Codex to Codex fallback", async () => {
    mocks.getComboModels.mockResolvedValueOnce(["codex/gpt-5", "codex/gpt-4.1"]);
    mocks.getProviderCredentials
      .mockResolvedValueOnce(makeCreds("c1", {}))
      .mockResolvedValueOnce(makeCreds("c2", {}));

    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 500, error: "Fail", response: new Response("err", { status: 500 }) })
      .mockResolvedValueOnce({ success: true, response: new Response("ok", { status: 200, headers: { "Content-Type": "application/json" } }) });

    const body = {
      model: "codex-combo",
      speed: "fast",
      messages: [{ role: "user", content: "hello" }],
    };
    const res = await handleChat(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBe("priority");
    expect(mocks.handleChatCore.mock.calls[1][0].body.service_tier).toBe("priority");
  });

  it("does not bleed account default priority from Codex to non-Codex fallback in combo", async () => {
    mocks.getComboModels.mockResolvedValueOnce(["codex/gpt-5", "antigravity/claude-3-7-sonnet"]);
    mocks.getProviderCredentials
      .mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }, "codex"))
      .mockResolvedValueOnce(makeCreds("c2", {}, "antigravity"));

    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 500, error: "Fail", response: new Response("err", { status: 500 }) })
      .mockResolvedValueOnce({ success: true, response: new Response("ok", { status: 200, headers: { "Content-Type": "application/json" } }) });

    const body = {
      model: "codex-antigravity-combo",
      messages: [{ role: "user", content: "hello" }],
    };
    const res = await handleChat(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.handleChatCore.mock.calls[0][0].body.service_tier).toBe("priority");
    expect(mocks.handleChatCore.mock.calls[1][0].body.service_tier).toBeUndefined();
  });

  it("guarantees caller request body remains unmodified across attempts", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", { codexFastMode: true }));
    const body = {
      model: "codex/gpt-6.1-sol",
      speed: "fast",
      messages: [{ role: "user", content: "hello" }],
      extraCustomField: "keep-me",
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    await handleChat(makeRequest(body));
    expect(body).toEqual(snapshot);
    expect(body.service_tier).toBeUndefined();
  });

  it("terminates combo fallback upon accepted content and forwards skipSsePeek", async () => {
    mocks.getComboModels.mockResolvedValueOnce(["codex/gpt-5", "codex/gpt-4.1"]);
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", {}));
    mocks.handleChatCore.mockResolvedValueOnce({
      success: true,
      response: new Response("ok", { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    const body = {
      model: "codex-combo",
      messages: [{ role: "user", content: "hello" }],
    };
    const res = await handleChat(makeRequest(body));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].skipSsePeek).toBe(true);
  });

  it("preserves priority through direct translateRequest and CodexExecutor shaping", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(makeCreds("c1", {}));
    const body = {
      model: "codex/gpt-6.1-sol",
      speed: "fast",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 500,
    };
    await handleChat(makeRequest(body));
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    const gatewayBody = mocks.handleChatCore.mock.calls[0][0].body;
    expect(gatewayBody.service_tier).toBe("priority");

    const wire = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
      "gpt-6.1-sol",
      gatewayBody,
      true,
      null
    );
    expect(wire.service_tier).toBe("priority");

    const executor = new CodexExecutor();
    const transformed = executor.transformRequest("gpt-6.1-sol", wire, true, {});
    expect(transformed.service_tier).toBe("priority");
  });
});
