import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseClaudeResetGrants } from "../../open-sse/services/usage/claude.js";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  consumeClaudeResetGrant: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

vi.mock("open-sse/services/usage.js", () => ({
  consumeClaudeResetGrant: mocks.consumeClaudeResetGrant,
}));

describe("parseClaudeResetGrants (B6DG1 pure parser cases)", () => {
  it("sums usable grants and picks next_grant_id", () => {
    const r = parseClaudeResetGrants({
      eligible: true,
      next_grant_id: "g2",
      grants: [
        { id: "g1", resets_left: 1, ends_at: "2026-10-01T00:00:00Z" },
        { id: "g2", resets_left: 2, ends_at: "2026-10-22T00:00:00Z", clears: ["five_hour", "seven_day"] },
        { id: "g3", resets_left: 5, paused: true },
      ],
    });
    expect(r).toMatchObject({ availableCount: 3, nextGrantId: "g2", expiresAt: "2026-10-22T00:00:00Z" });
    expect(r.grants.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect(r.grants[1].clears).toEqual(["five_hour", "seven_day"]);
  });

  it("returns null when ineligible or missing", () => {
    expect(parseClaudeResetGrants(undefined)).toBeNull();
    expect(parseClaudeResetGrants(null)).toBeNull();
    expect(parseClaudeResetGrants({})).toBeNull();
    expect(parseClaudeResetGrants("not-an-object")).toBeNull();
    expect(parseClaudeResetGrants({ eligible: false, grants: [] })).toBeNull();
    expect(parseClaudeResetGrants({ eligible: true, grants: null })).toBeNull();
    expect(parseClaudeResetGrants({ eligible: true, grants: "invalid" })).toBeNull();
  });

  it("handles string numeric resets_left and resets_total", () => {
    const r = parseClaudeResetGrants({
      eligible: true,
      next_grant_id: "g_str",
      grants: [
        { id: "g_str", resets_left: "4", resets_total: "10" },
      ],
    });
    expect(r.availableCount).toBe(4);
    expect(r.grants[0].resetsLeft).toBe(4);
    expect(r.grants[0].resetsTotal).toBe(10);
  });

  it("excludes paused and non-positive grants from availableCount", () => {
    const r = parseClaudeResetGrants({
      eligible: true,
      grants: [
        { id: "p1", resets_left: 3, paused: true },
        { id: "z1", resets_left: 0 },
        { id: "n1", resets_left: -1 },
        { id: "v1", resets_left: 2 },
      ],
    });
    expect(r.availableCount).toBe(2);
    expect(r.nextGrantId).toBe("v1");
  });

  it("falls back to first usable grant if next_grant_id is not in unpaused grants", () => {
    const r = parseClaudeResetGrants({
      eligible: true,
      next_grant_id: "missing_grant",
      grants: [
        { id: "g_first", resets_left: 1 },
        { id: "g_second", resets_left: 2 },
      ],
    });
    expect(r.nextGrantId).toBe("g_first");
  });

  it("returns availableCount 0 and nextGrantId null when all grants are paused or exhausted", () => {
    const r = parseClaudeResetGrants({
      eligible: true,
      next_grant_id: "g_paused",
      grants: [
        { id: "g_paused", resets_left: 2, paused: true },
        { id: "g_empty", resets_left: 0 },
      ],
    });
    expect(r.availableCount).toBe(0);
    expect(r.nextGrantId).toBeNull();
  });
});

describe("POST /api/usage/[connectionId]/claude-reset (B6DG2 input validation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  const invalidGrantIds = [
    { desc: "missing", value: undefined },
    { desc: "null", value: null },
    { desc: "empty string", value: "" },
    { desc: "contains special characters", value: "grant@reset!" },
    { desc: "exceeds 40 chars", value: "a".repeat(41) },
    { desc: "contains whitespace", value: "grant id" },
  ];

  it.each(invalidGrantIds)("returns 400 when grantId is $desc without calling network/credentials", async ({ value }) => {
    const connection = {
      id: "conn_claude_1",
      provider: "claude",
      authType: "oauth",
      accessToken: "claude-token-old",
      refreshToken: "claude-refresh-old",
      providerSpecificData: {},
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);

    const { POST } = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
    const req = new Request("http://localhost/api/usage/conn_claude_1/claude-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value !== undefined ? { grantId: value } : {}),
    });

    const res = await POST(req, {
      params: Promise.resolve({ connectionId: "conn_claude_1" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid reset grant id." });
    expect(mocks.refreshAndUpdateCredentials).not.toHaveBeenCalled();
    expect(mocks.consumeClaudeResetGrant).not.toHaveBeenCalled();
  });

  it("calls refreshAndUpdateCredentials and consumeClaudeResetGrant on valid grantId", async () => {
    const connection = {
      id: "conn_claude_1",
      provider: "claude",
      authType: "oauth",
      accessToken: "claude-token-old",
      refreshToken: "claude-refresh-old",
      providerSpecificData: {},
    };
    const refreshed = { ...connection, accessToken: "claude-token-new" };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.refreshAndUpdateCredentials.mockResolvedValue({ connection: refreshed });
    mocks.consumeClaudeResetGrant.mockResolvedValue({ ok: true, result: "reset", resetsLeft: 1 });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
    const req = new Request("http://localhost/api/usage/conn_claude_1/claude-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grantId: "valid_grant-123" }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ connectionId: "conn_claude_1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: "reset", resetsLeft: 1 });
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledWith(connection, false, expect.any(Object));
    expect(mocks.consumeClaudeResetGrant).toHaveBeenCalledWith("claude-token-new", "valid_grant-123", expect.any(Object));
  });
});
