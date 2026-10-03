import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing pingModelByKind
vi.mock("@/lib/localDb", () => ({
  getApiKeys: vi.fn().mockResolvedValue([{ key: "test-sk-key-12345", isActive: true }]),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn().mockResolvedValue("mock-machine-id-hash"),
}));

import { pingModelByKind } from "../../src/app/api/models/test/ping.js";

describe("B8a System One ping probe", () => {
  const syntheticBaseUrl = "http://127.0.0.1:39129";
  let origFetch;
  let capturedRequests = [];

  beforeEach(() => {
    capturedRequests = [];
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("probes System One models via /api/v1/systemone with state and questions", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedRequests.push({ url, opts, body: JSON.parse(opts.body || "{}") });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          answers: {
            probe: { value: "yes", explanation: "Billing inquiry detected" },
          },
        }),
      };
    });

    const result = await pingModelByKind("so/system-one-v1", "systemone", syntheticBaseUrl);

    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0].url).toBe(`${syntheticBaseUrl}/api/v1/systemone`);
    expect(capturedRequests[0].opts.method).toBe("POST");
    expect(capturedRequests[0].body.model).toBe("so/system-one-v1");
    expect(capturedRequests[0].body.state).toContain("Customer: I was charged twice");
    expect(capturedRequests[0].body.questions).toBeDefined();
    expect(capturedRequests[0].body.questions.probe.type).toBe("noul");
    expect(capturedRequests[0].opts.headers["x-9r-cli-token"]).toBe("mock-machine-id-hash");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    expect(typeof result.latencyMs).toBe("number");
  });

  it("returns error when System One provider returns 200 but empty answers", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedRequests.push({ url, opts });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ answers: {} }),
      };
    });

    const result = await pingModelByKind("so/system-one-v1", "systemone", syntheticBaseUrl);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.error).toBe("Provider returned no answers for this model");
  });

  it("returns error on HTTP 500 failure from /api/v1/systemone", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedRequests.push({ url, opts });
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: "Internal System One provider failure" } }),
      };
    });

    const result = await pingModelByKind("so/system-one-v1", "systemone", syntheticBaseUrl);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain("HTTP 500: Internal System One provider failure");
  });

  it("preserves chat probe behavior for non-systemone kinds", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedRequests.push({ url, opts });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
        }),
      };
    });

    const result = await pingModelByKind("oa/gpt-4o", "chat", syntheticBaseUrl);

    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0].url).toBe(`${syntheticBaseUrl}/api/v1/chat/completions`);
    expect(result.ok).toBe(true);
  });
});
