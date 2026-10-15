import { describe, it, expect, beforeAll } from "vitest";

describe("Provider Overrides API & Atomic Storage", () => {
  let routeModule = null;
  let settingsRouteModule = null;
  let dbModule = null;
  let dashboardGuardModule = null;
  let sessionModule = null;
  let machineIdModule = null;

  beforeAll(async () => {
    try {
      routeModule = await import("../../src/app/api/providers/[id]/overrides/route.js");
    } catch {
      routeModule = null;
    }
    try {
      settingsRouteModule = await import("../../src/app/api/settings/route.js");
    } catch {
      settingsRouteModule = null;
    }
    try {
      dbModule = await import("../../src/lib/db/index.js");
    } catch {
      dbModule = null;
    }
    try {
      dashboardGuardModule = await import("../../src/dashboardGuard.js");
    } catch {
      dashboardGuardModule = null;
    }
    try {
      sessionModule = await import("../../src/lib/auth/dashboardSession.js");
    } catch {
      sessionModule = null;
    }
    try {
      machineIdModule = await import("../../src/shared/utils/machineId.js");
    } catch {
      machineIdModule = null;
    }
  });

  function getRoute() {
    expect(routeModule).not.toBeNull();
    expect(typeof routeModule?.GET).toBe("function");
    expect(typeof routeModule?.PUT).toBe("function");
    return routeModule;
  }

  function getSettingsRoute() {
    expect(settingsRouteModule).not.toBeNull();
    return settingsRouteModule;
  }

  function getDb() {
    expect(dbModule).not.toBeNull();
    expect(typeof dbModule?.updateProviderOverride).toBe("function");
    return dbModule;
  }

  function getGuard() {
    expect(dashboardGuardModule).not.toBeNull();
    return dashboardGuardModule;
  }

  function makeRequest(pathname, { method = "GET", headers = {}, body = null, cookies = {} } = {}) {
    const url = `http://localhost${pathname}`;
    const h = new Headers(headers);
    if (cookies.auth_token) {
      h.set("cookie", `auth_token=${cookies.auth_token}`);
    }
    const init = { method, headers: h };
    if (body !== null && method !== "GET" && method !== "HEAD") {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const req = new Request(url, init);
    req.nextUrl = new URL(url);
    req.cookies = {
      get: (name) => {
        if (name in cookies) return { value: cookies[name] };
        const cookieHeader = h.get("cookie") || "";
        const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
        return match ? { value: match[1] } : undefined;
      },
    };
    return req;
  }

  describe("TC-API-01: test_auth_guard_deny_unauthorized_get", () => {
    it("rejects unauthenticated GET with 401 via dashboardGuard", async () => {
      const guard = getGuard();
      const req = makeRequest("/api/providers/anthropic/overrides", { method: "GET" });
      const res = await guard.proxy(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
    });
  });

  describe("TC-API-02: test_auth_guard_deny_unauthorized_put", () => {
    it("rejects unauthenticated PUT with 401 via dashboardGuard", async () => {
      const guard = getGuard();
      const req = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: { headers: { "X-Test": "1" } },
      });
      const res = await guard.proxy(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
    });
  });

  describe("TC-API-03: test_auth_guard_allow_authenticated", () => {
    it("permits requests with valid CLI token", async () => {
      const guard = getGuard();
      const cliToken = await machineIdModule.getConsistentMachineId("9r-cli-auth");
      const req = makeRequest("/api/providers/anthropic/overrides", {
        method: "GET",
        headers: { "x-9r-cli-token": cliToken },
      });
      const res = await guard.proxy(req);
      expect(res.status).not.toBe(401);
    });

    it("permits requests with valid dashboard JWT cookie", async () => {
      const guard = getGuard();
      const token = await sessionModule.createDashboardAuthToken();
      const req = makeRequest("/api/providers/anthropic/overrides", {
        method: "GET",
        cookies: { auth_token: token },
      });
      const res = await guard.proxy(req);
      expect(res.status).not.toBe(401);
    });

    it("permits requests when requireLogin is false", async () => {
      const guard = getGuard();
      const db = getDb();
      await db.updateSettings({ requireLogin: false });
      const req = makeRequest("/api/providers/anthropic/overrides", { method: "GET" });
      const res = await guard.proxy(req);
      expect(res.status).not.toBe(401);
      await db.updateSettings({ requireLogin: true });
    });
  });

  describe("TC-API-04: test_get_overrides_resolution", () => {
    it("returns 200 with headers and builtinHeaders for canonical provider", async () => {
      const { GET } = getRoute();
      const req = makeRequest("/api/providers/anthropic/overrides");
      const res = await GET(req, { params: { id: "anthropic" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const data = await res.json();
      expect(data).toHaveProperty("headers");
      expect(data).toHaveProperty("builtinHeaders");
      expect(data.builtinHeaders).toHaveProperty("anthropic-version");
      expect(typeof data.builtinHeaders["anthropic-version"]).toBe("string");
    });

    it("resolves provider alias (ocg -> opencode-go) and returns builtinHeaders", async () => {
      const { GET } = getRoute();
      const req = makeRequest("/api/providers/ocg/overrides");
      const res = await GET(req, { params: { id: "ocg" } });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.headers).toEqual({});
      expect(data.builtinHeaders).toEqual({});
    });

    it("returns 200 with empty builtinHeaders for configured compatible provider node", async () => {
      const db = getDb();
      const node = await db.createProviderNode({
        id: "custom-compatible-node-test",
        type: "llm",
        name: "Custom Node Test",
        prefix: "custom-test",
        apiType: "openai",
        baseUrl: "https://api.example.com/v1",
      });
      expect(node.id).toBe("custom-compatible-node-test");

      const { GET } = getRoute();
      const req = makeRequest(`/api/providers/${node.id}/overrides`);
      const res = await GET(req, { params: { id: node.id } });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.headers).toEqual({});
      expect(data.builtinHeaders).toEqual({});
    });

    it("returns 404 for unknown provider ID", async () => {
      const { GET } = getRoute();
      const req = makeRequest("/api/providers/unknown-random-provider/overrides");
      const res = await GET(req, { params: { id: "unknown-random-provider" } });
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const data = await res.json();
      expect(data.error).toBe("Provider not found");
    });
  });

  describe("TC-API-05: test_put_overrides_shape_validation", () => {
    it("rejects non-object, array, null, and missing headers with 400 without DB write", async () => {
      const { PUT } = getRoute();
      const db = getDb();

      await db.updateProviderOverride("anthropic", {});

      const badBodies = [
        "not-json",
        null,
        [],
        [{ name: "X-Test", value: "1" }],
        {},
        { headers: null },
        { headers: [] },
        { headers: "string" },
        { headers: 123 },
        { headers: { "X-Test": 123 } },
        { headers: { "X-Test": true } },
        { headers: { "X-Test": null } },
        { headers: { "X-Test": {} } },
        { headers: { "X-Test": ["nested"] } },
      ];

      for (const b of badBodies) {
        const req = makeRequest("/api/providers/anthropic/overrides", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: typeof b === "string" ? b : b,
        });
        const res = await PUT(req, { params: { id: "anthropic" } });
        expect(res.status).toBe(400);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
      }

      const settings = await db.getSettings();
      expect(settings.providerOverrides?.anthropic).toBeUndefined();
    });
  });

  describe("TC-API-06: test_put_overrides_rfc_tokens", () => {
    it("accepts valid RFC 7230 tokens including apostrophe and backtick", async () => {
      const { PUT, GET } = getRoute();
      const validHeaders = {
        "X-Custom-'Header": "val1",
        "X-Custom-`Header": "val2",
        "!#$%&'*+-.^_`|~": "val3",
      };

      const putReq = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: { headers: validHeaders },
      });
      const putRes = await PUT(putReq, { params: { id: "anthropic" } });
      expect(putRes.status).toBe(200);

      const getReq = makeRequest("/api/providers/anthropic/overrides");
      const getRes = await GET(getReq, { params: { id: "anthropic" } });
      expect(getRes.status).toBe(200);
      const data = await getRes.json();
      expect(data.headers["X-Custom-'Header"]).toBe("val1");
      expect(data.headers["X-Custom-`Header"]).toBe("val2");
      expect(data.headers["!#$%&'*+-.^_`|~"]).toBe("val3");
    });

    it("rejects invalid header tokens (spaces, colons, non-token chars)", async () => {
      const { PUT } = getRoute();
      const invalidNames = [
        "X Invalid Header",
        "X:ColonHeader",
        "X/SlashHeader",
        "X@AtHeader",
        "X=EqualHeader",
        "",
      ];

      for (const name of invalidNames) {
        const req = makeRequest("/api/providers/anthropic/overrides", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: { headers: { [name]: "val" } },
        });
        const res = await PUT(req, { params: { id: "anthropic" } });
        expect(res.status).toBe(400);
      }
    });
  });

  describe("TC-API-07: test_put_overrides_injection_prevention", () => {
    it("rejects CR, LF, NUL, and control characters in names and values", async () => {
      const { PUT } = getRoute();
      const injectionCases = [
        { "X-Name\r\n": "val" },
        { "X-Name\n": "val" },
        { "X-Name\r": "val" },
        { "X-Safe": "val\r\ninjection" },
        { "X-Safe": "val\ninjection" },
        { "X-Safe": "val\0injection" },
        { "X-Safe": "val\x1Finjection" },
      ];

      for (const headers of injectionCases) {
        const req = makeRequest("/api/providers/anthropic/overrides", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: { headers },
        });
        const res = await PUT(req, { params: { id: "anthropic" } });
        expect(res.status).toBe(400);
      }
    });

    it("accepts HTAB and empty string values", async () => {
      const { PUT, GET } = getRoute();
      const validHeaders = {
        "X-Tab-Header": "value\twith\ttab",
        "X-Empty-Header": "",
      };

      const putReq = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: { headers: validHeaders },
      });
      const putRes = await PUT(putReq, { params: { id: "anthropic" } });
      expect(putRes.status).toBe(200);

      const getReq = makeRequest("/api/providers/anthropic/overrides");
      const getRes = await GET(getReq, { params: { id: "anthropic" } });
      const data = await getRes.json();
      expect(data.headers["X-Tab-Header"]).toBe("value\twith\ttab");
      expect(data.headers["X-Empty-Header"]).toBe("");
    });
  });

  describe("TC-API-08: test_put_overrides_prototype_safety", () => {
    it("preserves __proto__, constructor, and toString without prototype pollution", async () => {
      const { PUT, GET } = getRoute();
      const rawJson = '{"headers":{"__proto__":"proto-val","constructor":"ctor-val","toString":"str-val"}}';

      const putReq = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: rawJson,
      });
      const putRes = await PUT(putReq, { params: { id: "anthropic" } });
      expect(putRes.status).toBe(200);

      expect(Object.prototype["__proto__"]).not.toBe("proto-val");
      expect({}["constructor"]).not.toBe("ctor-val");
      expect({}["toString"]).not.toBe("str-val");

      const getReq = makeRequest("/api/providers/anthropic/overrides");
      const getRes = await GET(getReq, { params: { id: "anthropic" } });
      expect(getRes.status).toBe(200);
      const data = await getRes.json();
      expect(Object.prototype.hasOwnProperty.call(data.headers, "__proto__")).toBe(true);
      expect(data.headers["constructor"]).toBe("ctor-val");
      expect(data.headers["toString"]).toBe("str-val");
    });
  });

  describe("TC-API-09: test_put_overrides_reset_empty_dict", () => {
    it("resets provider override slice when headers is empty object without clobbering siblings", async () => {
      const { PUT, GET } = getRoute();
      const db = getDb();

      await db.updateProviderOverride("anthropic", { "X-Anthropic": "1" });
      await db.updateProviderOverride("deepseek", { "X-DeepSeek": "2" });

      const putReq = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: { headers: {} },
      });
      const putRes = await PUT(putReq, { params: { id: "anthropic" } });
      expect(putRes.status).toBe(200);
      const putData = await putRes.json();
      expect(putData.headers).toEqual({});
      expect(putData.builtinHeaders).toHaveProperty("anthropic-version");

      const settings = await db.getSettings();
      expect(settings.providerOverrides?.anthropic).toBeUndefined();
      expect(settings.providerOverrides?.deepseek?.headers?.["X-DeepSeek"]).toBe("2");
    });
  });

  describe("TC-API-10: test_put_overrides_authoritative_response", () => {
    it("returns authoritative { headers, builtinHeaders } matching GET and supports unrestricted count/length", async () => {
      const { PUT, GET } = getRoute();

      const bigHeaders = {};
      for (let i = 1; i <= 25; i++) {
        bigHeaders[`X-Custom-Header-${i}`] = `value-${i}`;
      }
      bigHeaders["X-Large-Value-Header"] = "A".repeat(9000);

      const putReq = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: { headers: bigHeaders },
      });
      const putRes = await PUT(putReq, { params: { id: "anthropic" } });
      expect(putRes.status).toBe(200);
      const putData = await putRes.json();

      const getReq = makeRequest("/api/providers/anthropic/overrides");
      const getRes = await GET(getReq, { params: { id: "anthropic" } });
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();

      expect(putData.headers).toEqual(getData.headers);
      expect(putData.builtinHeaders).toEqual(getData.builtinHeaders);
      expect(getData.headers["X-Large-Value-Header"]).toBe("A".repeat(9000));
      expect(Object.keys(getData.headers).length).toBe(26);
    });

    it("persists only effective diff against registry transport defaults", async () => {
      const { PUT, GET } = getRoute();
      const db = getDb();

      const putReq = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: {
          headers: {
            "anthropic-version": "2023-06-01",
            "X-Effective-Diff": "true",
          },
        },
      });
      const putRes = await PUT(putReq, { params: { id: "anthropic" } });
      expect(putRes.status).toBe(200);
      const putData = await putRes.json();

      expect(putData.headers["X-Effective-Diff"]).toBe("true");
      expect(putData.headers["anthropic-version"]).toBeUndefined();

      const settings = await db.getSettings();
      expect(settings.providerOverrides?.anthropic?.headers?.["anthropic-version"]).toBeUndefined();
      expect(settings.providerOverrides?.anthropic?.headers?.["X-Effective-Diff"]).toBe("true");
    });
  });

  describe("TC-API-11: test_settings_redaction_and_mass_assign", () => {
    it("redacts providerOverrides in GET /api/settings and blocks mass assignment via PATCH", async () => {
      const { GET, PATCH } = getSettingsRoute();
      const db = getDb();

      await db.updateProviderOverride("anthropic", { "X-Secret-Auth": "bearer-secret-token" });

      const getRes = await GET();
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.providerOverrides).toBeUndefined();

      const patchReq = makeRequest("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: {
          providerOverrides: {
            evil: { headers: { "X-Injected": "evil-value" } },
          },
          rtkEnabled: true,
        },
      });
      const patchRes = await PATCH(patchReq);
      expect(patchRes.status).toBe(200);
      const patchData = await patchRes.json();
      expect(patchData.providerOverrides).toBeUndefined();

      const settings = await db.getSettings();
      expect(settings.providerOverrides?.evil).toBeUndefined();
      expect(settings.providerOverrides?.anthropic?.headers?.["X-Secret-Auth"]).toBe("bearer-secret-token");
    });
  });

  describe("TC-API-12: test_storage_atomic_concurrent_updates", () => {
    it("performs atomic synchronous SQLite transaction preserving sibling providers and unrelated metadata", async () => {
      const db = getDb();

      await Promise.all([
        db.updateProviderOverride("siblingA", { "X-A": "1" }),
        db.updateProviderOverride("siblingB", { "X-B": "2" }),
      ]);

      const settings = await db.getSettings();
      expect(settings.providerOverrides?.siblingA?.headers?.["X-A"]).toBe("1");
      expect(settings.providerOverrides?.siblingB?.headers?.["X-B"]).toBe("2");

      const rawDb = await (await import("../../src/lib/db/driver.js")).getAdapter();
      rawDb.transaction(() => {
        const row = rawDb.get("SELECT data FROM settings WHERE id = 1");
        const current = JSON.parse(row.data);
        current.providerOverrides = current.providerOverrides || {};
        current.providerOverrides.siblingA = {
          headers: { "X-A": "1" },
          customMetadata: "preserved",
        };
        rawDb.run(
          "INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
          [JSON.stringify(current)]
        );
      });

      await db.updateProviderOverride("siblingA", {});
      const afterClear = await db.getSettings();
      expect(afterClear.providerOverrides?.siblingA?.headers).toBeUndefined();
      expect(afterClear.providerOverrides?.siblingA?.customMetadata).toBe("preserved");
    });
  });

  describe("TC-API-13: test_put_overrides_case_insensitive_last_write_wins", () => {
    it("resolves duplicate header keys with case-insensitive last-write-wins", async () => {
      const { PUT, GET } = getRoute();
      const req = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: {
          headers: {
            "x-duplicate-header": "first-value",
            "X-Duplicate-Header": "second-value-wins",
          },
        },
      });
      const res = await PUT(req, { params: { id: "anthropic" } });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.headers["X-Duplicate-Header"]).toBe("second-value-wins");
      expect(data.headers["x-duplicate-header"]).toBeUndefined();
      expect(Object.keys(data.headers).filter(k => k.toLowerCase() === "x-duplicate-header").length).toBe(1);

      const getReq = makeRequest("/api/providers/anthropic/overrides");
      const getRes = await GET(getReq, { params: { id: "anthropic" } });
      const getData = await getRes.json();
      expect(getData.headers["X-Duplicate-Header"]).toBe("second-value-wins");
      expect(Object.keys(getData.headers).filter(k => k.toLowerCase() === "x-duplicate-header").length).toBe(1);
    });
  });

  describe("TC-API-14: test_put_overrides_allows_all_valid_sensitive_headers", () => {
    it("permits customizing standard sensitive and transport headers without arbitrary blocklist", async () => {
      const { PUT, GET } = getRoute();
      const sensitiveHeaders = {
        "Authorization": "Bearer custom-token-test",
        "Cookie": "session=abc123xyz",
        "Host": "api.custom-proxy.internal",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": "1234",
        "Transfer-Encoding": "chunked",
      };

      const putReq = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: { headers: sensitiveHeaders },
      });
      const putRes = await PUT(putReq, { params: { id: "anthropic" } });
      expect(putRes.status).toBe(200);

      const getReq = makeRequest("/api/providers/anthropic/overrides");
      const getRes = await GET(getReq, { params: { id: "anthropic" } });
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      for (const [k, v] of Object.entries(sensitiveHeaders)) {
        expect(getData.headers[k]).toBe(v);
      }
    });
  });

  describe("TC-API-15: test_put_overrides_zero_secret_leak_in_error", () => {
    it("returns generic error message and never leaks secret payload on invalid input", async () => {
      const { PUT } = getRoute();
      const secretPayload = "super-secret-credential-value-999";
      const putReq = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: {
          headers: {
            "X-Leaking-Test": `${secretPayload}
Injected`,
          },
        },
      });
      const res = await PUT(putReq, { params: { id: "anthropic" } });
      expect(res.status).toBe(400);
      const bodyText = JSON.stringify(await res.json());
      expect(bodyText).not.toContain(secretPayload);
      expect(bodyText).toContain("Invalid HTTP header name or value");
    });
  });

  describe("TC-API-16: test_put_overrides_duplicate_default_filtering_after_canonicalization", () => {
    it("filters duplicate default names after canonicalization with concrete inputs", async () => {
      const { PUT, GET } = getRoute();

      // Concrete Input A: Redundant duplicate matching default value after canonicalization -> pruned
      const putReqA = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: {
          headers: {
            "anthropic-version": "2023-06-01",
            "Anthropic-Version": "2023-06-01",
          },
        },
      });
      const resA = await PUT(putReqA, { params: { id: "anthropic" } });
      expect(resA.status).toBe(200);
      const dataA = await resA.json();
      expect(dataA.headers).toEqual({});

      // Concrete Input B: Last-write-wins specifies a non-default override -> retained
      const putReqB = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: {
          headers: {
            "anthropic-version": "2023-06-01",
            "Anthropic-Version": "2024-01-01",
          },
        },
      });
      const resB = await PUT(putReqB, { params: { id: "anthropic" } });
      expect(resB.status).toBe(200);
      const dataB = await resB.json();
      expect(dataB.headers["Anthropic-Version"]).toBe("2024-01-01");
      expect(Object.keys(dataB.headers).length).toBe(1);

      // Concrete Input C: Last-write-wins reverts back to default -> pruned
      const putReqC = makeRequest("/api/providers/anthropic/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: {
          headers: {
            "Anthropic-Version": "2024-01-01",
            "anthropic-version": "2023-06-01",
          },
        },
      });
      const resC = await PUT(putReqC, { params: { id: "anthropic" } });
      expect(resC.status).toBe(200);
      const dataC = await resC.json();
      expect(dataC.headers).toEqual({});
    });
  });

  describe("TC-API-17: test_get_overrides_runtime_resilience_to_invalid_imported_settings", () => {
    it("handles malformed/invalid imported providerOverrides settings gracefully on GET without crashing", async () => {
      const { GET } = getRoute();
      const rawDb = await (await import("../../src/lib/db/driver.js")).getAdapter();

      const malformedCases = [
        ["corrupted-array", ["not-a-dictionary"]],
        ["corrupted-null", null],
        ["corrupted-string", "raw-string-instead-of-object"],
        ["corrupted-number", 42],
      ];

      for (const [providerId, malformedHeaders] of malformedCases) {
        rawDb.transaction(() => {
          const row = rawDb.get("SELECT data FROM settings WHERE id = 1");
          const current = JSON.parse(row.data);
          current.providerOverrides = current.providerOverrides || {};
          current.providerOverrides[providerId] = {
            headers: malformedHeaders,
          };
          current.providerOverrides["anthropic"] = {
            headers: malformedHeaders,
          };
          rawDb.run(
            "INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            [JSON.stringify(current)]
          );
        });

        const req = makeRequest("/api/providers/anthropic/overrides");
        const res = await GET(req, { params: { id: "anthropic" } });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.headers).toEqual({});
        expect(data.builtinHeaders).toHaveProperty("anthropic-version");
      }

      // Cleanup anthropic overrides
      const db = getDb();
      await db.updateProviderOverride("anthropic", {});
    });
  });
});
