import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ providerStrategies: {}, calls: [] }));
vi.mock("@/lib/db/index.js", () => ({
  getSettings: async () => ({ providerStrategies: settings.providerStrategies }),
}));

// BaseExecutor reaches the network only through proxyAwareFetch, and that module
// captures globalThis.fetch at import time — stub the module, not global fetch.
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (_url, opts) => {
    settings.calls.push({ headers: { ...(opts?.headers || {}) }, body: opts?.body });
    const script = settings.script;
    const next = script[Math.min(settings.calls.length - 1, script.length - 1)];
    return typeof next === "function" ? next() : next;
  },
  applyHeaderOverrides: (h) => h,
  normalizeProxyUrl: (u) => u,
}));

const { OpenCodeExecutor, OPENCODE_SESSION_RE } = await import("open-sse/executors/opencode.js");

function okResponse() {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function quotaResponse(cap, retryAfter = 3600) {
  return new Response(JSON.stringify({
    type: "error",
    error: { type: "RateLimit.FreeUsageLimitError", message: "free usage limit" },
    retryAfter,
    ...(cap ? { cap } : {}),
  }), { status: 429, headers: { "content-type": "application/json" } });
}

async function runExecutor({ script, credentials = { rawHeaders: {} } }) {
  settings.calls = [];
  settings.script = script;
  const executor = new OpenCodeExecutor();
  const result = await executor.execute({
    model: "deepseek-v4.1-flash-free",
    body: { model: "deepseek-v4.1-flash-free", messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials,
    log: { debug: () => {} },
  });
  return { result, calls: settings.calls };
}

const MODEL_CAP = { reason: "requests", scope: "model", limit: 100, usage: 100 };
const SHARED_CAP = { reason: "requests", scope: "shared", limit: 500, usage: 500 };

describe("OpenCode 429 session rotation", () => {
  beforeEach(() => {
    settings.providerStrategies = {};
  });

  it("does not rotate when the operator knob is off", async () => {
    const { result, calls } = await runExecutor({ script: [quotaResponse(MODEL_CAP)] });
    expect(result.response.status).toBe(429);
    expect(calls.length).toBe(1);
  });

  it("rotates session and retries when enabled and scope is model", async () => {
    settings.providerStrategies = { opencode: { rotateSessionOn429: true } };
    const { result, calls } = await runExecutor({
      script: [quotaResponse(MODEL_CAP), okResponse()],
    });
    expect(result.response.status).toBe(200);
    expect(calls.length).toBe(2);
    const [first, second] = calls;
    expect(first.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(second.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(second.headers["x-opencode-session"]).not.toBe(first.headers["x-opencode-session"]);
    // Identity rotation is a separate knob — project stays default here.
    expect(second.headers["x-opencode-project"]).toBe("global");
  });

  it("skips rotation for a shared-scope cap", async () => {
    settings.providerStrategies = { opencode: { rotateSessionOn429: true } };
    const { result, calls } = await runExecutor({ script: [quotaResponse(SHARED_CAP)] });
    expect(result.response.status).toBe(429);
    expect(calls.length).toBe(1);
  });

  it("rotates the project id only when identity rotation is also on", async () => {
    settings.providerStrategies = { opencode: { rotateSessionOn429: true, rotateIdentityOn429: true } };
    const { result, calls } = await runExecutor({
      script: [quotaResponse(MODEL_CAP), okResponse()],
    });
    expect(result.response.status).toBe(200);
    const project = calls[1].headers["x-opencode-project"];
    expect(project).toMatch(/^[0-9a-f]{64}$/);
    expect(project).not.toBe("global");
  });

  it("stops after MAX_ROTATION_ATTEMPTS when every retry is still 429", async () => {
    settings.providerStrategies = { opencode: { rotateSessionOn429: true } };
    const capped = () => quotaResponse(MODEL_CAP);
    const { result, calls } = await runExecutor({
      script: [capped(), capped(), capped(), capped(), capped()],
    });
    expect(result.response.status).toBe(429);
    // 1 original + 3 rotations
    expect(calls.length).toBe(4);
  });

  it("keeps a client-supplied native session across rotation", async () => {
    settings.providerStrategies = { opencode: { rotateSessionOn429: true } };
    const native = "ses_0123456789ab" + "A".repeat(14);
    const { calls } = await runExecutor({
      script: [quotaResponse(MODEL_CAP), okResponse()],
      credentials: { rawHeaders: { "x-opencode-session": native } },
    });
    expect(calls[0].headers["x-opencode-session"]).toBe(native);
    expect(calls[1].headers["x-opencode-session"]).toBe(native);
  });
});
