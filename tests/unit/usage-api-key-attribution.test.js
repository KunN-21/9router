// B7: usage attribution keeps separate buckets per key identity; masks carry tail-4.
// Same-prefix keys must not collide; raw keys never reach byApiKey names/payloads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const anonDigest = (raw) => "anon-" + createHash("sha256").update(raw).digest("hex").slice(0, 12);

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-b7-usage-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(async () => {
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    if (adapter && typeof adapter.close === "function") {
      adapter.close();
    }
  } catch {}
  if (global._dbAdapter) {
    global._dbAdapter.instance = null;
    global._dbAdapter.initPromise = null;
  }
  try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Usage stats API key attribution", () => {
  it("keeps API keys with the same masked prefix in separate buckets", async () => {
    const apiKeyA = `sk-b7shared-aaaa-${Date.now()}a`;
    const apiKeyB = `sk-b7shared-bbbb-${Date.now()}b`;

    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4-b7-attr", connectionId: "c1",
      apiKey: apiKeyA, tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat", status: "ok",
    });
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4-b7-attr", connectionId: "c1",
      apiKey: apiKeyB, tokens: { prompt_tokens: 20, completion_tokens: 10 },
      endpoint: "/v1/chat", status: "ok",
    });

    const stats = await db.getUsageStats("24h");
    const entries = Object.entries(stats.byApiKey).filter(([k]) => k.includes("gpt-4-b7-attr"));
    expect(entries).toHaveLength(2);
    expect(entries.map(([, e]) => e.promptTokens).sort((a, b) => a - b)).toEqual([10, 20]);
    const blob = JSON.stringify(entries);
    expect(blob).not.toContain(apiKeyA);
    expect(blob).not.toContain(apiKeyB);
  });

  it("registered key ids and anon hashes stay in separate buckets", async () => {
    const registered = await db.createApiKey("B7-Attr-Reg", "b7machine1");
    const anonRaw = `sk-b7anon-${Date.now()}-zz`;
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4-b7-attr2", connectionId: "c2",
      apiKey: registered.key, tokens: { prompt_tokens: 7, completion_tokens: 1 },
      endpoint: "/v1/chat", status: "ok",
    });
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4-b7-attr2", connectionId: "c2",
      apiKey: anonRaw, tokens: { prompt_tokens: 9, completion_tokens: 1 },
      endpoint: "/v1/chat", status: "ok",
    });
    const stats = await db.getUsageStats("24h");
    const regBucket = stats.byApiKey[`${registered.id}|gpt-4-b7-attr2|openai`];
    const anonBucket = stats.byApiKey[`${anonDigest(anonRaw)}|gpt-4-b7-attr2|openai`];
    expect(regBucket?.apiKeyKey).toBe(registered.id);
    expect(anonBucket?.apiKeyKey).toBe(anonDigest(anonRaw));
    expect(regBucket?.promptTokens).toBe(7);
    expect(anonBucket?.promptTokens).toBe(9);
  });

  it("masks keep head and tail-4 and never embed the full key", async () => {
    const probe = await db.createApiKey("B7-Attr-Mask", "b7machine2");
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4-b7-attr3", connectionId: "c3",
      apiKey: probe.key, tokens: { prompt_tokens: 3, completion_tokens: 1 },
      endpoint: "/v1/chat", status: "ok",
    });
    const stats = await db.getUsageStats("24h");
    const bucket = stats.byApiKey[`${probe.id}|gpt-4-b7-attr3|openai`];
    expect(bucket.apiKeyMasked).toBe(`${probe.key.slice(0, 8)}***${probe.key.slice(-4)}`);
    expect(bucket.apiKeyMasked).not.toBe(probe.key);
    expect(bucket.apiKeyMasked).toContain("***");
  });

  it("short keys (<=12 chars) mask to first char + *** only", async () => {
    const shortA = `sk-a-${Date.now() % 100000}`;
    const shortB = `sk-b-${Date.now() % 100000}`;
    expect(shortA.length).toBeLessThanOrEqual(12);
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4-b7-attr4", connectionId: "c4",
      apiKey: shortA, tokens: { prompt_tokens: 1, completion_tokens: 1 },
      endpoint: "/v1/chat", status: "ok",
    });
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4-b7-attr4", connectionId: "c4",
      apiKey: shortB, tokens: { prompt_tokens: 2, completion_tokens: 1 },
      endpoint: "/v1/chat", status: "ok",
    });
    const stats = await db.getUsageStats("24h");
    const entries = Object.entries(stats.byApiKey).filter(([k]) => k.includes("gpt-4-b7-attr4"));
    expect(entries).toHaveLength(2);
    for (const [, e] of entries) {
      expect(e.apiKeyMasked).toMatch(/^.\*\*\*$/);
    }
    expect(JSON.stringify(entries)).not.toContain(shortA);
    expect(JSON.stringify(entries)).not.toContain(shortB);
  });

  it("no period leaks a raw key into bucket names or payloads", async () => {
    const secret = (await db.createApiKey("B7-Attr-Audit", "b7machine3")).key;
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4-b7-audit", connectionId: "c-audit",
      apiKey: secret, tokens: { prompt_tokens: 5, completion_tokens: 5 },
      endpoint: "/v1/chat", status: "ok",
    });
    for (const period of ["24h", "today", "7d", "30d", "all"]) {
      const stats = await db.getUsageStats(period);
      expect(JSON.stringify(stats.byApiKey), `period=${period}`).not.toContain(secret);
      for (const name of Object.keys(stats.byApiKey)) {
        expect(name, `period=${period}`).not.toContain(secret);
      }
    }
  });
});
