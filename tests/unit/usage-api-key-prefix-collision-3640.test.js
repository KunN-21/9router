// #3640 — "Usage by API Key" collapsed distinct keys that share an 8-char prefix.
//
// Keys are minted as sk-{machineId}-{keyId}-{crc}, so every key issued by one
// install shares its first 8 characters. The 24h/today branch of getUsageStats
// grouped on maskApiKey(key), which is exactly those 8 characters, so all keys
// landed in one bucket: the first one seen kept its name and absorbed the rest
// of the install's requests, tokens and cost.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { generateApiKeyWithMachine } from "../../src/shared/utils/apiKey.js";

// Same derivation as apiKeyIdentity() for an unregistered raw key in
// src/lib/db/repos/usageRepo.js — the identity 24h/history use after a delete.
const anonDigest = (raw) => "anon-" + createHash("sha256").update(raw).digest("hex").slice(0, 12);

function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function readTodayByApiKey() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const adapter = await getAdapter();
  const row = adapter.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [localDateKey()]);
  return row ? (JSON.parse(row.data).byApiKey || {}) : {};
}

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-apikey-3640-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  // Best-effort: the adapter has no close(), so on Windows the open SQLite
  // handle makes rmSync raise EPERM. The OS reclaims the temp dir either way,
  // and failing teardown must not mask the assertions above.
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("usage by API key (#3640)", () => {
  it("two keys from one install really do share their first 8 characters", () => {
    const machineId = "00275ae3";
    const first = generateApiKeyWithMachine(machineId).key;
    const second = generateApiKeyWithMachine(machineId).key;

    expect(first).not.toBe(second);
    expect(first.slice(0, 8)).toBe(second.slice(0, 8));
  });

  it("keeps a separate bucket, name and totals for each key", async () => {
    const machineId = "00275ae3";
    const clientA = await db.createApiKey("Client-A", machineId);
    const clientB = await db.createApiKey("Client-B", machineId);
    expect(clientA.key.slice(0, 8)).toBe(clientB.key.slice(0, 8));

    const record = (apiKey, promptTokens) =>
      db.saveRequestUsage({
        provider: "google",
        model: "gemini-3.7-flash-high",
        connectionId: "c-3640",
        apiKey,
        tokens: { prompt_tokens: promptTokens, completion_tokens: 1 },
        endpoint: "/v1/chat/completions",
        status: "ok",
      });

    await record(clientA.key, 10);
    await record(clientB.key, 20);
    await record(clientB.key, 30);

    const stats = await db.getUsageStats("24h");
    const buckets = Object.values(stats.byApiKey);
    expect(buckets).toHaveLength(2);

    const byName = Object.fromEntries(buckets.map((b) => [b.keyName, b]));
    expect(Object.keys(byName).sort()).toEqual(["Client-A", "Client-B"]);
    expect(byName["Client-A"].requests).toBe(1);
    expect(byName["Client-A"].promptTokens).toBe(10);
    expect(byName["Client-B"].requests).toBe(2);
    expect(byName["Client-B"].promptTokens).toBe(50);
  });

  it("still reports the key masked, never in full", async () => {
    const stats = await db.getUsageStats("24h");
    for (const bucket of Object.values(stats.byApiKey)) {
      expect(bucket.apiKeyMasked).toMatch(/\*\*\*$/);
      expect(bucket.apiKeyMasked.length).toBeLessThanOrEqual(11);
    }
  });
});

describe("daily summary uses the stable registered id (#3640)", () => {
  it("daily buckets registered keys by key id, split across a shared prefix", async () => {
    const doomed = await db.createApiKey("Daily-Id-A", "00275ae3");
    const survivor = await db.createApiKey("Daily-Id-B", "00275ae3");
    expect(doomed.key.slice(0, 8)).toBe(survivor.key.slice(0, 8));

    const record = (apiKey, promptTokens) =>
      db.saveRequestUsage({
        provider: "google",
        model: "gemini-daily-id",
        connectionId: "c-daily-id",
        apiKey,
        tokens: { prompt_tokens: promptTokens, completion_tokens: 1 },
        endpoint: "/v1/chat/completions",
        status: "ok",
      });

    await record(doomed.key, 11);
    await record(survivor.key, 22);

    const stats = await db.getUsageStats("all");
    const bucketA = stats.byApiKey[`${doomed.id}|gemini-daily-id|google`];
    const bucketB = stats.byApiKey[`${survivor.id}|gemini-daily-id|google`];
    expect(bucketA?.apiKeyKey).toBe(doomed.id);
    expect(bucketB?.apiKeyKey).toBe(survivor.id);
    expect(bucketA?.requests).toBe(1);
    expect(bucketA?.promptTokens).toBe(11);
    expect(bucketB?.requests).toBe(1);
    expect(bucketB?.promptTokens).toBe(22);

    const rawToday = await readTodayByApiKey();
    for (const bucketKey of Object.keys(rawToday).filter((k) => k.includes("gemini-daily-id"))) {
      expect(bucketKey.startsWith(`${doomed.id}|`) || bucketKey.startsWith(`${survivor.id}|`)).toBe(true);
      expect(rawToday[bucketKey].apiKey).not.toContain("sk-");
    }
  });

  it("new daily rows store no raw key and carry the stable registered id", async () => {
    const probe = await db.createApiKey("Daily-Serialized", "00275ae3");
    await db.saveRequestUsage({
      provider: "google",
      model: "gemini-daily-serialized",
      connectionId: "c-daily-serialized",
      apiKey: probe.key,
      tokens: { prompt_tokens: 7, completion_tokens: 1 },
      endpoint: "/v1/chat/completions",
      status: "ok",
    });

    const rawToday = await readTodayByApiKey();
    const storedKeys = Object.keys(rawToday).filter((k) => k.includes("gemini-daily-serialized"));
    expect(storedKeys).toEqual([`${probe.id}|gemini-daily-serialized|google`]);
    const stored = rawToday[storedKeys[0]];
    expect(stored.apiKey).toBe(probe.id);
    expect(JSON.stringify(rawToday)).not.toContain(probe.key);
  });

  it("legacy raw-key daily rows fold onto the registered id without raw exposure", async () => {
    const legacy = await db.createApiKey("Daily-Legacy", "00275ae3");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const dateKey = localDateKey();
    const existing = adapter.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
    const day = existing ? JSON.parse(existing.data) : { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {} };
    day.byApiKey ||= {};
    const legacyBucket = `${legacy.key}|gemini-daily-legacy|google`;
    day.byApiKey[legacyBucket] = {
      requests: 2, promptTokens: 40, completionTokens: 2, cachedTokens: 0, cost: 0,
      rawModel: "gemini-daily-legacy", provider: "google", apiKey: legacy.key,
    };
    adapter.run(
      `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
      [dateKey, JSON.stringify(day)]
    );

    const stats = await db.getUsageStats("all");
    const folded = stats.byApiKey[`${legacy.id}|gemini-daily-legacy|google`];
    expect(folded?.apiKeyKey).toBe(legacy.id);
    expect(folded?.requests).toBe(2);
    expect(folded?.promptTokens).toBe(40);
    expect(JSON.stringify(stats.byApiKey)).not.toContain(legacy.key);
  });

  it("a deleted registered key keeps one identity across daily and 24h", async () => {
    const victim = await db.createApiKey("Daily-Deleted", "00275ae3");
    const rawVictim = victim.key;
    const expected = anonDigest(rawVictim);
    await db.saveRequestUsage({
      provider: "google",
      model: "gemini-daily-deleted",
      connectionId: "c-daily-deleted",
      apiKey: rawVictim,
      tokens: { prompt_tokens: 13, completion_tokens: 1 },
      endpoint: "/v1/chat/completions",
      status: "ok",
    });
    expect(await db.deleteApiKey(victim.id)).toBe(true);

    const daily = await db.getUsageStats("all");
    const live = await db.getUsageStats("24h");
    const dailyBucket = daily.byApiKey[`${expected}|gemini-daily-deleted|google`];
    const liveBucket = live.byApiKey[`${expected}|gemini-daily-deleted|google`];
    expect(dailyBucket?.apiKeyKey).toBe(expected);
    expect(liveBucket?.apiKeyKey).toBe(expected);
    expect(dailyBucket?.requests).toBe(1);
    expect(liveBucket?.requests).toBe(1);
    expect(dailyBucket?.promptTokens).toBe(13);
    expect(liveBucket?.promptTokens).toBe(13);
    expect(dailyBucket?.lastUsed).toBe(liveBucket?.lastUsed);
    expect(JSON.stringify(daily.byApiKey)).not.toContain(rawVictim);
    expect(JSON.stringify(live.byApiKey)).not.toContain(rawVictim);
  });
});

describe("AUDIT-002 at runtime: the raw key must not reach the response", () => {
  it("no period puts the raw key in a byApiKey bucket name or payload", async () => {
    const secret = (await db.createApiKey("Audit-Probe", "00275ae3")).key;
    await db.saveRequestUsage({
      provider: "google",
      model: "gemini-3.7-flash-high",
      connectionId: "c-audit",
      apiKey: secret,
      tokens: { prompt_tokens: 5, completion_tokens: 5 },
      endpoint: "/v1/chat/completions",
      status: "ok",
    });

    // The daily-summary periods read usageDaily, whose stored bucket names are
    // built from the raw key. Before this fix they were copied into the
    // response verbatim, which is exactly what the source-text check missed.
    for (const period of ["24h", "today", "7d", "30d", "all"]) {
      const stats = await db.getUsageStats(period);
      expect(JSON.stringify(stats.byApiKey), `period=${period}`).not.toContain(secret);
      for (const name of Object.keys(stats.byApiKey)) {
        expect(name, `period=${period}`).not.toContain(secret);
      }
    }
  });
});
