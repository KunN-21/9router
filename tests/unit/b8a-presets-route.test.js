import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing route handlers
vi.mock("@/lib/localDb", () => ({
  getCombos: vi.fn(),
  createCombo: vi.fn(),
  getProviderConnections: vi.fn(),
}));

vi.mock("open-sse/services/cursorModels.js", () => ({
  resolveCursorModels: vi.fn(),
}));

import { GET, POST } from "../../src/app/api/combos/presets/route.js";
import { getCombos, createCombo, getProviderConnections } from "@/lib/localDb";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";

describe("B8a Combos Presets API Route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/combos/presets", () => {
    it("returns 400 when source param is missing or invalid", async () => {
      const req1 = new Request("http://localhost/api/combos/presets");
      const res1 = await GET(req1);
      expect(res1.status).toBe(400);
      const data1 = await res1.json();
      expect(data1.error).toContain("source must be 'cursor' or 'claude'");

      const req2 = new Request("http://localhost/api/combos/presets?source=invalid-src");
      const res2 = await GET(req2);
      expect(res2.status).toBe(400);
    });

    it("returns preview items, toCreate, and toSkip for valid source", async () => {
      getCombos.mockResolvedValue([
        { id: "c1", name: "claude-opus-5", models: ["cc/claude-opus-5"] },
      ]);
      getProviderConnections.mockResolvedValue([]);

      const req = new Request("http://localhost/api/combos/presets?source=claude");
      const res = await GET(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.source).toBe("claude");
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBeGreaterThan(0);

      const opusItem = data.items.find((i) => i.name === "claude-opus-5");
      expect(opusItem).toBeDefined();
      expect(opusItem.exists).toBe(true);

      expect(typeof data.toCreate).toBe("number");
      expect(typeof data.toSkip).toBe("number");
      expect(data.toSkip).toBeGreaterThanOrEqual(1);
    });

    it("falls back to static catalog when cursor connection has no live models", async () => {
      getCombos.mockResolvedValue([]);
      getProviderConnections.mockResolvedValue([
        { provider: "cursor", isActive: true, accessToken: "token", providerSpecificData: {} },
      ]);
      resolveCursorModels.mockRejectedValue(new Error("Network unvailable"));

      const req = new Request("http://localhost/api/combos/presets?source=cursor");
      const res = await GET(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.source).toBe("cursor");
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items.every((i) => i.models[0].startsWith("cu/"))).toBe(true);
    });
  });

  describe("POST /api/combos/presets", () => {
    it("returns 400 for invalid source or malformed body", async () => {
      const req1 = new Request("http://localhost/api/combos/presets", {
        method: "POST",
        body: JSON.stringify({ source: "unsupported" }),
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(400);

      const req2 = new Request("http://localhost/api/combos/presets", {
        method: "POST",
        body: "invalid-json-body",
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(400);
    });

    it("creates missing combos and skips existing names without overwriting", async () => {
      getCombos.mockResolvedValue([
        { id: "c1", name: "claude-opus-5", models: ["cc/claude-opus-5"] },
      ]);
      getProviderConnections.mockResolvedValue([]);
      createCombo.mockImplementation(async ({ name, models }) => ({
        id: `created-${name}`,
        name,
        models,
      }));

      const req = new Request("http://localhost/api/combos/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "claude" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.source).toBe("claude");
      expect(data.skipped).toContain("claude-opus-5");
      expect(data.created.length).toBeGreaterThan(0);
      expect(data.createdCount).toBe(data.created.length);
      expect(data.skippedCount).toBe(data.skipped.length);

      // Verify createCombo was never called for existing name
      const calledNames = createCombo.mock.calls.map(([arg]) => arg.name);
      expect(calledNames).not.toContain("claude-opus-5");
    });
  });
});
