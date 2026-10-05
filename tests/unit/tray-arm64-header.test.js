import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, beforeEach, afterEach } from "vitest";

const require = createRequire(import.meta.url);
const trayRuntime = require("../../cli/hooks/trayRuntime");

describe("cli/hooks/trayRuntime ARM64 & Mach-O Header", () => {
  const tempFiles = [];

  function createTempFile(content) {
    const tmp = path.join(os.tmpdir(), `tray-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(tmp, content);
    tempFiles.push(tmp);
    return tmp;
  }

  afterEach(() => {
    for (const f of tempFiles.splice(0)) {
      try { fs.rmSync(f, { force: true }); } catch {}
    }
  });

  it("exports ensureArm64TrayBin and isArm64MachO", () => {
    assert.strictEqual(typeof trayRuntime.ensureArm64TrayBin, "function");
    assert.strictEqual(typeof trayRuntime.isArm64MachO, "function");
  });

  it("identifies valid thin 64-bit ARM64 Mach-O header", () => {
    // 0xfeedfacf (little-endian: cf fa ed fe) + 0x0100000c (little-endian: 0c 00 00 01)
    const validArm64 = Buffer.alloc(8);
    validArm64.writeUInt32LE(0xfeedfacf, 0);
    validArm64.writeUInt32LE(0x0100000c, 4);

    const file = createTempFile(validArm64);
    assert.strictEqual(trayRuntime.isArm64MachO(file), true);
  });

  it("rejects x86_64 or corrupt Mach-O headers", () => {
    // x86_64: 0xfeedfacf + 0x01000007 (CPU_TYPE_X86_64)
    const x86_64 = Buffer.alloc(8);
    x86_64.writeUInt32LE(0xfeedfacf, 0);
    x86_64.writeUInt32LE(0x01000007, 4);
    const file1 = createTempFile(x86_64);
    assert.strictEqual(trayRuntime.isArm64MachO(file1), false);

    // Garbage buffer
    const garbage = Buffer.from("NOT_A_MACHO_BINARY");
    const file2 = createTempFile(garbage);
    assert.strictEqual(trayRuntime.isArm64MachO(file2), false);

    // Short buffer (<8 bytes)
    const shortBuf = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
    const file3 = createTempFile(shortBuf);
    assert.strictEqual(trayRuntime.isArm64MachO(file3), false);

    // Non-existent file
    assert.strictEqual(trayRuntime.isArm64MachO("/path/to/nonexistent/file"), false);

    // Empty file (0 bytes)
    const emptyFile = createTempFile(Buffer.alloc(0));
    assert.strictEqual(trayRuntime.isArm64MachO(emptyFile), false);
  });

  it("skips ARM64 check on non-darwin platforms (e.g. win32)", () => {
    if (process.platform === "win32") {
      const result = trayRuntime.ensureArm64TrayBin();
      assert.deepStrictEqual(result, { skipped: true });
    }
  });

  it("returns { skipped: true } from ensureTrayRuntime on win32", () => {
    if (process.platform === "win32") {
      const result = trayRuntime.ensureTrayRuntime({ silent: true });
      assert.strictEqual(result.skipped, true);
    }
  });

  it("verifies ARM64_TRAY_SHA256 pin in trayRuntime.js source", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../cli/hooks/trayRuntime.js"), "utf8");
    const match = src.match(/ARM64_TRAY_SHA256\s*=\s*"([0-9a-f]{64})"/);
    assert.ok(match, "ARM64_TRAY_SHA256 constant must exist and be 64-char hex");
    assert.strictEqual(match[1], "487e3c365aaa1eb6ad295bf3989711e975b52cee07505bf641c8559954881c81");
  });
});
