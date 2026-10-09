import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import EventEmitter from "node:events";
import { createRequire } from "node:module";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const require = createRequire(import.meta.url);
const cliPath = path.resolve(__dirname, "../../cli/cli.js");

const rawCliCode = fs.readFileSync(cliPath, "utf8").replace(/^#!.*?\r?\n/, "");
const instrumentedCode = rawCliCode.replace(
  /const updatePromise = checkForUpdate\(\);[\s\S]*?\.then\(\(\) => startServer\(updatePromise\)\);/,
  "globalThis.startServer = startServer;"
);
const wrappedCliCode = `(function(exports, require, module, __filename, __dirname) {\n${instrumentedCode}\n})`;

function createHarness({ trayMode = true, platform = "win32" } = {}) {
  const spawnedChildren = [];
  const exits = [];

  function createMockChild() {
    const child = new EventEmitter();
    child.pid = 1000 + spawnedChildren.length;
    child.stderr = new EventEmitter();
    spawnedChildren.push(child);
    return child;
  }

  const mockProcess = new EventEmitter();
  mockProcess.platform = platform;
  mockProcess.execPath = process.execPath;
  mockProcess.pid = 9999;
  mockProcess.env = {};
  mockProcess.argv = ["node", cliPath, ...(trayMode ? ["--tray"] : [])];
  mockProcess.exit = vi.fn((code) => { exits.push(code); });
  mockProcess.kill = vi.fn();
  mockProcess.stdin = { isTTY: false };
  mockProcess.stdout = { isTTY: false, write: () => {} };
  mockProcess.stderr = { isTTY: false, write: () => {} };

  const mockFs = {
    ...fs,
    existsSync: vi.fn((p) => {
      if (typeof p === "string" && (p.includes("custom-server.js") || p.includes("server.js"))) return true;
      return false;
    }),
    readFileSync: vi.fn(() => {
      throw new Error("fs.readFileSync stubbed in lifecycle test");
    }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };

  const trayInitMock = vi.fn();
  const mockTray = {
    initTray: trayInitMock,
    killTray: vi.fn(),
  };

  const mockNet = {
    connect: vi.fn((opts, cb) => {
      const socket = new EventEmitter();
      socket.destroy = vi.fn();
      if (typeof cb === "function") {
        queueMicrotask(cb);
      }
      return socket;
    }),
  };

  const mockOs = {
    ...require("node:os"),
    homedir: vi.fn(() => "/tmp/fake-home-9router-test"),
    networkInterfaces: vi.fn(() => ({})),
  };

  const mockHttps = {
    get: vi.fn(() => {
      throw new Error("network stubbed in lifecycle test");
    }),
  };

  const mockChildProcess = {
    spawn: vi.fn((...args) => createMockChild()),
    exec: vi.fn(),
    execSync: vi.fn(() => ""),
  };

  const sandbox = {
    process: mockProcess,
    require: (mod) => {
      if (mod === "child_process") return mockChildProcess;
      if (mod === "fs") return mockFs;
      if (mod === "path") return path;
      if (mod === "os") return mockOs;
      if (mod === "net") return mockNet;
      if (mod === "https") return mockHttps;
      if (mod.includes("package.json")) return require("../../cli/package.json");
      if (mod.includes("sqliteRuntime")) return { ensureSqliteRuntime: vi.fn(), buildEnvWithRuntime: (e) => e };
      if (mod.includes("trayRuntime")) return { ensureTrayRuntime: vi.fn() };
      if (mod.includes("tray")) return mockTray;
      return require(path.resolve(__dirname, "../../cli", mod));
    },
    __dirname: path.resolve(__dirname, "../../cli"),
    __filename: cliPath,
    console: {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    Date,
    Promise,
    Buffer,
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const fn = vm.runInContext(wrappedCliCode, sandbox);
  const moduleObj = { exports: {} };
  fn(moduleObj.exports, sandbox.require, moduleObj, sandbox.__filename, sandbox.__dirname);

  return {
    startServer: sandbox.startServer,
    spawnedChildren,
    exits,
    mockProcess,
    trayInitMock,
  };
}

describe("CLI server lifecycle attachment and restart behavior (PR 4522)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Assert cleanup fake timer count: no unhandled/leaked timers masked with clearAllTimers
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("trayMode=true childclose nonzero triggers restart", () => {
    const harness = createHarness({ trayMode: true });
    harness.startServer(Promise.resolve("0.0.0"));

    expect(harness.spawnedChildren.length).toBe(1);
    const child1 = harness.spawnedChildren[0];

    // Non-zero exit code triggers restart
    child1.emit("close", 1);
    expect(harness.mockProcess.exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // Advance fake timer to restart delay (1000ms for first restart)
    vi.advanceTimersByTime(1000);
    expect(harness.spawnedChildren.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("error handler attached before tray init so fake error is not unhandled", () => {
    const harness = createHarness({ trayMode: true });
    harness.startServer(Promise.resolve("0.0.0"));

    const child1 = harness.spawnedChildren[0];
    expect(child1.listenerCount("error")).toBe(1);
    expect(harness.trayInitMock).not.toHaveBeenCalled();

    // Emitting error must not throw uncaught 'Unhandled error' exception
    expect(() => {
      child1.emit("error", new Error("fake spawn error"));
    }).not.toThrow();

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(harness.spawnedChildren.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normal zero exit does not trigger restart", () => {
    const harness = createHarness({ trayMode: true });
    harness.startServer(Promise.resolve("0.0.0"));

    const child1 = harness.spawnedChildren[0];
    child1.emit("close", 0);

    expect(harness.mockProcess.exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.spawnedChildren.length).toBe(1);
  });

  it("restarted child listener attaches to the correct new instance", () => {
    const harness = createHarness({ trayMode: true });
    harness.startServer(Promise.resolve("0.0.0"));

    const child1 = harness.spawnedChildren[0];
    child1.emit("close", 1);
    vi.advanceTimersByTime(1000);

    expect(harness.spawnedChildren.length).toBe(2);
    const child2 = harness.spawnedChildren[1];
    expect(child2).not.toBe(child1);
    expect(child2.listenerCount("close")).toBe(1);
    expect(child2.listenerCount("error")).toBe(1);

    // Child 2 crash must trigger second restart (delay = 2000ms)
    child2.emit("close", 1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);

    expect(harness.spawnedChildren.length).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("parent shuts down does not restart child process", () => {
    const harness = createHarness({ trayMode: true });
    harness.startServer(Promise.resolve("0.0.0"));

    const child1 = harness.spawnedChildren[0];
    // Parent receives SIGINT -> initiates shutdown
    harness.mockProcess.emit("SIGINT");
    expect(vi.getTimerCount()).toBe(1); // 100ms exit timer

    // Child exits while parent is shutting down
    child1.emit("close", 1);
    expect(harness.mockProcess.exit).toHaveBeenCalledWith(1);
    // No additional restart timer scheduled, only original shutdown exit timer remains
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(100);
    expect(harness.mockProcess.exit).toHaveBeenCalledWith(0);
    expect(harness.spawnedChildren.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("error followed by close schedules exactly one restart", () => {
    const harness = createHarness({ trayMode: true });
    harness.startServer(Promise.resolve("0.0.0"));

    const child1 = harness.spawnedChildren[0];
    // In Node child_process, error is often followed by close — same child must restart once
    child1.emit("error", new Error("spawn error"));
    child1.emit("close", 1);

    expect(child1.listenerCount("error")).toBe(1);
    expect(child1.listenerCount("close")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(harness.spawnedChildren.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("later child failure gets its own retry after earlier error+close dedup", () => {
    const harness = createHarness({ trayMode: true });
    harness.startServer(Promise.resolve("0.0.0"));

    const child1 = harness.spawnedChildren[0];
    child1.emit("error", new Error("first spawn error"));
    child1.emit("close", 1);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(harness.spawnedChildren.length).toBe(2);

    const child2 = harness.spawnedChildren[1];
    expect(child2).not.toBe(child1);
    expect(child2.listenerCount("error")).toBe(1);
    expect(child2.listenerCount("close")).toBe(1);

    // Second child fails on its own — per-child guard resets, schedules one retry (delay 2000ms)
    child2.emit("error", new Error("second spawn error"));
    child2.emit("close", 1);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(2000);
    expect(harness.spawnedChildren.length).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shutdown during pending restart delay never spawns orphan", () => {
    const harness = createHarness({ trayMode: true });
    harness.startServer(Promise.resolve("0.0.0"));

    const child1 = harness.spawnedChildren[0];
    child1.emit("close", 1);
    expect(vi.getTimerCount()).toBe(1);

    // Parent shuts down while restart delay is pending
    harness.mockProcess.emit("SIGINT");
    expect(vi.getTimerCount()).toBe(2);

    vi.advanceTimersByTime(1000);
    expect(harness.spawnedChildren.length).toBe(1);
    expect(harness.mockProcess.exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
