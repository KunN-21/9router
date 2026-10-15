import { describe, it, expect, vi, beforeEach } from "vitest";

const nextMocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
    json: async () => body,
  })),
}));

const modelsMocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getProxyPoolById: vi.fn(),
  updateProviderConnection: vi.fn(),
  deleteProviderConnection: vi.fn(),
}));

const localDbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
}));

const oauthMocks = vi.hoisted(() => ({
  backfillCodexEmails: vi.fn(async () => {}),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: nextMocks.json,
  },
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: modelsMocks.getProviderConnectionById,
  getProxyPoolById: modelsMocks.getProxyPoolById,
  updateProviderConnection: modelsMocks.updateProviderConnection,
  deleteProviderConnection: modelsMocks.deleteProviderConnection,
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: localDbMocks.getProviderConnections,
}));

vi.mock("@/lib/oauth/providers", () => ({
  backfillCodexEmails: oauthMocks.backfillCodexEmails,
}));

const { PUT: providerPUT } = await import("../../src/app/api/providers/[id]/route.js");
const { GET: clientGET } = await import("../../src/app/api/providers/client/route.js");

function makePutRequest(id, body) {
  return new Request(`http://localhost/api/providers/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callPut(id, body) {
  const req = makePutRequest(id, body);
  return await providerPUT(req, { params: Promise.resolve({ id }) });
}

describe("PUT /api/providers/[id] codexFastMode strict boolean validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelsMocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_synthetic_codex_01",
      provider: "codex",
      authType: "oauth",
      isActive: true,
      providerSpecificData: {
        workspaceId: "ws_synthetic_01",
      },
    });
    modelsMocks.updateProviderConnection.mockImplementation(async (id, data) => ({
      id,
      provider: "codex",
      ...data,
    }));
  });

  it.each([
    ["string true", "true"],
    ["string false", "false"],
    ["number 1", 1],
    ["number 0", 0],
    ["null", null],
    ["object", {}],
    ["array", []],
  ])("rejects non-boolean root codexFastMode (%s) with 400", async (_, value) => {
    const res = await callPut("conn_synthetic_codex_01", { codexFastMode: value });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("codexFastMode must be a boolean");
    expect(modelsMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["string true", "true"],
    ["string false", "false"],
    ["number 1", 1],
    ["number 0", 0],
    ["null", null],
    ["object", {}],
    ["array", []],
  ])("rejects non-boolean nested providerSpecificData.codexFastMode (%s) with 400", async (_, value) => {
    const res = await callPut("conn_synthetic_codex_01", {
      providerSpecificData: { codexFastMode: value },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("codexFastMode must be a boolean");
    expect(modelsMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects conflicting root and nested codexFastMode values (true vs false) with 400", async () => {
    const res = await callPut("conn_synthetic_codex_01", {
      codexFastMode: true,
      providerSpecificData: { codexFastMode: false },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Conflicting codexFastMode values in root and providerSpecificData");
    expect(modelsMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects conflicting root and nested codexFastMode values (false vs true) with 400", async () => {
    const res = await callPut("conn_synthetic_codex_01", {
      codexFastMode: false,
      providerSpecificData: { codexFastMode: true },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Conflicting codexFastMode values in root and providerSpecificData");
    expect(modelsMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("accepts matching root and nested codexFastMode booleans (both true)", async () => {
    const res = await callPut("conn_synthetic_codex_01", {
      codexFastMode: true,
      providerSpecificData: { codexFastMode: true },
    });
    expect(res.status).toBe(200);
    expect(modelsMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData.codexFastMode).toBe(true);
  });

  it("accepts matching root and nested codexFastMode booleans (both false)", async () => {
    const res = await callPut("conn_synthetic_codex_01", {
      codexFastMode: false,
      providerSpecificData: { codexFastMode: false },
    });
    expect(res.status).toBe(200);
    expect(modelsMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData.codexFastMode).toBe(false);
  });
});

describe("PUT /api/providers/[id] codexFastMode persistence and merging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelsMocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_synthetic_codex_01",
      provider: "codex",
      authType: "oauth",
      isActive: true,
      providerSpecificData: {
        workspaceId: "ws_synthetic_01",
      },
    });
    modelsMocks.updateProviderConnection.mockImplementation(async (id, data) => ({
      id,
      provider: "codex",
      ...data,
    }));
  });

  it("persists root codexFastMode: true for codex provider", async () => {
    const res = await callPut("conn_synthetic_codex_01", { codexFastMode: true });
    expect(res.status).toBe(200);
    expect(modelsMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData.codexFastMode).toBe(true);
    expect(updateArg.providerSpecificData.workspaceId).toBe("ws_synthetic_01");
  });

  it("persists root codexFastMode: false for codex provider", async () => {
    const res = await callPut("conn_synthetic_codex_01", { codexFastMode: false });
    expect(res.status).toBe(200);
    expect(modelsMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData.codexFastMode).toBe(false);
  });

  it("persists nested providerSpecificData.codexFastMode: true for codex provider", async () => {
    const res = await callPut("conn_synthetic_codex_01", {
      providerSpecificData: { codexFastMode: true },
    });
    expect(res.status).toBe(200);
    expect(modelsMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData.codexFastMode).toBe(true);
  });

  it("persists nested providerSpecificData.codexFastMode: false for codex provider", async () => {
    const res = await callPut("conn_synthetic_codex_01", {
      providerSpecificData: { codexFastMode: false },
    });
    expect(res.status).toBe(200);
    expect(modelsMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData.codexFastMode).toBe(false);
  });

  it("initializes providerSpecificData when existing connection has no PSD", async () => {
    modelsMocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_synthetic_codex_02",
      provider: "codex",
      authType: "oauth",
      isActive: true,
    });
    const res = await callPut("conn_synthetic_codex_02", { codexFastMode: true });
    expect(res.status).toBe(200);
    expect(modelsMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData).toEqual({ codexFastMode: true });
  });

  it("preserves unrelated existing providerSpecificData metadata when setting codexFastMode", async () => {
    modelsMocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_synthetic_codex_01",
      provider: "codex",
      authType: "oauth",
      providerSpecificData: {
        workspaceId: "ws_keep_me",
        proxyPoolId: "pool_keep_me",
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.local:8080",
        connectionNoProxy: "localhost",
      },
    });
    const res = await callPut("conn_synthetic_codex_01", { codexFastMode: true });
    expect(res.status).toBe(200);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData).toMatchObject({
      workspaceId: "ws_keep_me",
      proxyPoolId: "pool_keep_me",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:8080",
      connectionNoProxy: "localhost",
      codexFastMode: true,
    });
  });

  it("preserves existing codexFastMode when request omits codexFastMode", async () => {
    modelsMocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_synthetic_codex_01",
      provider: "codex",
      authType: "oauth",
      providerSpecificData: {
        codexFastMode: true,
        workspaceId: "ws_synthetic_01",
      },
    });
    const res = await callPut("conn_synthetic_codex_01", { name: "Updated Name" });
    expect(res.status).toBe(200);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    if (updateArg.providerSpecificData) {
      expect(updateArg.providerSpecificData.codexFastMode).toBe(true);
    }
  });

  it("does not persist codexFastMode for non-codex provider (root payload)", async () => {
    modelsMocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_synthetic_anthropic_01",
      provider: "anthropic",
      authType: "apikey",
      providerSpecificData: {
        customKey: "preserved_custom_value",
      },
    });
    const res = await callPut("conn_synthetic_anthropic_01", {
      name: "Anthropic Provider",
      codexFastMode: true,
    });
    expect(res.status).toBe(200);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData?.codexFastMode).toBeUndefined();
    if (updateArg.providerSpecificData) {
      expect(updateArg.providerSpecificData.customKey).toBe("preserved_custom_value");
    }
  });

  it("does not persist codexFastMode for non-codex provider (nested payload spread)", async () => {
    modelsMocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_synthetic_anthropic_01",
      provider: "anthropic",
      authType: "apikey",
      providerSpecificData: {
        customKey: "preserved_custom_value",
      },
    });
    const res = await callPut("conn_synthetic_anthropic_01", {
      name: "Anthropic Provider",
      providerSpecificData: {
        codexFastMode: true,
        extraConfig: "extra_value",
      },
    });
    expect(res.status).toBe(200);
    const updateArg = modelsMocks.updateProviderConnection.mock.calls[0][1];
    expect(updateArg.providerSpecificData?.codexFastMode).toBeUndefined();
    expect(updateArg.providerSpecificData?.extraConfig).toBe("extra_value");
    expect(updateArg.providerSpecificData?.customKey).toBe("preserved_custom_value");
  });

  it("strips sensitive credentials from PUT response", async () => {
    modelsMocks.updateProviderConnection.mockResolvedValue({
      id: "conn_synthetic_codex_01",
      provider: "codex",
      name: "Synthetic Codex",
      apiKey: "sk-super-secret-key",
      accessToken: "token-secret-access",
      refreshToken: "token-secret-refresh",
      idToken: "token-secret-id",
      providerSpecificData: {
        codexFastMode: true,
      },
    });
    const res = await callPut("conn_synthetic_codex_01", { codexFastMode: true });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connection).toBeDefined();
    expect(data.connection.apiKey).toBeUndefined();
    expect(data.connection.accessToken).toBeUndefined();
    expect(data.connection.refreshToken).toBeUndefined();
    expect(data.connection.idToken).toBeUndefined();
    expect(data.connection.providerSpecificData.codexFastMode).toBe(true);
  });

  it("returns 404 when connection does not exist", async () => {
    modelsMocks.getProviderConnectionById.mockResolvedValue(null);
    const res = await callPut("non_existent_id", { codexFastMode: true });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Connection not found");
  });
});

describe("GET /api/providers/client SAFE_PSD_FIELDS projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects codexFastMode: true for eligible codex connection", async () => {
    localDbMocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn_synthetic_codex_01",
        provider: "codex",
        authType: "oauth",
        name: "My Codex Account",
        isActive: true,
        priority: 1,
        apiKey: "sk-secret-leaked-if-not-sanitized",
        providerSpecificData: {
          codexFastMode: true,
          internalSecret: "must-be-stripped",
        },
      },
    ]);

    const req = new Request("http://localhost/api/providers/client");
    const res = await clientGET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connections).toHaveLength(1);
    const conn = data.connections[0];
    expect(conn.id).toBe("conn_synthetic_codex_01");
    expect(conn.apiKey).toBeUndefined();
    expect(conn.providerSpecificData).toBeDefined();
    expect(conn.providerSpecificData.codexFastMode).toBe(true);
    expect(conn.providerSpecificData.internalSecret).toBeUndefined();
  });

  it("projects codexFastMode: false for eligible codex connection", async () => {
    localDbMocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn_synthetic_codex_02",
        provider: "codex",
        authType: "oauth",
        name: "My Codex Account 2",
        isActive: true,
        priority: 2,
        providerSpecificData: {
          codexFastMode: false,
        },
      },
    ]);

    const req = new Request("http://localhost/api/providers/client");
    const res = await clientGET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connections).toHaveLength(1);
    const conn = data.connections[0];
    expect(conn.providerSpecificData).toBeDefined();
    expect(conn.providerSpecificData.codexFastMode).toBe(false);
  });

  it("omits codexFastMode when not present in connection providerSpecificData", async () => {
    localDbMocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn_synthetic_codex_03",
        provider: "codex",
        authType: "oauth",
        name: "My Codex Account 3",
        isActive: true,
        priority: 3,
        providerSpecificData: {
          workspaceId: "ws_keep",
        },
      },
    ]);

    const req = new Request("http://localhost/api/providers/client");
    const res = await clientGET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connections).toHaveLength(1);
    const conn = data.connections[0];
    expect(conn.providerSpecificData).toBeDefined();
    expect("codexFastMode" in conn.providerSpecificData).toBe(false);
  });
});
