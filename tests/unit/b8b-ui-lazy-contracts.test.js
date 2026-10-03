// B8b: static/AST wiring contracts — lazy charts, barrel, idle preload, marked, settings consumers, AllTime.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import * as babelParser from "@babel/parser";

const SRC = path.resolve(__dirname, "../../src");
const P = (...segs) => path.join(SRC, ...segs);
const read = (p) => fs.readFileSync(p, "utf-8");
const parse = (code) => babelParser.parse(code, { sourceType: "module", plugins: ["jsx"] });

function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const k of Object.keys(node)) {
    if (k === "parent") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((n) => walk(n, fn));
    else if (v && typeof v === "object") walk(v, fn);
  }
}

function remapImports(source, node, fnName = "mockImport") {
  const replacements = [];
  walk(node, (n) => {
    if (n.type === "ImportExpression") {
      replacements.push({
        start: n.start,
        end: n.end,
        text: `${fnName}(${source.slice(n.source.start, n.source.end)})`,
      });
    } else if (n.type === "CallExpression" && (n.callee?.type === "Import" || n.callee?.name === "import")) {
      const arg = n.arguments[0];
      replacements.push({
        start: n.start,
        end: n.end,
        text: `${fnName}(${source.slice(arg.start, arg.end)})`,
      });
    }
  });
  let body = source.slice(node.start, node.end);
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    body = body.slice(0, r.start - node.start) + r.text + body.slice(r.end - node.start);
  }
  return body;
}

function extractFnNode(ast, name) {
  let found = null;
  walk(ast, (n) => {
    if (found) return;
    if ((n.type === "VariableDeclarator" || n.type === "FunctionDeclaration") && n.id?.name === name) found = n;
  });
  if (!found) throw new Error(`function ${name} not found`);
  return found.init || found;
}

function extractUseMemoCallbackCode(code, ast) {
  let foundArg = null;
  walk(ast, (n) => {
    if (foundArg) return;
    if (n.type === "CallExpression" && n.callee?.name === "useMemo") {
      foundArg = n.arguments[0];
    }
  });
  if (!foundArg) throw new Error("useMemo not found");
  return code.slice(foundArg.start, foundArg.end);
}

describe("B8b UI lazy contracts", () => {
  it("UsageStats lazy-loads ProviderTopology and ALL three charts with ssr:false, wires props", () => {
    const code = read(P("shared/components/UsageStats.js"));
    const ast = parse(code);

    const dynamicDecls = {};
    walk(ast, (n) => {
      if (n.type === "VariableDeclarator" && n.init?.type === "CallExpression" && n.init.callee?.name === "dynamic") {
        const name = n.id.name;
        const secondArg = n.init.arguments[1];
        let ssrFalse = false;
        if (secondArg && secondArg.type === "ObjectExpression") {
          const prop = secondArg.properties.find((p) => p.key?.name === "ssr");
          if (prop && prop.value?.value === false) ssrFalse = true;
        }
        dynamicDecls[name] = { ssrFalse };
      }
    });

    expect(dynamicDecls["ProviderTopology"]?.ssrFalse).toBe(true);
    expect(dynamicDecls["UsageChart"]?.ssrFalse).toBe(true);
    expect(dynamicDecls["ProviderBarChart"]?.ssrFalse).toBe(true);
    expect(dynamicDecls["TopModelsChart"]?.ssrFalse).toBe(true);

    expect(code).toMatch(/stats\.byProvider/);
    expect(code).toMatch(/stats\.byModel/);
  });

  it("no remaining named UsageStats import from barrel; usage page direct-imports", () => {
    const barrel = read(P("shared/components/index.js"));
    expect(barrel).not.toMatch(/UsageStats/);
    const page = read(P("app/(dashboard)/dashboard/usage/page.js"));
    expect(page).toMatch(/from "@\/shared\/components\/UsageStats"/);

    const hits = [];
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scan(p); continue; }
        if (!e.name.endsWith(".js")) continue;
        const c = read(p);
        if (/\{\s*[^}]*UsageStats[^}]*\}\s*from\s*["']@\/shared\/components["']/.test(c)) hits.push(p);
      }
    };
    scan(SRC);
    expect(hits).toEqual([]);
  });

  it("DashboardLayout preloads idle with 4000/2500 fallback and cleanup (actual effect execution)", async () => {
    const code = read(P("shared/components/layouts/DashboardLayout.js"));
    const ast = parse(code);

    let effectNode = null;
    walk(ast, (n) => {
      if (effectNode) return;
      if (n.type === "CallExpression" && n.callee?.name === "useEffect") {
        effectNode = n.arguments[0];
      }
    });
    expect(effectNode).toBeTruthy();

    const remappedEffectCode = remapImports(code, effectNode, "mockImport");

    // Case 1: Browser with requestIdleCallback (timeout: 4000)
    let idleCb = null;
    let idleOpts = null;
    let cancelIdleId = null;
    const importCalls1 = [];

    const mockWindowIdle = {
      requestIdleCallback: (cb, opts) => {
        idleCb = cb;
        idleOpts = opts;
        return 77;
      },
      cancelIdleCallback: (id) => {
        cancelIdleId = id;
      },
    };

    const fn1 = new vm.Script(`(${remappedEffectCode})`);
    const cleanup1 = fn1.runInNewContext({
      window: mockWindowIdle,
      clearTimeout: () => {},
      setTimeout: () => {},
      mockImport: async (path) => {
        importCalls1.push(path);
        return {};
      },
    })();

    expect(idleOpts).toEqual({ timeout: 4000 });
    expect(typeof idleCb).toBe("function");

    // Zero imports before callback is invoked
    expect(importCalls1).toEqual([]);

    // Invoke captured idle callback -> exactly four imports executed
    idleCb();
    expect(importCalls1).toEqual([
      "@/shared/components/UsageStats",
      "@/app/(dashboard)/dashboard/usage/components/UsageChart",
      "@/app/(dashboard)/dashboard/usage/components/ProviderBarChart",
      "@/app/(dashboard)/dashboard/usage/components/TopModelsChart",
    ]);

    // Calling cleanup cancels idle callback
    expect(typeof cleanup1).toBe("function");
    cleanup1();
    expect(cancelIdleId).toBe(77);

    // Case 1b: Rejection fail-open: rejected dynamic imports do NOT throw unhandled
    let rejectIdleCb = null;
    const fnReject = new vm.Script(`(${remappedEffectCode})`);
    fnReject.runInNewContext({
      window: {
        requestIdleCallback: (cb) => { rejectIdleCb = cb; return 88; },
        cancelIdleCallback: () => {},
      },
      clearTimeout: () => {},
      setTimeout: () => {},
      mockImport: async (path) => {
        throw new Error("Simulated preload failure: " + path);
      },
    })();
    expect(() => rejectIdleCb()).not.toThrow();

    // Case 2: Browser without requestIdleCallback (fallback setTimeout 2500)
    let timerCb = null;
    let timerDelay = null;
    let clearedTimerId = null;
    const importCalls2 = [];
    const mockWindowFallback = {};

    const fn2 = new vm.Script(`(${remappedEffectCode})`);
    const cleanup2 = fn2.runInNewContext({
      window: mockWindowFallback,
      setTimeout: (cb, delay) => {
        timerCb = cb;
        timerDelay = delay;
        return 99;
      },
      clearTimeout: (id) => {
        clearedTimerId = id;
      },
      mockImport: async (path) => {
        importCalls2.push(path);
        return {};
      },
    })();

    expect(timerDelay).toBe(2500);
    expect(typeof timerCb).toBe("function");

    // Zero imports before timer fires
    expect(importCalls2).toEqual([]);

    // Invoke captured timer callback -> exactly four imports executed
    timerCb();
    expect(importCalls2).toEqual([
      "@/shared/components/UsageStats",
      "@/app/(dashboard)/dashboard/usage/components/UsageChart",
      "@/app/(dashboard)/dashboard/usage/components/ProviderBarChart",
      "@/app/(dashboard)/dashboard/usage/components/TopModelsChart",
    ]);

    cleanup2();
    expect(clearedTimerId).toBe(99);

    // Case 3: SSR (typeof window === "undefined")
    const fn3 = new vm.Script(`(${remappedEffectCode})`);
    const cleanup3 = fn3.runInNewContext({
      mockImport: async () => ({}),
    })();
    expect(cleanup3).toBeUndefined();
  });

  it("ChangelogModal lazy-loads marked on open only; closed modal has no fetch/import (actual effect execution)", async () => {
    const code = read(P("shared/components/ChangelogModal.js"));
    const ast = parse(code);

    const staticMarked = [];
    walk(ast, (n) => {
      if (n.type === "ImportDeclaration" && n.source.value === "marked") staticMarked.push(n);
    });
    expect(staticMarked).toEqual([]);

    let effectNode = null;
    walk(ast, (n) => {
      if (effectNode) return;
      if (n.type === "CallExpression" && n.callee?.name === "useEffect") {
        effectNode = n.arguments[0];
      }
    });
    expect(effectNode).toBeTruthy();

    // AST import-node span replacement (no regex)
    const remappedCode = remapImports(code, effectNode, "mockImportMarked");

    // Case 1: isOpen is false -> does NOT fetch or import
    let fetchCalls = 0;
    let importCalls = 0;
    const fnClosed = new vm.Script(`(${remappedCode})`);
    fnClosed.runInNewContext({
      isOpen: false,
      html: "",
      setLoading: () => {},
      setError: () => {},
      setHtml: () => {},
      fetch: () => { fetchCalls += 1; },
      mockImportMarked: () => { importCalls += 1; },
      GITHUB_CONFIG: { changelogUrl: "https://example.com/changelog" },
    })();
    expect(fetchCalls).toBe(0);
    expect(importCalls).toBe(0);

    // Case 2: isOpen is true but html is already cached -> does NOT fetch or import
    const fnCached = new vm.Script(`(${remappedCode})`);
    fnCached.runInNewContext({
      isOpen: true,
      html: "<p>cached</p>",
      setLoading: () => {},
      setError: () => {},
      setHtml: () => {},
      fetch: () => { fetchCalls += 1; },
      mockImportMarked: () => { importCalls += 1; },
      GITHUB_CONFIG: { changelogUrl: "https://example.com/changelog" },
    })();
    expect(fetchCalls).toBe(0);
    expect(importCalls).toBe(0);

    // Case 3: isOpen is true and html is empty -> fetches and parses marked (deterministic completion via setLoading(false))
    let loadingHistory = [];
    let errorHistory = [];
    let setHtmlResult = null;
    const importedModules = [];

    let doneResolve;
    const donePromise = new Promise((resolve) => { doneResolve = resolve; });

    const fnOpen = new vm.Script(`(${remappedCode})`);
    fnOpen.runInNewContext({
      isOpen: true,
      html: "",
      setLoading: (v) => {
        loadingHistory.push(v);
        if (v === false && loadingHistory.length > 1) doneResolve();
      },
      setError: (v) => errorHistory.push(v),
      setHtml: (v) => { setHtmlResult = v; },
      fetch: async () => ({
        ok: true,
        text: async () => "## Title\n\n- Fix 1",
      }),
      mockImportMarked: async (pkg) => {
        importedModules.push(pkg);
        return {
          marked: {
            setOptions: () => {},
            parse: (md) => `<h1>Parsed: ${md.slice(0, 7)}</h1>`,
          },
        };
      },
      GITHUB_CONFIG: { changelogUrl: "https://example.com/changelog" },
    })();

    await donePromise;
    expect(importedModules).toEqual(["marked"]);
    expect(loadingHistory).toEqual([true, false]);
    expect(errorHistory).toEqual([""]);
    expect(setHtmlResult).toContain("Parsed: ## Titl");

    // Case 4: fetch error -> records error and finishes loading (deterministic)
    loadingHistory = [];
    errorHistory = [];
    let doneErrResolve;
    const doneErrPromise = new Promise((resolve) => { doneErrResolve = resolve; });

    const fnError = new vm.Script(`(${remappedCode})`);
    fnError.runInNewContext({
      isOpen: true,
      html: "",
      setLoading: (v) => {
        loadingHistory.push(v);
        if (v === false && loadingHistory.length > 1) doneErrResolve();
      },
      setError: (v) => errorHistory.push(v),
      setHtml: () => {},
      fetch: async () => ({
        ok: false,
        status: 404,
      }),
      mockImportMarked: async () => ({ marked: {} }),
      GITHUB_CONFIG: { changelogUrl: "https://example.com/changelog" },
    })();

    await doneErrPromise;
    expect(loadingHistory).toEqual([true, false]);
    expect(errorHistory[errorHistory.length - 1]).toMatch(/HTTP 404/);

    // Case 5: import error (rejection) -> records error and finishes loading (deterministic)
    loadingHistory = [];
    errorHistory = [];
    let doneImportErrResolve;
    const doneImportErrPromise = new Promise((resolve) => { doneImportErrResolve = resolve; });

    const fnImportError = new vm.Script(`(${remappedCode})`);
    fnImportError.runInNewContext({
      isOpen: true,
      html: "",
      setLoading: (v) => {
        loadingHistory.push(v);
        if (v === false && loadingHistory.length > 1) doneImportErrResolve();
      },
      setError: (v) => errorHistory.push(v),
      setHtml: () => {},
      fetch: async () => ({
        ok: true,
        text: async () => "content",
      }),
      mockImportMarked: async () => {
        throw new Error("Failed to load chunk marked");
      },
      GITHUB_CONFIG: { changelogUrl: "https://example.com/changelog" },
    })();

    await doneImportErrPromise;
    expect(loadingHistory).toEqual([true, false]);
    expect(errorHistory[errorHistory.length - 1]).toBe("Failed to load chunk marked");
  });

  it("Endpoint load/tunnel/requireApiKey and Sidebar settings effects execute correctly via store", async () => {
    const epCode = read(P("app/(dashboard)/dashboard/endpoint/EndpointPageClient.js"));
    const epAst = parse(epCode);

    // Extract loadSettings, handleRequireApiKey, handleTunnelDashboardAccess
    const loadSettingsNode = extractFnNode(epAst, "loadSettings");
    const loadSettingsCode = epCode.slice(loadSettingsNode.start, loadSettingsNode.end);

    const handleReqKeyNode = extractFnNode(epAst, "handleRequireApiKey");
    const handleReqKeyCode = epCode.slice(handleReqKeyNode.start, handleReqKeyNode.end);

    const handleTunnelNode = extractFnNode(epAst, "handleTunnelDashboardAccess");
    const handleTunnelCode = epCode.slice(handleTunnelNode.start, handleTunnelNode.end);

    // Test loadSettings in vm with non-ok tunnel status (assert NO swallowed ReferenceError)
    let setReqKeyVal = null;
    let setReqLoginVal = null;
    let setHasPassVal = null;
    let setTunnelVal = null;
    let checkingHistory = [];
    const consoleLogs = [];

    const mockStore = {
      getState: () => ({
        fetchSettings: async () => ({
          requireApiKey: true,
          requireLogin: false,
          hasPassword: true,
          tunnelDashboardAccess: true,
        }),
      }),
    };

    const fnLoad = new vm.Script(`(${loadSettingsCode})`);
    await fnLoad.runInNewContext({
      useSettingsStore: mockStore,
      setTunnelChecking: (v) => checkingHistory.push(v),
      setRequireApiKey: (v) => { setReqKeyVal = v; },
      setRequireLogin: (v) => { setReqLoginVal = v; },
      setHasPassword: (v) => { setHasPassVal = v; },
      setTunnelDashboardAccess: (v) => { setTunnelVal = v; },
      // Non-ok tunnel status prevents executing unrelated tunnel client state deps
      fetch: async () => ({ ok: false, status: 503 }),
      console: { log: (...args) => consoleLogs.push(args) },
    })();

    // Assert catch console was NOT called due to fixture ReferenceError
    expect(consoleLogs).toEqual([]);
    expect(checkingHistory).toEqual([true, false]);
    expect(setReqKeyVal).toBe(true);
    expect(setReqLoginVal).toBe(false);
    expect(setHasPassVal).toBe(true);
    expect(setTunnelVal).toBe(true);

    // Test handleRequireApiKey: success, null (unchanged), rejected
    let patchedKey = null;
    let updatedReqKeyVal = null;
    let shouldRejectKey = false;
    const reqKeyLogs = [];
    const mockStoreReqKey = {
      getState: () => ({
        patchSettings: async (patch) => {
          patchedKey = patch;
          if (shouldRejectKey) throw new Error("patch network error");
          return patch.requireApiKey ? { requireApiKey: true } : null;
        },
      }),
    };

    const fnReqKey = new vm.Script(`(${handleReqKeyCode})`);
    // 1. Success call
    await fnReqKey.runInNewContext({
      useSettingsStore: mockStoreReqKey,
      setRequireApiKey: (v) => { updatedReqKeyVal = v; },
      console: { log: (...args) => reqKeyLogs.push(args) },
    })(true);
    expect(patchedKey).toEqual({ requireApiKey: true });
    expect(updatedReqKeyVal).toBe(true);

    // 2. Failure call (returns null -> state unchanged)
    updatedReqKeyVal = null;
    await fnReqKey.runInNewContext({
      useSettingsStore: mockStoreReqKey,
      setRequireApiKey: (v) => { updatedReqKeyVal = v; },
      console: { log: (...args) => reqKeyLogs.push(args) },
    })(false);
    expect(updatedReqKeyVal).toBeNull();

    // 3. Rejected call -> catch block logs error, state unchanged
    shouldRejectKey = true;
    updatedReqKeyVal = null;
    await fnReqKey.runInNewContext({
      useSettingsStore: mockStoreReqKey,
      setRequireApiKey: (v) => { updatedReqKeyVal = v; },
      console: { log: (...args) => reqKeyLogs.push(args) },
    })(true);
    expect(updatedReqKeyVal).toBeNull();
    expect(reqKeyLogs.length).toBe(1);
    expect(reqKeyLogs[0][0]).toMatch(/Error updating requireApiKey/);

    // Test handleTunnelDashboardAccess: success, null (unchanged), rejected
    let patchedTunnel = null;
    let updatedTunnelVal = null;
    let shouldRejectTunnel = false;
    const tunnelLogs = [];
    const mockStoreTunnel = {
      getState: () => ({
        patchSettings: async (patch) => {
          patchedTunnel = patch;
          if (shouldRejectTunnel) throw new Error("patch tunnel error");
          return patch.tunnelDashboardAccess ? { tunnelDashboardAccess: true } : null;
        },
      }),
    };

    const fnTunnel = new vm.Script(`(${handleTunnelCode})`);
    // 1. Success call
    await fnTunnel.runInNewContext({
      useSettingsStore: mockStoreTunnel,
      setTunnelDashboardAccess: (v) => { updatedTunnelVal = v; },
      console: { log: (...args) => tunnelLogs.push(args) },
    })(true);
    expect(patchedTunnel).toEqual({ tunnelDashboardAccess: true });
    expect(updatedTunnelVal).toBe(true);

    // 2. Failure call (returns null -> state unchanged)
    updatedTunnelVal = null;
    await fnTunnel.runInNewContext({
      useSettingsStore: mockStoreTunnel,
      setTunnelDashboardAccess: (v) => { updatedTunnelVal = v; },
      console: { log: (...args) => tunnelLogs.push(args) },
    })(false);
    expect(updatedTunnelVal).toBeNull();

    // 3. Rejected call -> catch block logs error, state unchanged
    shouldRejectTunnel = true;
    updatedTunnelVal = null;
    await fnTunnel.runInNewContext({
      useSettingsStore: mockStoreTunnel,
      setTunnelDashboardAccess: (v) => { updatedTunnelVal = v; },
      console: { log: (...args) => tunnelLogs.push(args) },
    })(true);
    expect(updatedTunnelVal).toBeNull();
    expect(tunnelLogs.length).toBe(1);
    expect(tunnelLogs[0][0]).toMatch(/Error updating tunnelDashboardAccess/);

    // Sidebar delayed version check effect: invoke timer, update setUpdateInfo, cleanup
    const sbCode = read(P("shared/components/Sidebar.js"));
    const sbAst = parse(sbCode);

    let versionEffectNode = null;
    walk(sbAst, (n) => {
      if (versionEffectNode) return;
      if (n.type === "CallExpression" && n.callee?.name === "useEffect") {
        const bodyCode = sbCode.slice(n.arguments[0].start, n.arguments[0].end);
        if (bodyCode.includes("/api/version") && bodyCode.includes("2500")) {
          versionEffectNode = n.arguments[0];
        }
      }
    });
    expect(versionEffectNode).toBeTruthy();
    const versionEffectCode = sbCode.slice(versionEffectNode.start, versionEffectNode.end);

    let sbTimerCb = null;
    let sbTimerDelay = null;
    let sbClearedId = null;
    let updateInfoResult = null;
    let updateInfoResolve;
    const updateInfoPromise = new Promise((resolve) => { updateInfoResolve = resolve; });

    const fnSbVersion = new vm.Script(`(${versionEffectCode})`);
    const sbCleanup = fnSbVersion.runInNewContext({
      setTimeout: (cb, delay) => {
        sbTimerCb = cb;
        sbTimerDelay = delay;
        return 333;
      },
      clearTimeout: (id) => { sbClearedId = id; },
      setUpdateInfo: (v) => {
        updateInfoResult = v;
        updateInfoResolve();
      },
      fetch: async (url) => {
        if (url === "/api/version") {
          return {
            json: async () => ({ hasUpdate: true, latestVersion: "0.5.91" }),
          };
        }
        return { json: async () => ({}) };
      },
    })();

    expect(sbTimerDelay).toBe(2500);
    expect(typeof sbTimerCb).toBe("function");

    // Invoke captured timer callback -> fetch /api/version and updates setUpdateInfo
    sbTimerCb();
    await updateInfoPromise;
    expect(updateInfoResult).toEqual({ hasUpdate: true, latestVersion: "0.5.91" });

    sbCleanup();
    expect(sbClearedId).toBe(333);
  });

  it("All option present in usage page and UsageStats selector; grids fit 6 columns", () => {
    const page = read(P("app/(dashboard)/dashboard/usage/page.js"));
    const stats = read(P("shared/components/UsageStats.js"));
    expect(page).toMatch(/\{ value: "all", label: "All" \}/);
    expect(stats).toMatch(/\{ value: "all", label: "All" \}/);
    expect(stats).toMatch(/grid-cols-6/);
  });

  it("chart useMemo callbacks evaluated in vm: empty, zero-token, metric sort, top5, and full identity", () => {
    const pbcCode = read(P("app/(dashboard)/dashboard/usage/components/ProviderBarChart.js"));
    const tmcCode = read(P("app/(dashboard)/dashboard/usage/components/TopModelsChart.js"));

    const pbcAst = parse(pbcCode);
    const tmcAst = parse(tmcCode);

    const pbcUseMemoCode = extractUseMemoCallbackCode(pbcCode, pbcAst);
    const tmcUseMemoCode = extractUseMemoCallbackCode(tmcCode, tmcAst);

    const evalPbc = (byProvider, viewMode) => {
      const fn = new vm.Script(`(${pbcUseMemoCode})`);
      return fn.runInNewContext({ byProvider, viewMode, Object })();
    };

    const evalTmc = (byModel, viewMode) => {
      const fn = new vm.Script(`(${tmcUseMemoCode})`);
      return fn.runInNewContext({ byModel, viewMode, Object })();
    };

    // 1. Empty / no-data returns []
    expect(evalPbc(null, "tokens")).toEqual([]);
    expect(evalPbc({}, "tokens")).toEqual([]);
    expect(evalTmc(null, "tokens")).toEqual([]);
    expect(evalTmc({}, "tokens")).toEqual([]);

    // 2. Zero-token requests
    const providerWithZeroTokens = {
      p1: { promptTokens: 0, completionTokens: 0, requests: 5 },
    };
    expect(evalPbc(providerWithZeroTokens, "tokens")).toEqual([]);
    expect(evalPbc(providerWithZeroTokens, "requests")).toEqual([
      { name: "p1", tokens: 0, requests: 5 },
    ]);

    // 3. Metric switch sort: sorting adapts dynamically to viewMode
    const multiProviders = {
      provHighTokens: { promptTokens: 500, completionTokens: 500, requests: 2 },
      provHighReqs: { promptTokens: 10, completionTokens: 10, requests: 100 },
    };
    const tokenSorted = evalPbc(multiProviders, "tokens");
    expect(tokenSorted.map((p) => p.name)).toEqual(["provHighTokens", "provHighReqs"]);

    const reqSorted = evalPbc(multiProviders, "requests");
    expect(reqSorted.map((p) => p.name)).toEqual(["provHighReqs", "provHighTokens"]);

    // 4. Top 5 boundary for TopModelsChart
    const sevenModels = {
      m1: { rawModel: "model-1", promptTokens: 10, requests: 1 },
      m2: { rawModel: "model-2", promptTokens: 20, requests: 2 },
      m3: { rawModel: "model-3", promptTokens: 30, requests: 3 },
      m4: { rawModel: "model-4", promptTokens: 40, requests: 4 },
      m5: { rawModel: "model-5", promptTokens: 50, requests: 5 },
      m6: { rawModel: "model-6", promptTokens: 60, requests: 6 },
      m7: { rawModel: "model-7", promptTokens: 70, requests: 7 },
    };
    const top5 = evalTmc(sevenModels, "requests");
    expect(top5.length).toBe(5);
    expect(top5[0].requests).toBe(7);
    expect(top5[4].requests).toBe(3);

    // 5. Full model identity (B8b-MAIN-03): two models sharing long 28-character prefix
    const twoPrefixedModels = {
      m1: { rawModel: "anthropic/claude-3-5-sonnet-20241022", promptTokens: 100, requests: 1 },
      m2: { rawModel: "anthropic/claude-3-5-sonnet-20240620", promptTokens: 80, requests: 2 },
    };
    const prefixChartData = evalTmc(twoPrefixedModels, "tokens");
    expect(prefixChartData.length).toBe(2);
    // Crucial: full names must NOT be truncated to identical strings in chartData!
    expect(prefixChartData[0].name).not.toBe(prefixChartData[1].name);
    expect(prefixChartData[0].name).toBe("anthropic/claude-3-5-sonnet-20241022");
    expect(prefixChartData[1].name).toBe("anthropic/claude-3-5-sonnet-20240620");

    // YAxis truncates for axis layout via tickFormatter, Tooltip has labelFormatter
    expect(tmcCode).toMatch(/tickFormatter=\{/);
    expect(tmcCode).toMatch(/labelFormatter=\{/);
  });

  it("Breakdown charts eliminate rank/modulo palette, use metric fill, accessible group name, and table", () => {
    const pbcCode = read(P("app/(dashboard)/dashboard/usage/components/ProviderBarChart.js"));
    const tmcCode = read(P("app/(dashboard)/dashboard/usage/components/TopModelsChart.js"));

    // Hard check: COLORS rank array and Cell modulo mapping are REMOVED
    expect(pbcCode).not.toMatch(/COLORS\[i\s*%\s*COLORS\.length\]/);
    expect(tmcCode).not.toMatch(/COLORS\[i\s*%\s*COLORS\.length\]/);

    // Consistent metric fills: Tokens uses #6366f1, Requests uses #14b8a6
    expect(pbcCode).toMatch(/#6366f1/);
    expect(pbcCode).toMatch(/#14b8a6/);
    expect(tmcCode).toMatch(/#6366f1/);
    expect(tmcCode).toMatch(/#14b8a6/);

    // Native accessible group names
    expect(pbcCode).toMatch(/role="group"/);
    expect(pbcCode).toMatch(/aria-label=\{["']Provider usage by ["']\s*\+\s*label\.toLowerCase\(\)\}/);
    expect(tmcCode).toMatch(/role="group"/);
    expect(tmcCode).toMatch(/aria-label=\{["']Top models usage by ["']\s*\+\s*label\.toLowerCase\(\)\}/);

    // Accessible table view for non-visual / non-hover reading
    expect(pbcCode).toMatch(/<table/);
    expect(pbcCode).toMatch(/aria-label="Provider usage table"/);
    expect(pbcCode).toMatch(/<summary.*View table/);
    expect(tmcCode).toMatch(/<table/);
    expect(tmcCode).toMatch(/aria-label="Top models usage table"/);
    expect(tmcCode).toMatch(/<summary.*View table/);
  });
});