import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { resolveSessionId } from "../../open-sse/utils/sessionManager.js";

const executor = new OpenCodeExecutor();
const credentials = { connectionId: "continuity-test", rawHeaders: {} };
const sessionFor = (body, headers = {}) => {
  const providerSessionId = resolveSessionId({
    headers, body, connectionId: credentials.connectionId, scope: "opencode",
  });
  return executor.prepareRequestCredentials({
    body, credentials: { ...credentials, rawHeaders: headers }, providerSessionId, clientTool: "generic",
  })._opencodeSession;
};

afterEach(() => vi.unstubAllEnvs());

describe("OpenCode session continuity", () => {
  it("keeps upstream session when assistant history first appears", () => {
    const messages = [{ role: "user", content: "hello" }];
    const first = sessionFor({ messages });
    const second = sessionFor({ messages: [
      ...messages,
      { role: "assistant", content: "assistant reply ".repeat(10) },
      { role: "user", content: "continue" },
    ] });
    expect(second).toBe(first);
  });

  it("does not turn request IDs into new sessions on every request", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    expect(sessionFor(body, { "x-client-request-id": "request-a" }))
      .toBe(sessionFor(body, { "x-client-request-id": "request-b" }));
  });

  it("still isolates explicit conversations", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    expect(sessionFor(body, { "x-session-id": "conversation-a" }))
      .not.toBe(sessionFor(body, { "x-session-id": "conversation-b" }));
  });
});

describe("OpenCode peer IP trust", () => {
  it("ignores arbitrary forwarding headers without wrapper proof", () => {
    vi.stubEnv("NINEROUTER_PEER_TOKEN", "wrapper-secret");
    const headers = executor.buildHeaders({ rawHeaders: {
      "x-real-ip": "198.51.100.9", "x-9r-real-ip": "203.0.113.7", "x-9r-peer-token": "forged",
    } });
    expect(headers["x-real-ip"]).toBeUndefined();
  });

  it("ignores forwarding headers when custom server is absent", () => {
    vi.stubEnv("NINEROUTER_PEER_TOKEN", "");
    expect(executor.buildHeaders({ rawHeaders: { "x-real-ip": "198.51.100.9" } })["x-real-ip"])
      .toBeUndefined();
  });

  it("forwards socket-derived IP with valid wrapper proof", () => {
    vi.stubEnv("NINEROUTER_PEER_TOKEN", "wrapper-secret");
    const headers = executor.buildHeaders({ rawHeaders: {
      "x-9r-real-ip": "203.0.113.7", "x-9r-peer-token": "wrapper-secret", "x-real-ip": "198.51.100.9",
    } });
    expect(headers["x-real-ip"]).toBe("203.0.113.7");
    expect(headers["x-9r-peer-token"]).toBeUndefined();
  });
});
