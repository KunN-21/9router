import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import vm from "vm";
import * as babelParser from "@babel/parser";

const COMBOS_PAGE_PATH = path.resolve(__dirname, "../../src/app/(dashboard)/dashboard/combos/page.js");
const SIDEBAR_PATH = path.resolve(__dirname, "../../src/shared/components/Sidebar.js");
const GENERIC_EXAMPLE_CARD_PATH = path.resolve(
  __dirname,
  "../../src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/GenericExampleCard.js"
);

function parseJsx(filePath) {
  const code = fs.readFileSync(filePath, "utf-8");
  return {
    code,
    ast: babelParser.parse(code, {
      sourceType: "module",
      plugins: ["jsx"],
    }),
  };
}

function findDecl(ast, name) {
  let found = null;
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator" && node.id && node.id.name === name) {
      found = node;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const val = node[key];
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object") walk(val);
    }
  }
  walk(ast);
  return found;
}

function extractHandlerCode(ast, code, name) {
  const decl = findDecl(ast, name);
  if (!decl) throw new Error(`Handler declaration "${name}" not found in AST`);
  return code.slice(decl.init.start, decl.init.end);
}

describe("B8a UI Contracts: AST Wiring & Static Checks", () => {
  it("verifies green NEW badge styling in Sidebar AST (static structural check)", () => {
    const { ast } = parseJsx(SIDEBAR_PATH);
    let foundActiveGreenBadge = false;

    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "JSXElement" && node.openingElement) {
        const classAttr = node.openingElement.attributes?.find(
          (a) => a.type === "JSXAttribute" && a.name?.name === "className"
        );
        const classVal = classAttr?.value?.value || "";
        if (classVal.includes("bg-green-500/15") && classVal.includes("text-green-400")) {
          const hasNewText = node.children?.some(
            (c) => c.type === "JSXText" && c.value.trim() === "NEW"
          );
          if (hasNewText) {
            foundActiveGreenBadge = true;
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const val = node[key];
        if (Array.isArray(val)) val.forEach(walk);
        else if (val && typeof val === "object") walk(val);
      }
    }
    walk(ast);
    expect(foundActiveGreenBadge).toBe(true);
  });

  it("verifies GenericExampleCard question hook precedes early returns and binds System One question (AST check)", () => {
    const { ast, code } = parseJsx(GENERIC_EXAMPLE_CARD_PATH);
    let questionHookLine = 0;
    let firstEarlyReturnLine = Infinity;

    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "VariableDeclarator" &&
        node.id?.type === "ArrayPattern" &&
        node.id.elements?.[0]?.name === "question"
      ) {
        questionHookLine = node.loc.start.line;
      }
      if (node.type === "FunctionDeclaration" && node.id?.name === "GenericExampleCard") {
        for (const stmt of node.body.body) {
          if (stmt.type === "IfStatement" && stmt.consequent?.type === "ReturnStatement") {
            if (stmt.consequent.loc.start.line < firstEarlyReturnLine) {
              firstEarlyReturnLine = stmt.consequent.loc.start.line;
            }
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const val = node[key];
        if (Array.isArray(val)) val.forEach(walk);
        else if (val && typeof val === "object") walk(val);
      }
    }
    walk(ast);

    // Rule of hooks: hook declared before any component early return
    expect(questionHookLine).toBeGreaterThan(0);
    expect(questionHookLine).toBeLessThan(firstEarlyReturnLine);

    // Question input element and systemoneQuestions structure
    expect(code).toContain('kind === "systemone"');
    expect(code).toContain('aria-label="Evaluation question"');
    expect(code).toContain('type: "noul"');
    expect(code).toContain('instructions: question.trim() || "Does this request require urgent attention?"');
  });

  it("verifies CombosPage static AST structure: hidden presets, ConfirmModal, and ordered table", () => {
    const { ast, code } = parseJsx(COMBOS_PAGE_PATH);
    let foundHiddenWrapper = false;
    let foundConfirmModal = false;
    let foundTable = false;

    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "JSXElement" && node.openingElement) {
        const tag = node.openingElement.name?.name;
        if (tag === "ConfirmModal") {
          foundConfirmModal = true;
        }
        if (tag === "table") {
          foundTable = true;
        }
        const classAttr = node.openingElement.attributes?.find(
          (a) => a.type === "JSXAttribute" && a.name?.name === "className"
        );
        const classVal = classAttr?.value?.value || "";
        if (classVal === "hidden") {
          foundHiddenWrapper = true;
        }
      }
      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const val = node[key];
        if (Array.isArray(val)) val.forEach(walk);
        else if (val && typeof val === "object") walk(val);
      }
    }
    walk(ast);

    expect(foundHiddenWrapper).toBe(true);
    expect(foundConfirmModal).toBe(true);
    expect(foundTable).toBe(true);
    expect(code).toContain("Cursor Default");
    expect(code).toContain("Claude Default");
    expect(code).toContain("free default");
  });
});

describe("B8a UI Contracts: Actual AST Closure Execution", () => {
  const { ast, code } = parseJsx(COMBOS_PAGE_PATH);

  const pruneCode = extractHandlerCode(ast, code, "pruneStrategiesForNames");
  const persistCode = extractHandlerCode(ast, code, "persistComboStrategies");
  const singleDeleteCode = extractHandlerCode(ast, code, "handleDelete");
  const bulkDeleteCode = extractHandlerCode(ast, code, "handleBulkDelete");
  const moveCode = extractHandlerCode(ast, code, "handleMove");
  const removeCode = extractHandlerCode(ast, code, "handleRemove");
  const deselectCode = extractHandlerCode(ast, code, "handleDeselect");
  const setStratCode = extractHandlerCode(ast, code, "handleSetComboStrategy");
  const bulkStratCode = extractHandlerCode(ast, code, "handleBulkSetStrategy");

  it("handleBulkDelete: opening modal sets danger confirmState; cancel makes no DELETE calls", async () => {
    const combos = [{ id: "c1", name: "combo-1" }, { id: "c2", name: "combo-2" }];
    let confirmState = null;
    let bulkBusy = false;
    const fetchCalls = [];

    const sandbox = {
      selectedCombos: [...combos],
      combos,
      selectedIds: ["c1", "c2"],
      comboStrategies: {},
      setConfirmState: (val) => { confirmState = typeof val === "function" ? val(confirmState) : val; },
      setBulkBusy: (val) => { bulkBusy = val; },
      setCombos: () => {},
      setSelectedIds: () => {},
      setComboStrategies: () => {},
      fetch: async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true }; },
      alert: () => {},
      console: { log: () => {} },
      Promise,
      Set,
      Error,
      JSON,
    };

    vm.createContext(sandbox);
    vm.runInContext(`
      var pruneStrategiesForNames = ${pruneCode};
      var persistComboStrategies = ${persistCode};
      var handleBulkDelete = ${bulkDeleteCode};
    `, sandbox);

    // Open confirmation modal
    sandbox.handleBulkDelete();
    expect(confirmState).not.toBeNull();
    expect(confirmState.variant).toBe("danger");
    expect(confirmState.confirmText).toBe("Delete");
    expect(confirmState.message).toContain("2 selected combos");
    expect(typeof confirmState.onConfirm).toBe("function");

    // Modal canceled by user (onConfirm never invoked)
    expect(fetchCalls.length).toBe(0);
  });

  it("handleBulkDelete: all deletions succeed and strategy is pruned", async () => {
    const combos = [{ id: "c1", name: "combo-1" }, { id: "c2", name: "combo-2" }];
    let currentCombos = [...combos];
    let selectedIds = ["c1", "c2"];
    let comboStrategies = {
      "combo-1": { fallbackStrategy: "fusion" },
      "combo-2": { fallbackStrategy: "round-robin" },
    };
    let confirmState = null;
    let bulkBusy = false;
    const alertCalls = [];

    const sandbox = {
      selectedCombos: [...combos],
      combos: currentCombos,
      selectedIds,
      comboStrategies,
      setConfirmState: (val) => { confirmState = typeof val === "function" ? val(confirmState) : val; },
      setBulkBusy: (val) => { bulkBusy = val; },
      setCombos: (fn) => { currentCombos = typeof fn === "function" ? fn(currentCombos) : fn; },
      setSelectedIds: (fn) => { selectedIds = typeof fn === "function" ? fn(selectedIds) : fn; },
      setComboStrategies: (val) => { comboStrategies = val; },
      fetch: async (url) => {
        if (url.startsWith("/api/combos/")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
        if (url === "/api/settings") return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return { ok: true, status: 200 };
      },
      alert: (msg) => { alertCalls.push(msg); },
      console: { log: () => {} },
      Promise,
      Set,
      Error,
      JSON,
    };

    vm.createContext(sandbox);
    vm.runInContext(`
      var pruneStrategiesForNames = ${pruneCode};
      var persistComboStrategies = ${persistCode};
      var handleBulkDelete = ${bulkDeleteCode};
    `, sandbox);

    sandbox.handleBulkDelete();
    await confirmState.onConfirm();

    expect(currentCombos).toEqual([]);
    expect(selectedIds).toEqual([]);
    expect(comboStrategies).toEqual({});
    expect(confirmState).toBeNull();
    expect(alertCalls.length).toBe(0);
  });

  it("handleBulkDelete: partial HTTP failure and network rejection preserves failed rows and selection", async () => {
    const combos = [
      { id: "c1", name: "good-combo" },
      { id: "c2", name: "server-fail" },
      { id: "c3", name: "network-fail" },
    ];
    let currentCombos = [...combos];
    let selectedIds = ["c1", "c2", "c3"];
    let comboStrategies = {
      "good-combo": { fallbackStrategy: "fusion" },
      "server-fail": { fallbackStrategy: "round-robin" },
      "network-fail": { fallbackStrategy: "fallback" },
    };
    let confirmState = null;
    let bulkBusy = false;
    const alertCalls = [];

    const sandbox = {
      selectedCombos: [...combos],
      combos: currentCombos,
      selectedIds,
      comboStrategies,
      setConfirmState: (val) => { confirmState = typeof val === "function" ? val(confirmState) : val; },
      setBulkBusy: (val) => { bulkBusy = val; },
      setCombos: (fn) => { currentCombos = typeof fn === "function" ? fn(currentCombos) : fn; },
      setSelectedIds: (fn) => { selectedIds = typeof fn === "function" ? fn(selectedIds) : fn; },
      setComboStrategies: (val) => { comboStrategies = val; },
      fetch: async (url) => {
        if (url === "/api/combos/c1") return { ok: true, status: 200 };
        if (url === "/api/combos/c2") return { ok: false, status: 500 };
        if (url === "/api/combos/c3") throw new Error("Network drop");
        if (url === "/api/settings") return { ok: true, status: 200 };
        return { ok: true };
      },
      alert: (msg) => { alertCalls.push(msg); },
      console: { log: () => {} },
      Promise,
      Set,
      Error,
      JSON,
    };

    vm.createContext(sandbox);
    vm.runInContext(`
      var pruneStrategiesForNames = ${pruneCode};
      var persistComboStrategies = ${persistCode};
      var handleBulkDelete = ${bulkDeleteCode};
    `, sandbox);

    sandbox.handleBulkDelete();
    await confirmState.onConfirm();

    // Succeeded combo c1 removed; failed combos c2 and c3 survive in list
    expect(currentCombos).toEqual([
      { id: "c2", name: "server-fail" },
      { id: "c3", name: "network-fail" },
    ]);
    // Failed combos remain selected so user can retry
    expect(selectedIds).toEqual(["c2", "c3"]);
    // Strategy only pruned for c1
    expect(comboStrategies).toEqual({
      "server-fail": { fallbackStrategy: "round-robin" },
      "network-fail": { fallbackStrategy: "fallback" },
    });
    expect(confirmState).toBeNull();
    expect(alertCalls.some((msg) => msg.includes("2 failures"))).toBe(true);
  });

  it("handleBulkDelete: reconciles successful deletion when strategy PATCH fails (MAIN-01)", async () => {
    const combos = [
      { id: "c1", name: "good-combo" },
      { id: "c2", name: "bad-combo" },
    ];
    let currentCombos = [...combos];
    let selectedIds = ["c1", "c2"];
    let comboStrategies = {
      "good-combo": { fallbackStrategy: "fusion" },
      "bad-combo": { fallbackStrategy: "round-robin" },
    };
    let confirmState = null;
    let bulkBusy = false;
    const alertCalls = [];

    const sandbox = {
      selectedCombos: [...combos],
      combos: currentCombos,
      selectedIds,
      comboStrategies,
      setConfirmState: (val) => { confirmState = typeof val === "function" ? val(confirmState) : val; },
      setBulkBusy: (val) => { bulkBusy = val; },
      setCombos: (fn) => { currentCombos = typeof fn === "function" ? fn(currentCombos) : fn; },
      setSelectedIds: (fn) => { selectedIds = typeof fn === "function" ? fn(selectedIds) : fn; },
      setComboStrategies: (val) => { comboStrategies = val; },
      fetch: async (url) => {
        if (url === "/api/combos/c1") return { ok: true, status: 200 };
        if (url === "/api/combos/c2") return { ok: false, status: 500 };
        if (url === "/api/settings") return { ok: false, status: 500 };
        return { ok: true };
      },
      alert: (msg) => { alertCalls.push(msg); },
      console: { log: () => {} },
      Promise,
      Set,
      Error,
      JSON,
    };

    vm.createContext(sandbox);
    vm.runInContext(`
      var pruneStrategiesForNames = ${pruneCode};
      var persistComboStrategies = ${persistCode};
      var handleBulkDelete = ${bulkDeleteCode};
    `, sandbox);

    sandbox.handleBulkDelete();
    await confirmState.onConfirm();

    // MAIN-01 Correctness check: c1 was deleted on server, so it MUST NOT remain in currentCombos or selectedIds
    expect(currentCombos.some((c) => c.id === "c1")).toBe(false);
    expect(selectedIds.includes("c1")).toBe(false);

    // c2 failed server delete, so it MUST remain in currentCombos and selectedIds
    expect(currentCombos.some((c) => c.id === "c2")).toBe(true);
    expect(selectedIds.includes("c2")).toBe(true);

    // Modal closed
    expect(confirmState).toBeNull();
  });

  it("handleDelete: single delete reconciles deletion when strategy PATCH fails (MAIN-01 single delete)", async () => {
    const combos = [{ id: "c1", name: "solo-combo" }];
    let currentCombos = [...combos];
    let selectedIds = ["c1"];
    let confirmState = null;
    const alertCalls = [];

    const sandbox = {
      combos: currentCombos,
      selectedIds,
      comboStrategies: { "solo-combo": { fallbackStrategy: "fusion" } },
      setConfirmState: (val) => { confirmState = typeof val === "function" ? val(confirmState) : val; },
      setCombos: (fn) => { currentCombos = typeof fn === "function" ? fn(currentCombos) : fn; },
      setSelectedIds: (fn) => { selectedIds = typeof fn === "function" ? fn(selectedIds) : fn; },
      setComboStrategies: () => {},
      fetch: async (url) => {
        if (url === "/api/combos/c1") return { ok: true, status: 200 };
        if (url === "/api/settings") return { ok: false, status: 500 };
        return { ok: true };
      },
      alert: (msg) => { alertCalls.push(msg); },
      console: { log: () => {} },
      Promise,
      Set,
      Error,
      JSON,
    };

    vm.createContext(sandbox);
    vm.runInContext(`
      var pruneStrategiesForNames = ${pruneCode};
      var persistComboStrategies = ${persistCode};
      var handleDelete = ${singleDeleteCode};
    `, sandbox);

    sandbox.handleDelete("c1");
    expect(confirmState).not.toBeNull();
    await confirmState.onConfirm();

    // MAIN-01 Single delete check: c1 was deleted on server, so it MUST NOT remain in currentCombos
    expect(currentCombos.some((c) => c.id === "c1")).toBe(false);
    expect(selectedIds.includes("c1")).toBe(false);
    expect(confirmState).toBeNull();
  });

  it("persistComboStrategies: throws error on non-ok HTTP response and does not set state", async () => {
    let setComboStrategiesCalled = false;
    const sandbox = {
      setComboStrategies: () => { setComboStrategiesCalled = true; },
      fetch: async () => ({ ok: false, status: 503 }),
      Error,
      JSON,
    };

    vm.createContext(sandbox);
    vm.runInContext(`var persistComboStrategies = ${persistCode};`, sandbox);

    await expect(sandbox.persistComboStrategies({ comboA: {} })).rejects.toThrow(
      "Failed to persist combo strategies: HTTP 503"
    );
    expect(setComboStrategiesCalled).toBe(false);
  });

  it("handleSetComboStrategy and handleBulkSetStrategy: selectively updates only targeted combos", async () => {
    let persistedPayload = null;
    const selectedCombos = [{ id: "c1", name: "combo-1" }];
    const comboStrategies = {
      "combo-1": { fallbackStrategy: "round-robin", customField: 42 },
      "combo-unrelated": { fallbackStrategy: "fusion", preserveMe: true },
    };

    const sandbox = {
      selectedCombos,
      comboStrategies,
      setBulkBusy: () => {},
      persistComboStrategies: async (updated) => { persistedPayload = updated; },
      alert: () => {},
      console: { log: () => {} },
    };

    vm.createContext(sandbox);
    vm.runInContext(`
      var handleBulkSetStrategy = ${bulkStratCode};
      var handleSetComboStrategy = ${setStratCode};
    `, sandbox);

    // 1. Bulk set strategy to 'fusion'
    await sandbox.handleBulkSetStrategy("fusion");
    expect(persistedPayload["combo-1"].fallbackStrategy).toBe("fusion");
    expect(persistedPayload["combo-unrelated"]).toEqual({ fallbackStrategy: "fusion", preserveMe: true });

    // 2. Set combo-1 back to 'fallback' (should delete key to keep settings clean)
    await sandbox.handleSetComboStrategy("combo-1", { fallbackStrategy: "fallback" });
    expect(persistedPayload["combo-1"]).toBeUndefined();
    expect(persistedPayload["combo-unrelated"]).toBeDefined();
  });

  it("handleMove: respects boundary limits and immutably swaps elements", () => {
    const originalModels = ["model-A", "model-B", "model-C"];
    const models = [...originalModels];
    const patchCalls = [];

    const sandbox = {
      models,
      patch: (p) => { patchCalls.push(p); },
    };

    vm.createContext(sandbox);
    vm.runInContext(`var handleMove = ${moveCode};`, sandbox);

    // Out of bounds: first item move up
    sandbox.handleMove(0, -1);
    expect(patchCalls.length).toBe(0);

    // Out of bounds: last item move down
    sandbox.handleMove(2, 1);
    expect(patchCalls.length).toBe(0);

    // Valid move: index 0 down
    sandbox.handleMove(0, 1);
    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0]).toEqual({ models: ["model-B", "model-A", "model-C"] });

    // Verify immutability: models was not mutated directly in place
    expect(models).toEqual(originalModels);
  });

  it("handleRemove and handleDeselect: falls back to DEFAULT_FALLBACK_MODEL on last removal", () => {
    const patchCalls = [];
    const DEFAULT_FALLBACK = "oc/mimo-v2.6-flash-free";

    const sandboxMulti = {
      models: ["model-A", "model-B"],
      DEFAULT_FALLBACK_MODEL: DEFAULT_FALLBACK,
      patch: (p) => { patchCalls.push(p); },
    };
    vm.createContext(sandboxMulti);
    vm.runInContext(`
      var handleRemove = ${removeCode};
      var handleDeselect = ${deselectCode};
    `, sandboxMulti);

    // Remove first item of two: keeps remaining item
    sandboxMulti.handleRemove(0);
    expect(patchCalls[0]).toEqual({ models: ["model-B"] });

    // Remove last remaining item: falls back to DEFAULT_FALLBACK_MODEL
    patchCalls.length = 0;
    const sandboxSingle = {
      models: ["model-last"],
      DEFAULT_FALLBACK_MODEL: DEFAULT_FALLBACK,
      patch: (p) => { patchCalls.push(p); },
    };
    vm.createContext(sandboxSingle);
    vm.runInContext(`
      var handleRemove = ${removeCode};
      var handleDeselect = ${deselectCode};
    `, sandboxSingle);

    sandboxSingle.handleRemove(0);
    expect(patchCalls[0]).toEqual({ models: [DEFAULT_FALLBACK] });

    // Deselect last remaining item: falls back to DEFAULT_FALLBACK_MODEL
    patchCalls.length = 0;
    sandboxSingle.handleDeselect("model-last");
    expect(patchCalls[0]).toEqual({ models: [DEFAULT_FALLBACK] });
  });
});
