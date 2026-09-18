import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

import { OpenCodeExecutor } from "open-sse/executors/opencode.js";
import { DefaultExecutor } from "open-sse/executors/default.js";

// Regression tests for the OpenCode Free (-free models) 429 fix:
// 1. versioned official User-Agent (bare "opencode" is still rate-limited by Zen)
// 2. x-real-ip forwarding so the upstream per-IP quota bucket is the user's own
// 3. per-request session isolation (singleton executor used to bleed sessions
//    across concurrent requests via the _currentSessionId instance field)
describe("OpenCodeExecutor fingerprint (free-tier 429 fix)", () => {
  it("sends the official versioned opencode User-Agent on free-tier requests", () => {
    const ex = new OpenCodeExecutor();
    const headers = ex.buildHeaders({ rawHeaders: {} });
    expect(headers["User-Agent"]).toMatch(/^opencode\//);
    expect(headers["User-Agent"]).not.toBe("opencode");
  });

  it("passes through a real opencode downstream User-Agent untouched", () => {
    const ex = new OpenCodeExecutor();
    const headers = ex.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.18.18" } });
    expect(headers["User-Agent"]).toBe("opencode/1.18.18");
  });

  it("forwards the sanitized peer IP as x-real-ip for per-IP quota buckets", () => {
    const ex = new OpenCodeExecutor();
    const headers = ex.buildHeaders({ rawHeaders: { "x-9r-real-ip": "203.0.113.7" } });
    expect(headers["x-real-ip"]).toBe("203.0.113.7");
  });

  it("falls back to the client-supplied x-real-ip when the server did not stamp one", () => {
    const ex = new OpenCodeExecutor();
    const headers = ex.buildHeaders({ rawHeaders: { "x-real-ip": "198.51.100.9" } });
    expect(headers["x-real-ip"]).toBe("198.51.100.9");
  });

  it("omits x-real-ip when no client IP is known", () => {
    const ex = new OpenCodeExecutor();
    const headers = ex.buildHeaders({ rawHeaders: {} });
    expect(headers["x-real-ip"]).toBeUndefined();
  });

  it("keeps sessions per-request under concurrency (no singleton bleed)", () => {
    const ex = new OpenCodeExecutor();
    const body = { messages: [{ role: "user", content: "hi" }] };
    const credA = { rawHeaders: { "x-client-request-id": "conv-a" } };
    const credB = { rawHeaders: { "x-client-request-id": "conv-b" } };

    ex.transformRequest("deepseek-v4-flash-free", body, true, credA);
    const hA = ex.buildHeaders(credA);
    ex.transformRequest("deepseek-v4-flash-free", body, true, credB);
    const hB = ex.buildHeaders(credB);
    // A's next turn must NOT pick up B's session (old code: instance field bleed)
    ex.transformRequest("deepseek-v4-flash-free", body, true, credA);
    const hA2 = ex.buildHeaders(credA);

    expect(hA["x-opencode-session"]).toBe(hA2["x-opencode-session"]);
    expect(hA["x-opencode-session"]).not.toBe(hB["x-opencode-session"]);
    expect(hB["x-opencode-session"]).toMatch(/^ses_/);
  });

  it("keeps a stable session per conversation via client session headers", () => {
    const ex = new OpenCodeExecutor();
    const body = { messages: [{ role: "user", content: "hi" }] };
    const cred = { rawHeaders: { "x-session-id": "ses_abc" } };
    ex.transformRequest("deepseek-v4-flash-free", body, true, cred);
    const h1 = ex.buildHeaders(cred);
    ex.transformRequest("deepseek-v4-flash-free", body, true, cred);
    const h2 = ex.buildHeaders(cred);
    expect(h1["x-opencode-session"]).toBe(h2["x-opencode-session"]);
  });

  it("caps Responses tool declarations and calls at 64 while preserving named choice", () => {
    const ex = new OpenCodeExecutor();
    const longName = `tool-${"x".repeat(100)}`;
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", name: longName, call_id: "c1", arguments: "{}" },
      ],
      tools: [{ type: "function", name: longName, parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "function", name: longName },
    };

    const out = ex.transformRequest("muse-spark-1.2-contributor-free", body, true, {});

    expect(out.tools[0].name).toHaveLength(64);
    expect(out.input.find((item) => item.type === "function_call").name).toHaveLength(64);
    expect(out.tool_choice).toEqual({ type: "function", name: out.tools[0].name });
  });

  it("accepts a pre-truncated named choice for a capped declaration", () => {
    const ex = new OpenCodeExecutor();
    const longName = `tool-${"x".repeat(100)}`;
    const cappedName = longName.slice(0, 64);
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: longName, parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "function", name: cappedName },
    };

    const out = ex.transformRequest("muse-spark-1.2-contributor-free", body, true, {});

    expect(out.tool_choice).toEqual({ type: "function", name: cappedName });
  });

  it("drops later declarations that collide after the 64-character cap", () => {
    const ex = new OpenCodeExecutor();
    const prefix = "x".repeat(64);
    const first = `${prefix}-first`;
    const second = `${prefix}-second`;
    const base = { type: "object", properties: {} };
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        { type: "function", name: first, parameters: base },
        { type: "function", name: second, parameters: base },
      ],
      tool_choice: { type: "function", name: second },
    };

    const out = ex.transformRequest("muse-spark-1.2-contributor-free", body, true, {});

    expect(out.tools.map((tool) => tool.name)).toEqual([prefix, "bash", "glob", "grep", "read"]);
    expect(out.tool_choice).toBeUndefined();
  });
});

describe("OpenCodeExecutor upstream retry and metadata", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries only OpenCode HTTP 500 twice with one-second delays", async () => {
    vi.useFakeTimers();
    const response = (status) => ({ status, headers: { get: () => "" } });
    proxyAwareFetch
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(200));
    const log = { debug: vi.fn() };
    const promise = new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "secret prompt" }] }] },
      stream: true,
      credentials: {},
      log,
    });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.response.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    expect(log.debug.mock.calls.filter(([tag]) => tag === "RETRY")).toHaveLength(2);
    expect(log.debug.mock.calls.filter(([tag]) => tag === "RETRY").map(([, message]) => message))
      .toEqual(["status 500 retry 1/2 after 1s", "status 500 retry 2/2 after 1s"]);
    const retryLog = JSON.stringify(log.debug.mock.calls);
    expect(retryLog).not.toContain("secret prompt");
  });

  it("returns final OpenCode 500 after bounded retries", async () => {
    vi.useFakeTimers();
    proxyAwareFetch.mockResolvedValue({ status: 500, headers: { get: () => "" } });
    const promise = new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "secret prompt" }] }] },
      stream: true,
      credentials: {},
    });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.response.status).toBe(500);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
  });

  it("does not add HTTP 500 retries to another provider", async () => {
    proxyAwareFetch.mockResolvedValue({ status: 500, headers: { get: () => "" } });
    const result = await new DefaultExecutor("openai").execute({
      model: "gpt-test",
      body: { messages: [{ role: "user", content: "secret prompt" }] },
      stream: true,
      credentials: {},
    });

    expect(result.response.status).toBe(500);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("logs safe upstream metadata without prompt, tool arguments, session, or key", async () => {
    proxyAwareFetch.mockResolvedValue({ status: 200, headers: { get: () => "" } });
    const log = { debug: vi.fn() };
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "secret prompt" }] }],
      tools: [{ type: "function", name: "agent", parameters: { type: "object", properties: {} } }],
      session_id: "session-secret",
    };
    const result = await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free",
      body,
      stream: true,
      credentials: { apiKey: "sk-secret", rawHeaders: { "x-opencode-session": "ses-secret" } },
      log,
    });

    const metadata = log.debug.mock.calls.find(([tag]) => tag === "OPENCODE");
    expect(metadata).toBeDefined();
    const text = JSON.stringify(metadata);
    expect(text).toContain("muse-spark-1.3-contributor-free");
    expect(text).toContain("200");
    expect(text).toContain("opencode.ai/zen/v1/responses");
    expect(text).toContain("bodyBytes");
    expect(text).not.toContain("secret prompt");
    expect(text).not.toContain("session-secret");
    expect(text).not.toContain("ses-secret");
    expect(text).not.toContain("sk-secret");
    expect(result.response.status).toBe(200);
  });
});
describe("OpenCodeExecutor.buildUrl (runtimeTransport)", () => {
  it("uses runtimeTransport baseUrl when present (free Responses model)", () => {
    const ex = new OpenCodeExecutor();
    const url = ex.buildUrl("muse-spark-1.2-contributor-free", true, 0, { runtimeTransport: { baseUrl: "https://opencode.ai/zen/v1/responses" } });
    expect(url).toBe("https://opencode.ai/zen/v1/responses");
  });

  it("appends urlSuffix when runtimeTransport carries one", () => {
    const ex = new OpenCodeExecutor();
    const url = ex.buildUrl("muse-spark-1.2-contributor-free", true, 0, { runtimeTransport: { baseUrl: "https://opencode.ai/zen/v1", urlSuffix: "/responses" } });
    expect(url).toBe("https://opencode.ai/zen/v1/responses");
  });

  it("keeps /zen/v1/chat/completions for models without a runtime transport", () => {
    const ex = new OpenCodeExecutor();
    expect(ex.buildUrl("deepseek-v4-flash", true, 0, {})).toBe("https://opencode.ai/zen/v1/chat/completions");
  });
});
