import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import {
  OPENCODE_SESSION_RE,
  OPENCODE_REQUEST_RE,
  generateSessionId,
  translateSessionId,
  stableSessionId,
  deriveRequestId,
} from "../../open-sse/executors/opencode.js";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("PR-4806 Protocol Integration: Inverted Timestamp Encoding", () => {
  it("generates a session ID whose 12-hex prefix decodes to current timestamp within 5000ms", () => {
    const sid = generateSessionId();
    expect(sid).toMatch(OPENCODE_SESSION_RE);
    const hex = sid.slice(4, 16);
    const encoded = BigInt("0x" + hex);
    const inverted = ~encoded & 0xffffffffffffn;
    const recoveredTs = Number(inverted >> 12n);
    const currentLow36 = Date.now() % (2 ** 48 / 4096);
    expect(Math.abs(currentLow36 - recoveredTs)).toBeLessThan(5000);
  });

  it("preserves already-valid native OpenCode session ID without modification", () => {
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    expect(translateSessionId(valid, "claude")).toBe(valid);
  });
});

describe("PR-4806 Protocol Integration: Header Defaults & Companion Session ID", () => {
  it("sets identical x-opencode-session and x-opencode-session-id with cli client and 1.18.35 UA in opencode", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({});
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
  });

  it("sets identical x-opencode-session and x-opencode-session-id with cli client and 1.18.35 UA in opencode-zen", () => {
    const executor = getExecutor("opencode-zen");
    const headers = executor.buildHeaders({});
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
  });

  it("sets companion x-opencode-session-id matching x-opencode-session in opencode-go", () => {
    const executor = getExecutor("opencode-go");
    const headers = executor.buildHeaders({ apiKey: "test-key" });
    expect(headers["x-opencode-session"]).toBeDefined();
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
  });

  it("sets companion x-opencode-session-id matching x-opencode-session in systemoneCore dispatch", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      model: "jev-1.13",
      answers: { is_urgent: { type: "noul", noul: 0.99 } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await handleSystemoneCore({
      body: { state: "Test state", questions: { is_urgent: { type: "noul" } } },
      modelInfo: { provider: "opencode", model: "jev-1.13-free" },
      credentials: { accessToken: "public" },
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["x-opencode-session"]).toBeDefined();
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
  });
});

describe("PR-4806 Protocol Integration: Session Continuity & Isolation", () => {
  it("reuses stable session ID for identical conversation across multiple turns in opencode-zen", () => {
    const zenExecutor = getExecutor("opencode-zen");
    const creds = { connectionId: "zen-conn-multi" };
    const turn1 = zenExecutor.prepareRequestCredentials({
      credentials: creds,
      providerSessionId: "chat-conversation-zen-1",
      clientTool: "claude",
    });
    const turn2 = zenExecutor.prepareRequestCredentials({
      credentials: creds,
      providerSessionId: "chat-conversation-zen-1",
      clientTool: "claude",
    });
    expect(turn1._opencodeZenSession).toMatch(OPENCODE_SESSION_RE);
    expect(turn2._opencodeZenSession).toBe(turn1._opencodeZenSession);
  });

  it("isolates different foreign sessions into distinct canonical session IDs", () => {
    const sidA = translateSessionId("client-session-A", "claude");
    const sidB = translateSessionId("client-session-B", "claude");
    expect(sidA).not.toBe(sidB);
  });

  it("refreshes key insertion order upon cache access so frequently used keys are not evicted (True LRU)", () => {
    const initial = translateSessionId("frequent-client-session", "claude");
    for (let i = 0; i < 999; i++) {
      translateSessionId(`dummy-session-${i}`, "claude");
    }
    translateSessionId("frequent-client-session", "claude");
    translateSessionId("overflow-trigger", "claude");
    expect(translateSessionId("frequent-client-session", "claude")).toBe(initial);
  });
});

describe("PR-4806 Protocol Integration: Retry Determinism in deriveRequestId", () => {
  it("returns identical request ID across delayed retries of the same turn prompt", async () => {
    const sid = translateSessionId("retry-conv", "claude");
    const body = { messages: [{ role: "user", content: "Explain quantum entanglement" }] };
    const idAttempt1 = deriveRequestId(sid, body);
    expect(idAttempt1).toMatch(OPENCODE_REQUEST_RE);

    await new Promise((r) => setTimeout(r, 50));
    const idAttempt2 = deriveRequestId(sid, body);

    expect(idAttempt2).toBe(idAttempt1);
  });

  it("generates different request ID when turn message changes", () => {
    const sid = translateSessionId("diff-turn-conv", "claude");
    const body1 = { messages: [{ role: "user", content: "Question 1" }] };
    const body2 = { messages: [{ role: "user", content: "Question 2" }] };
    const id1 = deriveRequestId(sid, body1);
    const id2 = deriveRequestId(sid, body2);
    expect(id1).not.toBe(id2);
  });
});

describe("PR-4806 Protocol Integration: Real Executor Public Execute & Wire Integrity", () => {
  it("wires companion headers and preserves 403 error body in opencode execute without credential mutation", async () => {
    const executor = getExecutor("opencode");
    const credentials = { connectionId: "wire-test-free", rawHeaders: {} };
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: "Free tier unavailable", code: "free_tier_error" } }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    ));

    const result = await executor.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: false,
      credentials,
      providerSessionId: "conv-wire-test",
      clientTool: "claude",
    });

    expect(result.response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledHeaders = fetchMock.mock.calls[0][1].headers;
    expect(calledHeaders["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(calledHeaders["x-opencode-session-id"]).toBe(calledHeaders["x-opencode-session"]);
    expect(calledHeaders["x-opencode-client"]).toBe("cli");
    expect(calledHeaders["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
    expect(credentials).not.toHaveProperty("_opencodeSession");
  });

  it("wires companion headers in opencode-go execute without credential mutation", async () => {
    const executor = getExecutor("opencode-go");
    const credentials = {
      apiKey: "test-go-key",
      connectionId: "wire-test-go",
      rawHeaders: {},
      runtimeTransport: { format: "openai", baseUrl: "https://opencode.ai/zen/go/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
    };

    const result = await executor.execute({
      model: "glm-5.2",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials,
      providerSessionId: "conv-wire-go",
      clientTool: "claude",
    });

    expect(result.headers["x-opencode-session-id"]).toBe(result.headers["x-opencode-session"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledHeaders = fetchMock.mock.calls[0][1].headers;
    expect(calledHeaders["x-opencode-session"]).toBe(result.headers["x-opencode-session"]);
    expect(calledHeaders["x-opencode-session-id"]).toBe(result.headers["x-opencode-session"]);
    expect(credentials).not.toHaveProperty("_opencodeGoSession");
  });
});

describe("PR-4806 Protocol Integration: Cache Capacity Isolation & Session Lifecycle", () => {
  it("preserves conversation 0 session across turns when 600 distinct conversations send requests (capacity isolation)", () => {
    const executor = getExecutor("opencode");
    const conv0Session = "client-session-conv-0";
    const bodyTurn1 = {
      messages: [{ role: "user", content: "Hello from conv 0 turn 1" }],
    };
    const res0Turn1 = executor.prepareRequestCredentials({
      body: bodyTurn1,
      credentials: { rawHeaders: { "x-opencode-session": conv0Session } },
      clientTool: "claude",
    });
    const session0Turn1 = res0Turn1._opencodeSession;
    expect(session0Turn1).toMatch(OPENCODE_SESSION_RE);

    // 600 distinct conversations each send 1 request (< 1000 conversation capacity)
    for (let i = 1; i <= 600; i++) {
      executor.prepareRequestCredentials({
        body: { messages: [{ role: "user", content: `Query from conv ${i}` }] },
        credentials: { rawHeaders: { "x-opencode-session": `client-session-conv-${i}` } },
        clientTool: "claude",
      });
    }

    // Revisit conversation 0 for turn 2
    const bodyTurn2 = {
      messages: [
        { role: "user", content: "Hello from conv 0 turn 1" },
        { role: "assistant", content: "Response to turn 1" },
        { role: "user", content: "Follow-up question from conv 0 turn 2" },
      ],
    };
    const res0Turn2 = executor.prepareRequestCredentials({
      body: bodyTurn2,
      credentials: { rawHeaders: { "x-opencode-session": conv0Session } },
      clientTool: "claude",
    });
    const session0Turn2 = res0Turn2._opencodeSession;

    expect(session0Turn2).toBe(session0Turn1);
  });

  it("evicts oldest conversation naturally when exceeding full 1000 conversation capacity in LRU order", () => {
    const initial = stableSessionId({ connectionId: "overflow-conv-0" });
    for (let i = 1; i <= 1001; i++) {
      stableSessionId({ connectionId: `overflow-conv-${i}` });
    }
    const revisited = stableSessionId({ connectionId: "overflow-conv-0" });
    expect(revisited).not.toBe(initial);
    expect(revisited).toMatch(OPENCODE_SESSION_RE);
  });

  it("preserves conversation 0 across 999 other conversations when within 1000 session capacity", () => {
    const initial = translateSessionId("capacity-conv-0", "claude");
    for (let i = 1; i <= 999; i++) {
      translateSessionId(`capacity-conv-${i}`, "claude");
    }
    const revisited = translateSessionId("capacity-conv-0", "claude");
    expect(revisited).toBe(initial);
  });

  it("evicts stale session after TTL has elapsed following clock advance", () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);
      const initial = stableSessionId({ connectionId: "ttl-expire-test" });
      expect(stableSessionId({ connectionId: "ttl-expire-test" })).toBe(initial);

      vi.setSystemTime(now + 2 * 60 * 60 * 1000 + 1000);
      const afterTtl = stableSessionId({ connectionId: "ttl-expire-test" });
      expect(afterTtl).not.toBe(initial);
      expect(afterTtl).toMatch(OPENCODE_SESSION_RE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintains stable session in opencode-zen across multi-turn time advances within TTL", () => {
    const zenExecutor = getExecutor("opencode-zen");
    const creds = { connectionId: "zen-time-advance-test" };
    vi.useFakeTimers();
    try {
      let t = Date.now();
      vi.setSystemTime(t);
      const turn1 = zenExecutor.prepareRequestCredentials({
        credentials: creds,
        providerSessionId: "zen-time-adv-conv",
        clientTool: "claude",
      });
      const initialSession = turn1._opencodeZenSession;
      expect(initialSession).toMatch(OPENCODE_SESSION_RE);

      // Advance time by 30 seconds
      t += 30000;
      vi.setSystemTime(t);
      const turn2 = zenExecutor.prepareRequestCredentials({
        credentials: creds,
        providerSessionId: "zen-time-adv-conv",
        clientTool: "claude",
      });
      expect(turn2._opencodeZenSession).toBe(initialSession);

      // Advance time by 10 minutes
      t += 600000;
      vi.setSystemTime(t);
      const turn3 = zenExecutor.prepareRequestCredentials({
        credentials: creds,
        providerSessionId: "zen-time-adv-conv",
        clientTool: "claude",
      });
      expect(turn3._opencodeZenSession).toBe(initialSession);
    } finally {
      vi.useRealTimers();
    }
  });
});
