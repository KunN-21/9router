// B7: provider insert stays O(1) — MAX(priority)+1, no pool reorder on insert.
// Delete/explicit update still renumber. Name collision needs explicit opt-in.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-b7-provider-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(async () => {
  try {
    const adapter = global._dbAdapter?.instance;
    if (adapter && typeof adapter.close === "function") {
      await adapter.close();
    }
  } finally {
    if (global._dbAdapter) {
      global._dbAdapter.instance = null;
      global._dbAdapter.initPromise = null;
      global._dbAdapter.logged = false;
    }
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

async function seed(provider, n) {
  for (let i = 0; i < n; i++) {
    await db.createProviderConnection({
      provider,
      authType: "apikey",
      name: `seed-${i}`,
      apiKey: `k${i}`,
    });
  }
}

describe("provider insert is O(1) in pool size (#4311)", () => {
  it("assigns sequential priorities without a renumber pass", async () => {
    const P = `b7-seq-${Date.now()}-1`;
    await seed(P, 3);
    const list = await db.getProviderConnections({ provider: P });
    expect(list.map((c) => c.name)).toEqual(["seed-0", "seed-1", "seed-2"]);
    expect(list.map((c) => c.priority)).toEqual([1, 2, 3]);
  });

  it("keeps sparse priorities: insert takes MAX+1 and leaves gaps alone", async () => {
    const P = `b7-sparse-${Date.now()}-2`;
    await db.createProviderConnection({ provider: P, authType: "apikey", name: "a", apiKey: "k-a", priority: 4 });
    await db.createProviderConnection({ provider: P, authType: "apikey", name: "b", apiKey: "k-b", priority: 12 });
    const created = await db.createProviderConnection({ provider: P, authType: "apikey", name: "c", apiKey: "k-c" });
    expect(created.priority).toBe(13);
    const list = await db.getProviderConnections({ provider: P });
    expect(list.map((c) => c.priority).sort((a, b) => a - b)).toEqual([4, 12, 13]);
  });

  it("insert does not rewrite existing priorities (no renumber pass)", async () => {
    const P = `b7-norewrite-${Date.now()}-3`;
    await seed(P, 10);
    const before = (await db.getProviderConnections({ provider: P })).map((c) => [c.id, c.priority]);

    const adapter = global._dbAdapter?.instance;
    const runSpy = adapter && typeof adapter.run === "function" ? vi.spyOn(adapter, "run") : null;
    try {
      await db.createProviderConnection({ provider: P, authType: "apikey", name: "fresh", apiKey: "k-fresh" });
      if (runSpy) {
        const priorityUpdates = runSpy.mock.calls.filter(([sql]) =>
          typeof sql === "string" && /UPDATE\s+providerConnections\s+SET\s+priority/i.test(sql)
        );
        expect(priorityUpdates).toHaveLength(0);
      }
    } finally {
      if (runSpy) runSpy.mockRestore();
    }

    const afterMap = new Map((await db.getProviderConnections({ provider: P })).map((c) => [c.id, c.priority]));
    for (const [id, prio] of before) expect(afterMap.get(id)).toBe(prio);
  });

  it("keeps a large pool in insertion order", async () => {
    const P = `b7-ord-${Date.now()}-4`;
    await seed(P, 60);
    const list = await db.getProviderConnections({ provider: P });
    expect(list).toHaveLength(60);
    expect(list[0].name).toBe("seed-0");
    expect(list[59].name).toBe("seed-59");
    for (let i = 1; i < list.length; i++) {
      expect(list[i].priority).toBeGreaterThan(list[i - 1].priority);
    }
  });

  it("still renumbers on delete, so gaps do not accumulate", async () => {
    const P = `b7-del-${Date.now()}-5`;
    await seed(P, 4);
    const before = await db.getProviderConnections({ provider: P });
    await db.deleteProviderConnection(before[0].id);
    const after = await db.getProviderConnections({ provider: P });
    expect(after.map((c) => c.priority)).toEqual([1, 2, 3]);
  });

  it("still renumbers on an explicit priority update", async () => {
    const P = `b7-upd-${Date.now()}-6`;
    await seed(P, 4);
    await new Promise((r) => setTimeout(r, 10));
    const list = await db.getProviderConnections({ provider: P });
    await db.updateProviderConnection(list[3].id, { priority: 1 });
    const after = await db.getProviderConnections({ provider: P });
    expect(after[0].name).toBe("seed-3");
  });
});

describe("name collision no longer destroys a key silently (#4311)", () => {
  const P = `b7-clash-${Date.now()}-7`;
  let orig;
  beforeAll(async () => {
    await seed(P, 1);
    orig = (await db.getProviderConnections({ provider: P }))[0];
  });

  it("throws a typed conflict instead of overwriting, when overwrite is refused", async () => {
    await expect(
      db.createProviderConnection({
        provider: P,
        authType: "apikey",
        name: orig.name,
        apiKey: "REPLACEMENT-KEY",
        allowOverwrite: false,
      })
    ).rejects.toMatchObject({ code: "PROVIDER_NAME_CONFLICT", existingId: orig.id });
    const after = (await db.getProviderConnections({ provider: P }))[0];
    expect(after.apiKey).toBe(orig.apiKey);
  });

  it("still overwrites when the caller opts in", async () => {
    const updated = await db.createProviderConnection({
      provider: P,
      authType: "apikey",
      name: orig.name,
      apiKey: "REPLACEMENT-KEY",
      allowOverwrite: true,
    });
    expect(updated.id).toBe(orig.id);
    const after = (await db.getProviderConnections({ provider: P }))[0];
    expect(after.apiKey).toBe("REPLACEMENT-KEY");
  });

  it("defaults to the previous overwrite behaviour for existing callers", async () => {
    const updated = await db.createProviderConnection({
      provider: P,
      authType: "apikey",
      name: orig.name,
      apiKey: "LEGACY-PATH-KEY",
    });
    expect(updated.id).toBe(orig.id);
  });

  it("does not collide across different providers", async () => {
    const other = await db.createProviderConnection({
      provider: "b7-other-provider",
      authType: "apikey",
      name: orig.name,
      apiKey: "other-key",
    });
    expect(other.id).not.toBe(orig.id);
  });
});

describe("OAuth dedup and activation health are preserved", () => {
  it("codex rows with different workspace ids stay distinct", async () => {
    const P = `b7-codex-${Date.now()}-8`;
    const mk = (ws) => db.createProviderConnection({
      provider: "codex", authType: "oauth", email: "same@example.com",
      accessToken: `tok-${ws}`, refreshToken: `ref-${ws}`,
      providerSpecificData: { chatgptAccountId: ws },
    });
    const first = await mk("ws-1");
    const second = await mk("ws-2");
    expect(second.id).not.toBe(first.id);
    const again = await mk("ws-1");
    expect(again.id).toBe(first.id);
  });

  it("cross-IdP accounts with one-sided usernames stay distinct", async () => {
    const P = `b7-idp-${Date.now()}-9`;
    const bare = await db.createProviderConnection({ provider: P, authType: "oauth", email: "u@example.com", accessToken: "t0" });
    const named = await db.createProviderConnection({
      provider: P, authType: "oauth", email: "u@example.com", accessToken: "t1",
      providerSpecificData: { username: "someone" },
    });
    expect(named.id).not.toBe(bare.id);
  });

  it("activating a connection resets error health state", async () => {
    const P = `b7-health-${Date.now()}-10`;
    const created = await db.createProviderConnection({
      provider: P, authType: "oauth", email: "h@example.com", accessToken: "t",
      testStatus: "error", lastError: "boom", errorCode: "E1",
    });
    expect(created.errorCode).toBe("E1");
    const reactivated = await db.createProviderConnection({
      provider: P, authType: "oauth", email: "h@example.com", accessToken: "t2", testStatus: "active",
    });
    expect(reactivated.id).toBe(created.id);
    expect(reactivated.testStatus).toBe("active");
    expect(reactivated.errorCode).toBeNull();
  });
});
