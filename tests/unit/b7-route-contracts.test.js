// B7: route contracts — provider POST priority validation/conflict, claude-settings token merge.
import { describe, it, expect, vi, beforeEach } from "vitest";

const nextMocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
}));
const providerMocks = vi.hoisted(() => ({
  createProviderConnection: vi.fn(),
}));
const claudeMocks = vi.hoisted(() => ({
  store: { settings: null, writeError: null },
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: nextMocks.json } }));

vi.mock("@/models", () => ({
  createProviderConnection: providerMocks.createProviderConnection,
  getProviderConnections: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(async () => null),
  getProviderNodes: vi.fn(async () => []),
  getProviderNodeById: vi.fn(async () => null),
  getProxyPools: vi.fn(async () => []),
  getProxyPoolById: vi.fn(async () => null),
  updateProviderConnection: vi.fn(async () => null),
  deleteProviderConnection: vi.fn(async () => null),
}));

vi.mock("fs/promises", () => ({
  default: { readFile: claudeMocks.readFile, writeFile: claudeMocks.writeFile, mkdir: claudeMocks.mkdir, access: vi.fn() },
}));

const { POST: providersPOST } = await import("../../src/app/api/providers/route.js");
const { POST: claudePOST } = await import("../../src/app/api/cli-tools/claude-settings/route.js");

const req = (body) => new Request("http://localhost/api/providers", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// "openai" is a plain APIKEY provider: no node lookup, straight to repository.
const basePayload = { provider: "openai", apiKey: "fixture-key", name: "synthetic-x" };

describe("POST /api/providers priority + conflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.createProviderConnection.mockResolvedValue({ id: "c1", apiKey: "fixture-key" });
  });

  it.each([
    [undefined, undefined],
    [null, undefined],
    ["", undefined],
    [1, 1],
    ["7", 7],
    [1000000, 1000000],
  ])("accepts %p and forwards priority %p with 201", async (input, expected) => {
    const res = await providersPOST(req({ ...basePayload, priority: input }));
    expect(res.status).toBe(201);
    expect(providerMocks.createProviderConnection).toHaveBeenCalledTimes(1);
    expect(providerMocks.createProviderConnection.mock.calls[0][0].priority).toBe(expected);
    expect(providerMocks.createProviderConnection.mock.calls[0][0].apiKey).toBe("fixture-key");
  });

  it.each([[true], [false], [[]], [{}], [0], [-1], [1.5], ["nope"], ["Infinity"], [1000001]])(
    "rejects %p with 400 and never calls the repository",
    async (input) => {
      const res = await providersPOST(req({ ...basePayload, priority: input }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid priority/);
      expect(providerMocks.createProviderConnection).not.toHaveBeenCalled();
    }
  );

  it("maps typed name conflict to 409 with existing id/name, no key leak", async () => {
    const err = new Error("exists");
    err.code = "PROVIDER_NAME_CONFLICT";
    err.existingId = "conn-1";
    err.existingName = "Key 1";
    providerMocks.createProviderConnection.mockRejectedValue(err);
    const res = await providersPOST(req(basePayload));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "PROVIDER_NAME_CONFLICT", existingId: "conn-1", existingName: "Key 1" });
    expect(JSON.stringify(res.body)).not.toContain("fixture-key");
  });

  it("handles allowOverwrite opt-ins and defaults", async () => {
    // Default without id
    await providersPOST(req(basePayload));
    expect(providerMocks.createProviderConnection.mock.calls[0][0].allowOverwrite).toBe(false);

    // Explicit body.id
    providerMocks.createProviderConnection.mockClear();
    await providersPOST(req({ ...basePayload, id: "c1" }));
    expect(providerMocks.createProviderConnection.mock.calls[0][0].allowOverwrite).toBe(true);

    // Explicit allowOverwrite
    providerMocks.createProviderConnection.mockClear();
    await providersPOST(req({ ...basePayload, allowOverwrite: true }));
    expect(providerMocks.createProviderConnection.mock.calls[0][0].allowOverwrite).toBe(true);

    // Explicit overwrite
    providerMocks.createProviderConnection.mockClear();
    await providersPOST(req({ ...basePayload, overwrite: true }));
    expect(providerMocks.createProviderConnection.mock.calls[0][0].allowOverwrite).toBe(true);
  });

  it("redacts apiKey from success 201 response", async () => {
    providerMocks.createProviderConnection.mockResolvedValue({ id: "c1", provider: "openai", apiKey: "super-secret" });
    const res = await providersPOST(req(basePayload));
    expect(res.status).toBe(201);
    expect(res.body.connection.apiKey).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("super-secret");
  });

  it("keeps generic 500 for other errors", async () => {
    providerMocks.createProviderConnection.mockRejectedValue(new Error("db down"));
    const res = await providersPOST(req(basePayload));
    expect(res.status).toBe(500);
  });
});

const creq = (body) => new Request("http://localhost/api/cli-tools/claude-settings", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST claude-settings token preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claudeMocks.store.settings = null;
    claudeMocks.store.writeError = null;
    claudeMocks.readFile.mockImplementation(async () => {
      if (claudeMocks.store.settings === null) {
        const e = new Error("missing");
        e.code = "ENOENT";
        throw e;
      }
      return JSON.stringify(claudeMocks.store.settings);
    });
    claudeMocks.writeFile.mockImplementation(async (p, data) => {
      if (claudeMocks.store.writeError) throw claudeMocks.store.writeError;
      claudeMocks.store.settings = JSON.parse(data);
    });
    claudeMocks.mkdir.mockResolvedValue(undefined);
  });

  it("omitted token keeps the existing real token", async () => {
    claudeMocks.store.settings = { env: { ANTHROPIC_BASE_URL: "http://x/v1", ANTHROPIC_AUTH_TOKEN: "existing-real" } };
    const res = await claudePOST(creq({ env: { ANTHROPIC_BASE_URL: "http://x" } }));
    expect(res.status).toBe(200);
    expect(claudeMocks.store.settings.env.ANTHROPIC_AUTH_TOKEN).toBe("existing-real");
    expect(claudeMocks.store.settings.env.ANTHROPIC_BASE_URL).toBe("http://x/v1");
  });

  it("dummy sk_9router does not overwrite a real token", async () => {
    claudeMocks.store.settings = { env: { ANTHROPIC_AUTH_TOKEN: "existing-real" } };
    await claudePOST(creq({ env: { ANTHROPIC_AUTH_TOKEN: "sk_9router" } }));
    expect(claudeMocks.store.settings.env.ANTHROPIC_AUTH_TOKEN).toBe("existing-real");
  });

  it("explicit new token replaces the existing one", async () => {
    claudeMocks.store.settings = { env: { ANTHROPIC_AUTH_TOKEN: "existing-real" } };
    await claudePOST(creq({ env: { ANTHROPIC_AUTH_TOKEN: "new-real" } }));
    expect(claudeMocks.store.settings.env.ANTHROPIC_AUTH_TOKEN).toBe("new-real");
  });

  it("dummy with no existing token is preserved as-is", async () => {
    claudeMocks.store.settings = null;
    await claudePOST(creq({ env: { ANTHROPIC_AUTH_TOKEN: "sk_9router", ANTHROPIC_BASE_URL: "http://x" } }));
    expect(claudeMocks.store.settings.env.ANTHROPIC_AUTH_TOKEN).toBe("sk_9router");
  });

  it("omitted with no existing token creates no token", async () => {
    claudeMocks.store.settings = null;
    await claudePOST(creq({ env: { ANTHROPIC_BASE_URL: "http://x" } }));
    expect("ANTHROPIC_AUTH_TOKEN" in claudeMocks.store.settings.env).toBe(false);
  });

  it("write errors surface a 500 and keep other env keys", async () => {
    claudeMocks.store.settings = { env: { OTHER: "keep", ANTHROPIC_AUTH_TOKEN: "existing-real" } };
    claudeMocks.store.writeError = new Error("disk full");
    const res = await claudePOST(creq({ env: { OTHER: "keep" } }));
    expect(res.status).toBe(500);
  });
});
