import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseTOML } from "confbox";

// Mock DB
const mockApiKeys = vi.hoisted(() => ({
  keys: [],
  shouldThrow: false,
}));

vi.mock("@/lib/db", () => ({
  getApiKeys: vi.fn(async () => {
    if (mockApiKeys.shouldThrow) {
      throw new Error("Simulated SQLite failure");
    }
    return mockApiKeys.keys;
  }),
}));

// Mock os homedir for route safety
const osMock = vi.hoisted(() => ({ home: "", platform: "linux" }));
vi.mock("os", async () => {
  const actual = await vi.importActual("os");
  return {
    ...actual,
    default: { ...actual, homedir: () => osMock.home, platform: () => osMock.platform },
    homedir: () => osMock.home,
    platform: () => osMock.platform,
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status ?? 200, body }),
  },
}));

import { resolveCliApiKey } from "@/app/api/cli-tools/resolveApiKey.js";
import { POST as codewhalePOST } from "@/app/api/cli-tools/codewhale-settings/route.js";
import { POST as ompPOST } from "@/app/api/cli-tools/omp-settings/route.js";
import { POST as piPOST } from "@/app/api/cli-tools/pi-settings/route.js";

const req = (body) => ({ json: async () => body });

describe("resolveCliApiKey helper", () => {
  beforeEach(() => {
    mockApiKeys.keys = [];
    mockApiKeys.shouldThrow = false;
  });

  it("returns caller key when non-empty string and not sk_9router", async () => {
    mockApiKeys.keys = [{ key: "sk-db-active", isActive: true }];
    const res = await resolveCliApiKey("sk-custom-user-key");
    expect(res).toBe("sk-custom-user-key");
  });

  it("trims whitespace from caller key", async () => {
    const res = await resolveCliApiKey("  sk-with-spaces  ");
    expect(res).toBe("sk-with-spaces");
  });

  it.each([undefined, "", "   ", "sk_9router", " sk_9router ", 12345, {}])(
    "uses a valid existing key before DB lookup for missing or invalid caller %j",
    async (callerKey) => {
      mockApiKeys.shouldThrow = true;
      expect(await resolveCliApiKey(callerKey, "  sk-existing-keep  ")).toBe("sk-existing-keep");
    },
  );

  it("validates both key candidates before selecting an active DB key", async () => {
    mockApiKeys.keys = [{ key: "sk-db-active-1", isActive: true }];
    expect(await resolveCliApiKey({}, " sk_9router ")).toBe("sk-db-active-1");
  });

  it("falls back to first active DB key when caller key is empty string", async () => {
    mockApiKeys.keys = [
      { key: "sk-inactive-1", isActive: false },
      { key: "sk-active-1", isActive: true },
      { key: "sk-active-2", isActive: true },
    ];
    const res = await resolveCliApiKey("");
    expect(res).toBe("sk-active-1");
  });

  it("falls back to first active DB key when caller key is null", async () => {
    mockApiKeys.keys = [{ key: "sk-active-1", isActive: true }];
    const res = await resolveCliApiKey(null);
    expect(res).toBe("sk-active-1");
  });

  it("falls back to first active DB key when caller key is undefined", async () => {
    mockApiKeys.keys = [{ key: "sk-active-1", isActive: true }];
    const res = await resolveCliApiKey(undefined);
    expect(res).toBe("sk-active-1");
  });

  it("falls back to first active DB key when caller key is literal sk_9router", async () => {
    mockApiKeys.keys = [{ key: "sk-active-real", isActive: true }];
    const res = await resolveCliApiKey("sk_9router");
    expect(res).toBe("sk-active-real");
  });

  it("returns empty string when no active keys exist in DB and caller is empty", async () => {
    mockApiKeys.keys = [
      { key: "sk-inactive-1", isActive: false },
      { key: "sk-inactive-2", isActive: false },
    ];
    const res = await resolveCliApiKey("");
    expect(res).toBe("");
  });

  it("returns empty string when DB is empty and caller is empty", async () => {
    mockApiKeys.keys = [];
    const res = await resolveCliApiKey("");
    expect(res).toBe("");
  });

  it("returns supplied key before DB lookup even when DB fails", async () => {
    mockApiKeys.shouldThrow = true;
    const resWithKey = await resolveCliApiKey("sk-caller-provided");
    expect(resWithKey).toBe("sk-caller-provided");
  });

  it("throws a safe generic error when DB lookup fails and caller key is empty", async () => {
    mockApiKeys.shouldThrow = true;
    await expect(resolveCliApiKey("")).rejects.toThrow("Failed to resolve API key");
    await expect(resolveCliApiKey(null)).rejects.toThrow("Failed to resolve API key");
    await expect(resolveCliApiKey("sk_9router")).rejects.toThrow("Failed to resolve API key");
  });

  it("treats non-string caller keys as missing instead of throwing TypeError", async () => {
    mockApiKeys.keys = [{ key: "sk-db-active-1", isActive: true }];
    expect(await resolveCliApiKey(12345)).toBe("sk-db-active-1");
    expect(await resolveCliApiKey({})).toBe("sk-db-active-1");
    expect(await resolveCliApiKey([])).toBe("sk-db-active-1");
    expect(await resolveCliApiKey(true)).toBe("sk-db-active-1");
  });

  it("skips malformed active records and returns first usable nonempty key", async () => {
    mockApiKeys.keys = [
      { key: "", isActive: true },
      { key: "   ", isActive: true },
      { key: "sk_9router", isActive: true },
      { key: null, isActive: true },
      { key: "sk-good-1", isActive: true },
      { key: "sk-good-2", isActive: true },
    ];
    expect(await resolveCliApiKey("")).toBe("sk-good-1");
  });

  it("returns empty string when DB holds only unusable active records", async () => {
    mockApiKeys.keys = [
      { key: "", isActive: true },
      { key: "sk_9router", isActive: true },
    ];
    expect(await resolveCliApiKey("")).toBe("");
  });

  it("never returns sk_9router placeholder", async () => {
    mockApiKeys.keys = [];
    expect(await resolveCliApiKey("sk_9router")).not.toBe("sk_9router");
    expect(await resolveCliApiKey("")).not.toBe("sk_9router");
  });
});

describe("real route behavior with resolved API key", () => {
  let tmpHome;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), "9router-cli-test-"));
    osMock.home = tmpHome;
    mockApiKeys.keys = [{ key: "sk-db-active-1", isActive: true }];
    mockApiKeys.shouldThrow = false;
  });

  afterEach(async () => {
    if (tmpHome && fs.existsSync(tmpHome)) {
      try {
        await fsp.rm(tmpHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
      } catch {
        // Ignore residual lock on Windows temp
      }
    }
  });

  it("writes caller key when explicitly provided to codewhale-settings", async () => {
    const res = await codewhalePOST(
      req({ baseUrl: "http://localhost:20128", apiKey: "sk-explicit-whale", model: "test/m" })
    );
    expect(res.status).toBe(200);

    const configPath = path.join(tmpHome, ".codewhale", "config.toml");
    const written = await fsp.readFile(configPath, "utf-8");
    const parsed = parseTOML(written);
    expect(parsed.openai?.api_key).toBe("sk-explicit-whale");
  });

  it("resolves to active DB key when empty apiKey sent to codewhale-settings", async () => {
    const res = await codewhalePOST(
      req({ baseUrl: "http://localhost:20128", apiKey: "", model: "test/m" })
    );
    expect(res.status).toBe(200);

    const configPath = path.join(tmpHome, ".codewhale", "config.toml");
    const written = await fsp.readFile(configPath, "utf-8");
    const parsed = parseTOML(written);
    expect(parsed.openai?.api_key).toBe("sk-db-active-1");
  });

  it("resolves to active DB key when sk_9router placeholder sent to codewhale-settings", async () => {
    const res = await codewhalePOST(
      req({ baseUrl: "http://localhost:20128", apiKey: "sk_9router", model: "test/m" })
    );
    expect(res.status).toBe(200);

    const configPath = path.join(tmpHome, ".codewhale", "config.toml");
    const written = await fsp.readFile(configPath, "utf-8");
    const parsed = parseTOML(written);
    expect(parsed.openai?.api_key).toBe("sk-db-active-1");
  });

  it("codewhale POST errors and leaves exact config bytes unchanged when DB lookup fails and caller key is empty", async () => {
    const configDir = path.join(tmpHome, ".codewhale");
    await fsp.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.toml");
    const before = '# CodeWhale config\n\n[openai]\napi_key = "sk-existing-keep"\nbase_url = "http://localhost:20128/v1"\nmodel = "test/m"\n';
    await fsp.writeFile(configPath, before, "utf-8");
    mockApiKeys.shouldThrow = true;

    const res = await codewhalePOST(
      req({ baseUrl: "http://localhost:20128", apiKey: "", model: "test/m" })
    );
    expect(res.status).toBe(500);
    expect(res.body?.error?.message).toBe("Failed to resolve API key");
    expect(await fsp.readFile(configPath, "utf-8")).toBe(before);
  });

  it("omp POST errors and leaves exact yml bytes unchanged when DB lookup fails and caller key is empty", async () => {
    const ompAgentDir = path.join(tmpHome, ".omp", "agent");
    await fsp.mkdir(ompAgentDir, { recursive: true });
    const ymlPath = path.join(ompAgentDir, "models.yml");
    const before = "providers:\n  9router:\n    baseUrl: http://localhost:20128/v1\n    apiKey: sk-existing-keep\n    api: openai-completions\n    authHeader: true\n    disableStrictTools: true\n    discovery:\n      type: proxy\n";
    await fsp.writeFile(ymlPath, before, "utf-8");
    mockApiKeys.shouldThrow = true;

    const res = await ompPOST(
      req({ baseUrl: "http://localhost:20128", apiKey: "" })
    );
    expect(res.status).toBe(500);
    expect(res.body?.error?.message).toBe("Failed to resolve API key");
    expect(await fsp.readFile(ymlPath, "utf-8")).toBe(before);
  });

  it("codewhale POST with explicit caller key still writes it when DB fails", async () => {
    mockApiKeys.shouldThrow = true;
    const res = await codewhalePOST(
      req({ baseUrl: "http://localhost:20128", apiKey: "sk-explicit-valid", model: "test/m" })
    );
    expect(res.status).toBe(200);

    const configPath = path.join(tmpHome, ".codewhale", "config.toml");
    const parsed = parseTOML(await fsp.readFile(configPath, "utf-8"));
    expect(parsed.openai?.api_key).toBe("sk-explicit-valid");
  });

  it("codewhale POST with empty DB lookup success still writes empty key per upstream semantics", async () => {
    mockApiKeys.keys = [];
    const res = await codewhalePOST(
      req({ baseUrl: "http://localhost:20128", apiKey: "", model: "test/m" })
    );
    expect(res.status).toBe(200);

    const configPath = path.join(tmpHome, ".codewhale", "config.toml");
    const written = await fsp.readFile(configPath, "utf-8");
    const parsed = parseTOML(written);
    expect(parsed.openai?.api_key).toBe("");
    expect(written).not.toContain("sk_9router");
  });

  it.each(["   ", " sk_9router ", 12345, {}])(
    "Pi preserves its existing key and wire format for invalid caller %j",
    async (apiKey) => {
      const dir = path.join(tmpHome, ".pi", "agent");
      await fsp.mkdir(dir, { recursive: true });
      const configPath = path.join(dir, "models.json");
      await fsp.writeFile(configPath, JSON.stringify({ providers: { "9router": {
        apiKey: "sk-existing-keep", api: "anthropic-messages", headers: { "x-test": "keep" },
      } } }));
      mockApiKeys.shouldThrow = true;

      const res = await piPOST(req({ baseUrl: "http://localhost:20128", apiKey, model: "test/m" }));
      expect(res.status).toBe(200);
      const written = JSON.parse(await fsp.readFile(configPath, "utf8"));
      expect(written.providers["9router"].apiKey).toBe("sk-existing-keep");
      expect(written.providers["9router"].api).toBe("anthropic-messages");
      expect(written.providers["9router"].headers).toEqual({ "x-test": "keep" });
    },
  );

  it("Pi trims an explicit caller key instead of persisting invalid header whitespace", async () => {
    const res = await piPOST(req({ baseUrl: "http://localhost:20128", apiKey: "  sk-explicit-pi  ", model: "test/m" }));
    expect(res.status).toBe(200);
    const written = JSON.parse(await fsp.readFile(path.join(tmpHome, ".pi", "agent", "models.json"), "utf8"));
    expect(written.providers["9router"].apiKey).toBe("sk-explicit-pi");
    expect(written.providers["9router"].api).toBe("openai-completions");
  });

  it("Pi replaces unusable stored keys with an active dashboard key", async () => {
    const dir = path.join(tmpHome, ".pi", "agent");
    await fsp.mkdir(dir, { recursive: true });
    const configPath = path.join(dir, "models.json");
    await fsp.writeFile(configPath, JSON.stringify({ providers: { "9router": { apiKey: "   " } } }));
    const res = await piPOST(req({ baseUrl: "http://localhost:20128", apiKey: "", model: "test/m" }));
    expect(res.status).toBe(200);
    const written = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(written.providers["9router"].apiKey).toBe("sk-db-active-1");
  });

  it("Pi leaves exact config bytes unchanged when no usable key exists and DB lookup fails", async () => {
    const dir = path.join(tmpHome, ".pi", "agent");
    await fsp.mkdir(dir, { recursive: true });
    const configPath = path.join(dir, "models.json");
    const before = JSON.stringify({ providers: { "9router": { apiKey: " sk_9router ", api: "anthropic-messages" } } });
    await fsp.writeFile(configPath, before);
    mockApiKeys.shouldThrow = true;
    const res = await piPOST(req({ baseUrl: "http://localhost:20128", apiKey: "   ", model: "test/m" }));
    expect(res.status).toBe(500);
    expect(res.body?.error?.message).toBe("Failed to resolve API key");
    expect(await fsp.readFile(configPath, "utf8")).toBe(before);
  });

  it("preserves OMP api: openai-completions and writes resolved key", async () => {
    // Pre-initialize agent.db schema so better-sqlite3 handles close cleanly
    const ompAgentDir = path.join(tmpHome, ".omp", "agent");
    await fsp.mkdir(ompAgentDir, { recursive: true });
    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(path.join(ompAgentDir, "agent.db"));
      db.exec("CREATE TABLE IF NOT EXISTS auth_credentials (provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT, identity_key TEXT, created_at INT, updated_at INT)");
      db.close();
    } catch {
      // better-sqlite3 not available or failed
    }

    const res = await ompPOST(
      req({ baseUrl: "http://localhost:20128", apiKey: "" })
    );
    expect(res.status).toBe(200);

    const ymlPath = path.join(tmpHome, ".omp", "agent", "models.yml");
    const written = await fsp.readFile(ymlPath, "utf-8");
    expect(written).toContain("api: openai-completions");
    expect(written).toContain("apiKey: sk-db-active-1");
    expect(written).not.toContain("sk_9router");
  });
});
