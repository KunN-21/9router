/**
 * The sql.js fallback rewrote the database in place.
 *
 * sql.js has no incremental write path: every save exports the whole image and
 * writes it back. `fs.writeFileSync` opens with O_TRUNC, so the previous version
 * was destroyed before the new one existed — for the length of that write the file
 * on disk was 0 bytes and then partial, a window that grows with the database and
 * recurs on every save.
 *
 * sql.js is the driver that always works (no native build), so this is what a user
 * without build tools runs on. A crash mid-write left them with no database at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";

const SQLITE_MAGIC = "SQLite format 3\0";

let dir;
let dbPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sqljs-"));
  dbPath = path.join(dir, "data.sqlite");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Everything in the db directory that is not the database itself. */
function strayFiles() {
  return fs.readdirSync(dir).filter((name) => name !== "data.sqlite");
}

async function seededAdapter() {
  const adapter = await createSqlJsAdapter(dbPath);
  adapter.run("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)");
  adapter.run("INSERT INTO t(v) VALUES(?)", ["first"]);
  return adapter;
}

describe("sql.js adapter persistence", () => {
  it("writes a valid database and leaves no temp file behind", async () => {
    const adapter = await seededAdapter();
    adapter.close();

    const buf = fs.readFileSync(dbPath);
    expect(buf.subarray(0, SQLITE_MAGIC.length).toString("binary")).toBe(SQLITE_MAGIC);
    expect(strayFiles()).toEqual([]);
  });

  it("keeps the previous database when the write fails mid-flight", async () => {
    const adapter = await seededAdapter();
    adapter.close();
    const before = fs.readFileSync(dbPath);

    const second = await createSqlJsAdapter(dbPath);
    second.run("INSERT INTO t(v) VALUES(?)", ["second"]);

    // Fail after the temp file has been opened — the crash window the old
    // in-place write could not survive.
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (typeof target === "number") throw new Error("simulated disk failure");
      return realWrite(target, data, options);
    });

    expect(() => second.close()).toThrow(/simulated disk failure/);

    // The database that was already on disk is untouched, and nothing was left over.
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(strayFiles()).toEqual([]);
  });

  it("stages the temp file next to the database, not in the system temp dir", async () => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.run("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)");

    const staged = [];
    const realOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      staged.push(String(target));
      return realOpen(target, flags, mode);
    });

    adapter.run("INSERT INTO t(v) VALUES(?)", ["x"]);
    adapter.close();

    const tempPaths = staged.filter((p) => p.includes(".tmp-"));
    expect(tempPaths.length).toBeGreaterThan(0);
    // rename() is only atomic within one filesystem — a sibling guarantees that.
    for (const p of tempPaths) expect(path.dirname(p)).toBe(dir);
  });

  it("survives repeated saves without accumulating temp files", async () => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.run("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)");
    for (let i = 0; i < 5; i++) adapter.run("INSERT INTO t(v) VALUES(?)", [`v${i}`]);
    adapter.close();

    const reopened = await createSqlJsAdapter(dbPath);
    expect(reopened.get("SELECT COUNT(*) AS c FROM t").c).toBe(5);
    reopened.close();
    expect(strayFiles()).toEqual([]);
  });

  it("releases the handle when persist fails during close", async () => {
    const adapter = await seededAdapter();
    adapter.close();
    const before = fs.readFileSync(dbPath);

    const second = await createSqlJsAdapter(dbPath);
    second.run("INSERT INTO t(v) VALUES(?)", ["second"]);
    const closeSpy = vi.spyOn(second.raw, "close");

    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (typeof target === "number") throw new Error("simulated disk failure");
      return realWrite(target, data, options);
    });

    expect(() => second.close()).toThrow(/simulated disk failure/);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(strayFiles()).toEqual([]);
  });

  it("cleans up the temp file when closeSync fails", async () => {
    const adapter = await seededAdapter();
    adapter.close();
    const before = fs.readFileSync(dbPath);

    const second = await createSqlJsAdapter(dbPath);
    second.run("INSERT INTO t(v) VALUES(?)", ["second"]);

    // One-shot: only persist's close fails. A permanent mock would also break
    // fs.readFileSync below, which closes its fd via closeSync internally.
    vi.spyOn(fs, "closeSync").mockImplementationOnce(() => {
      throw new Error("simulated close failure");
    });

    expect(() => second.close()).toThrow(/simulated close failure/);
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(strayFiles()).toEqual([]);
  });

  it("preserves the existing database file mode on publish", async () => {
    const adapter = await seededAdapter();
    adapter.close();
    const expectedMode = fs.statSync(dbPath).mode & 0o777;

    const second = await createSqlJsAdapter(dbPath);
    second.run("INSERT INTO t(v) VALUES(?)", ["second"]);

    const modes = [];
    const realOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (String(target).includes(".tmp-")) modes.push(mode);
      return realOpen(target, flags, mode);
    });
    second.close();

    expect(modes.length).toBeGreaterThan(0);
    for (const m of modes) expect(m).toBe(expectedMode);
    expect(fs.statSync(dbPath).mode & 0o777).toBe(expectedMode);
  });

  it("uses a restrictive default mode for a new database", async () => {
    const modes = [];
    const realOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (String(target).includes(".tmp-")) modes.push(mode);
      return realOpen(target, flags, mode);
    });

    const adapter = await createSqlJsAdapter(dbPath);
    adapter.run("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)");
    adapter.close();

    expect(modes.length).toBeGreaterThan(0);
    for (const m of modes) expect(m).toBe(0o600);
  });
});
