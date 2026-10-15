import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import React from "react";
import ReactDOMServer from "react-dom/server";
import swc from "next/dist/build/swc";

/**
 * Headless test harness for NoAuthProxyCard.
 * Uses Next SWC compilation to execute the component in headless Node.
 * Emulates React state lifecycle during SSR, executes real component callbacks,
 * and tracks state transitions across re-renders without external frameworks.
 */

function loadComponent(mocks = {}) {
  const candidate1 = path.resolve(process.cwd(), "../src/shared/components/NoAuthProxyCard.js");
  const candidate2 = path.resolve(process.cwd(), "src/shared/components/NoAuthProxyCard.js");
  const targetPath = fs.existsSync(candidate1) ? candidate1 : candidate2;

  const content = fs.readFileSync(targetPath, "utf8");
  const transformed = swc.transformSync(content, {
    jsc: {
      parser: { syntax: "ecmascript", jsx: true },
      transform: { react: { runtime: "automatic" } },
    },
    module: { type: "commonjs" },
  });

  const moduleDir = path.dirname(targetPath);
  const mod = { exports: {} };

  function customRequire(id) {
    if (mocks[id]) return mocks[id];
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return mocks["react/jsx-runtime"] || require("react/jsx-runtime");
    if (id === "prop-types") return require("prop-types");
    const dummy = (props) => props?.children || null;
    dummy.default = dummy;
    dummy.__esModule = true;
    return dummy;
  }

  const fn = vm.compileFunction(
    transformed.code,
    ["exports", "require", "module", "__filename", "__dirname"],
    { filename: targetPath }
  );
  fn(mod.exports, customRequire, mod, targetPath, moduleDir);
  return mod.exports.default || mod.exports;
}

function createComponentHarness(Component) {
  const stateList = [];
  const effectList = [];
  const refList = [];
  const pendingEffects = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let refIndex = 0;

  const origUseState = React.useState;
  const origUseEffect = React.useEffect;
  const origUseRef = React.useRef;
  const origUseCallback = React.useCallback;

  function render(props = {}) {
    stateIndex = 0;
    effectIndex = 0;
    refIndex = 0;

    React.useState = (init) => {
      const idx = stateIndex++;
      if (stateList.length <= idx) {
        stateList[idx] = typeof init === "function" ? init() : init;
      }
      const setter = (val) => {
        stateList[idx] = typeof val === "function" ? val(stateList[idx]) : val;
      };
      return [stateList[idx], setter];
    };

    React.useRef = (init) => {
      const idx = refIndex++;
      if (refList.length <= idx) {
        refList[idx] = { current: init };
      }
      return refList[idx];
    };

    React.useCallback = (fn) => fn;

    React.useEffect = (effect, deps) => {
      const idx = effectIndex++;
      const prev = effectList[idx];
      let changed = !prev;
      if (prev && deps) {
        changed = deps.some((d, i) => !Object.is(d, prev.deps[i]));
      }
      if (changed) {
        pendingEffects.push({ idx, effect, deps });
      }
    };

    let html;
    try {
      html = ReactDOMServer.renderToString(React.createElement(Component, props));
    } finally {
      React.useState = origUseState;
      React.useEffect = origUseEffect;
      React.useRef = origUseRef;
      React.useCallback = origUseCallback;
    }
    return html;
  }

  async function flushEffects() {
    const toRun = pendingEffects.splice(0);
    for (const item of toRun) {
      if (effectList[item.idx]?.cleanup) {
        try { effectList[item.idx].cleanup(); } catch {}
      }
      const cleanup = item.effect();
      effectList[item.idx] = { deps: item.deps, cleanup };
    }
  }

  return {
    render,
    flushEffects,
    getState: (i) => stateList[i],
    getStates: () => stateList,
    getRef: (i) => refList[i]?.current,
  };
}

describe("NoAuthProxyCard - saveBUG Prevention & Network Resilience", () => {
  let capturedSelect = null;
  let capturedStrategySelect = null;
  let originalFetch;
  let fetchHistory = [];

  const realJsxRuntime = require("react/jsx-runtime");
  const interceptedJsx = (type, props, key) => {
    if (type === "select") {
      capturedStrategySelect = props;
    }
    return realJsxRuntime.jsx(type, props, key);
  };
  const interceptedJsxs = (type, props, key) => {
    if (type === "select") {
      capturedStrategySelect = props;
    }
    return realJsxRuntime.jsxs(type, props, key);
  };

  const createMocks = () => ({
    "react/jsx-runtime": {
      ...realJsxRuntime,
      jsx: interceptedJsx,
      jsxs: interceptedJsxs,
    },
    "./Card": ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
    "./Select": (props) => {
      capturedSelect = props;
      return React.createElement("div", {
        "data-select": props.label,
        "data-value": props.value,
        "data-disabled": props.disabled,
      });
    },
    "./Badge": ({ children, variant, size }) =>
      React.createElement("span", { "data-badge": variant, "data-size": size }, children),
  });

  beforeEach(() => {
    capturedSelect = null;
    capturedStrategySelect = null;
    fetchHistory = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const setupCardWithInitialData = async (providerId = "opencode", initialStrategies = {}) => {
    globalThis.fetch = vi.fn(async (url, opts) => {
      fetchHistory.push({ url, opts });
      if (url.includes("/api/proxy-pools")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            proxyPools: [
              { id: "pool_alpha", name: "Pool Alpha" },
              { id: "pool_beta", name: "Pool Beta" },
            ],
          }),
        };
      }
      if (url.includes("/api/settings")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            providerStrategies: initialStrategies,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
    });

    const NoAuthProxyCard = loadComponent(createMocks());
    const harness = createComponentHarness(NoAuthProxyCard);
    harness.render({ providerId });
    await harness.flushEffects();
    // allow promise microtasks to resolve
    await new Promise((r) => setTimeout(r, 10));
    const html = harness.render({ providerId });
    return { harness, html };
  };

  it("names the break: aborts save when GET /api/settings returns HTTP 500, displays role=alert, does NOT PATCH empty strategies, and rolls back selection", async () => {
    const initialStrategies = {
      opencode: { proxyPoolId: "pool_alpha" },
      anthropic: { proxyPoolId: "pool_anthropic" },
    };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    // Initial state verified
    expect(capturedSelect.value).toBe("pool_alpha");

    // Now user attempts to change pool to pool_beta, but GET /api/settings fails with HTTP 500
    globalThis.fetch = vi.fn(async (url, opts) => {
      fetchHistory.push({ url, opts });
      if (url.includes("/api/settings")) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "Internal Server Error" }),
        };
      }
      return { ok: false, status: 500 };
    });

    // Trigger pool change
    capturedSelect.onChange({ target: { value: "pool_beta" } });
    await new Promise((r) => setTimeout(r, 20));

    const htmlAfterFail = harness.render({ providerId: "opencode" });

    // 1. Must NOT send PATCH request erasing strategies!
    const patchCalls = fetchHistory.filter((c) => c.opts?.method === "PATCH");
    expect(patchCalls.length).toBe(0);

    // 2. Must show role="alert" with error message
    expect(htmlAfterFail).toContain('role="alert"');

    // 3. Must NOT show "Saved" badge
    expect(htmlAfterFail).not.toContain('data-badge="success"');
    expect(htmlAfterFail).not.toContain(">Saved<");

    // 4. Must rollback pool selection to last confirmed value (pool_alpha)
    expect(capturedSelect.value).toBe("pool_alpha");

    // 5. Must clear busy / saving state
    expect(capturedSelect.disabled).toBe(false);
  });

  it("names the break: aborts save when GET /api/settings returns HTTP 400, displays role=alert, does NOT PATCH, and rolls back", async () => {
    const initialStrategies = {
      opencode: { proxyPoolId: "pool_alpha" },
      google: { proxyPoolId: "pool_google" },
    };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    globalThis.fetch = vi.fn(async (url, opts) => {
      fetchHistory.push({ url, opts });
      if (url.includes("/api/settings")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "Bad Request" }),
        };
      }
      return { ok: false, status: 400 };
    });

    capturedSelect.onChange({ target: { value: "pool_beta" } });
    await new Promise((r) => setTimeout(r, 20));

    const htmlAfterFail = harness.render({ providerId: "opencode" });

    const patchCalls = fetchHistory.filter((c) => c.opts?.method === "PATCH");
    expect(patchCalls.length).toBe(0);
    expect(htmlAfterFail).toContain('role="alert"');
    expect(capturedSelect.value).toBe("pool_alpha");
  });

  it("names the break: aborts save when GET /api/settings returns invalid/non-JSON payload, displays role=alert, and does NOT PATCH", async () => {
    const initialStrategies = {
      opencode: { proxyPoolId: "pool_alpha" },
    };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    globalThis.fetch = vi.fn(async (url, opts) => {
      fetchHistory.push({ url, opts });
      if (url.includes("/api/settings")) {
        return {
          ok: true,
          status: 200,
          json: async () => null, // non-object / null payload
        };
      }
      return { ok: false };
    });

    capturedSelect.onChange({ target: { value: "pool_beta" } });
    await new Promise((r) => setTimeout(r, 20));

    const htmlAfterFail = harness.render({ providerId: "opencode" });

    const patchCalls = fetchHistory.filter((c) => c.opts?.method === "PATCH");
    expect(patchCalls.length).toBe(0);
    expect(htmlAfterFail).toContain('role="alert"');
    expect(capturedSelect.value).toBe("pool_alpha");
  });

  it("names the break: aborts save when GET /api/settings network error occurs (fetch rejection), displays role=alert, and does NOT PATCH", async () => {
    const initialStrategies = { opencode: { proxyPoolId: "pool_alpha" } };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    globalThis.fetch = vi.fn(async (url, opts) => {
      fetchHistory.push({ url, opts });
      throw new Error("Network connection failed");
    });

    capturedSelect.onChange({ target: { value: "pool_beta" } });
    await new Promise((r) => setTimeout(r, 20));

    const htmlAfterFail = harness.render({ providerId: "opencode" });

    const patchCalls = fetchHistory.filter((c) => c.opts?.method === "PATCH");
    expect(patchCalls.length).toBe(0);
    expect(htmlAfterFail).toContain('role="alert"');
    expect(capturedSelect.value).toBe("pool_alpha");
  });

  it("names the break: handles PATCH /api/settings HTTP 500 error: displays role=alert, no Saved badge, and rolls back selection", async () => {
    const initialStrategies = {
      opencode: { proxyPoolId: "pool_alpha" },
    };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    globalThis.fetch = vi.fn(async (url, opts) => {
      fetchHistory.push({ url, opts });
      if (opts?.method === "PATCH") {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "Database lock timeout" }),
        };
      }
      if (url.includes("/api/settings")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ providerStrategies: initialStrategies }),
        };
      }
      return { ok: false };
    });

    capturedSelect.onChange({ target: { value: "pool_beta" } });
    await new Promise((r) => setTimeout(r, 20));

    const htmlAfterFail = harness.render({ providerId: "opencode" });

    expect(htmlAfterFail).toContain('role="alert"');
    expect(htmlAfterFail).not.toContain('data-badge="success"');
    expect(capturedSelect.value).toBe("pool_alpha");
    expect(capturedSelect.disabled).toBe(false);
  });

  it("names the break: handles PATCH /api/settings HTTP 400 error: displays role=alert, no Saved badge, and rolls back strategy", async () => {
    const initialStrategies = {
      opencode: { proxyPoolId: "pool_alpha", rotateStrategy: "none" },
    };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    globalThis.fetch = vi.fn(async (url, opts) => {
      fetchHistory.push({ url, opts });
      if (opts?.method === "PATCH") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "Invalid strategy parameter" }),
        };
      }
      if (url.includes("/api/settings")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ providerStrategies: initialStrategies }),
        };
      }
      return { ok: false };
    });

    capturedStrategySelect.onChange({ target: { value: "round-robin" } });
    await new Promise((r) => setTimeout(r, 20));

    const htmlAfterFail = harness.render({ providerId: "opencode" });

    expect(htmlAfterFail).toContain('role="alert"');
    expect(htmlAfterFail).not.toContain('data-badge="success"');
    expect(capturedStrategySelect.value).toBe("none");
  });

  it("names the break: preserves other provider strategies and unknown fields on providerStrategy during successful PATCH", async () => {
    const initialStrategies = {
      opencode: { proxyPoolId: "pool_alpha", customMetadata: "keep_this_prop" },
      anthropic: { proxyPoolId: "pool_claude", rotateStrategy: "round-robin" },
      codex: { proxyPoolId: "pool_codex" },
    };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    let savedBody = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      fetchHistory.push({ url, opts });
      if (opts?.method === "PATCH") {
        savedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        };
      }
      if (url.includes("/api/settings")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ providerStrategies: initialStrategies }),
        };
      }
      return { ok: false };
    });

    // Change pool to pool_beta
    capturedSelect.onChange({ target: { value: "pool_beta" } });
    await new Promise((r) => setTimeout(r, 20));

    expect(savedBody).not.toBeNull();
    const updated = savedBody.providerStrategies;

    // Must preserve anthropic and codex untouched
    expect(updated.anthropic).toEqual({ proxyPoolId: "pool_claude", rotateStrategy: "round-robin" });
    expect(updated.codex).toEqual({ proxyPoolId: "pool_codex" });

    // Must update opencode proxyPoolId while preserving customMetadata
    expect(updated.opencode.proxyPoolId).toBe("pool_beta");
    expect(updated.opencode.customMetadata).toBe("keep_this_prop");

    // Must flash Saved badge after valid HTTP 200
    const htmlSuccess = harness.render({ providerId: "opencode" });
    expect(htmlSuccess).toContain('data-badge="success"');
    expect(htmlSuccess).toContain(">Saved<");
    expect(htmlSuccess).not.toContain('role="alert"');
  });

  it("names the break: cleans up empty override when setting pool to direct and strategy to none without deleting other providers", async () => {
    const initialStrategies = {
      opencode: { proxyPoolId: "pool_alpha" },
      openai: { proxyPoolId: "pool_oai" },
    };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    let savedBody = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      fetchHistory.push({ url, opts });
      if (opts?.method === "PATCH") {
        savedBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (url.includes("/api/settings")) {
        return { ok: true, status: 200, json: async () => ({ providerStrategies: initialStrategies }) };
      }
      return { ok: false };
    });

    // Set to None (direct) "__none__"
    capturedSelect.onChange({ target: { value: "__none__" } });
    await new Promise((r) => setTimeout(r, 20));

    expect(savedBody).not.toBeNull();
    const updated = savedBody.providerStrategies;
    expect(updated.opencode).toBeUndefined(); // removed empty override
    expect(updated.openai).toEqual({ proxyPoolId: "pool_oai" }); // preserved other provider
  });

  it("names the break: clears stale Saved badge when a new save attempt begins", async () => {
    const initialStrategies = { opencode: { proxyPoolId: "pool_alpha" } };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    // First successful save
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (opts?.method === "PATCH") return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ providerStrategies: initialStrategies }) };
    });
    capturedSelect.onChange({ target: { value: "pool_beta" } });
    await new Promise((r) => setTimeout(r, 20));

    let html = harness.render({ providerId: "opencode" });
    expect(html).toContain(">Saved<");

    // Second save delayed response: badge must clear immediately on new attempt
    let resolvePatch;
    const patchPromise = new Promise((resolve) => { resolvePatch = resolve; });
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (opts?.method === "PATCH") return patchPromise;
      return { ok: true, status: 200, json: async () => ({ providerStrategies: initialStrategies }) };
    });

    capturedSelect.onChange({ target: { value: "__none__" } });
    html = harness.render({ providerId: "opencode" });

    // While in-flight, Saved badge must be cleared
    expect(html).not.toContain(">Saved<");

    resolvePatch({ ok: true, status: 200, json: async () => ({}) });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("names the break: guards against concurrent clicks and duplicate triggers while saving is in-flight", async () => {
    const initialStrategies = { opencode: { proxyPoolId: "pool_alpha" } };
    const { harness } = await setupCardWithInitialData("opencode", initialStrategies);

    let resolveGet;
    const getPromise = new Promise((resolve) => { resolveGet = resolve; });
    let patchCount = 0;

    globalThis.fetch = vi.fn(async (url, opts) => {
      if (opts?.method === "PATCH") {
        patchCount++;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.includes("/api/settings")) {
        return getPromise;
      }
      return { ok: true, status: 200, json: async () => ({ proxyPools: [] }) };
    });

    // Trigger first save (remains pending on GET)
    capturedSelect.onChange({ target: { value: "pool_beta" } });

    // Render while pending
    const busyHtml = harness.render({ providerId: "opencode" });
    expect(capturedSelect.disabled).toBe(true);
    expect(capturedStrategySelect.disabled).toBe(true);

    // Attempt concurrent duplicate click while busy
    capturedSelect.onChange({ target: { value: "pool_alpha" } });

    // Release GET
    resolveGet({
      ok: true,
      status: 200,
      json: async () => ({ providerStrategies: initialStrategies }),
    });
    await new Promise((r) => setTimeout(r, 30));

    // Exactly one PATCH must have executed, not two
    expect(patchCount).toBe(1);
  });
});

describe("NoAuthProxyCard - OpenCode Free Truthful Policy & Guidance", () => {
  let capturedSelect = null;
  let originalFetch;

  const createMocks = () => ({
    "./Card": ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
    "./Select": (props) => {
      capturedSelect = props;
      return React.createElement("div", {
        "data-select": props.label,
        "data-value": props.value,
        "data-disabled": props.disabled,
      });
    },
    "./Badge": ({ children, variant, size }) =>
      React.createElement("span", { "data-badge": variant, "data-size": size }, children),
  });

  beforeEach(() => {
    capturedSelect = null;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes("/api/proxy-pools")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            proxyPools: [
              { id: "pool_alpha", name: "Pool Alpha" },
              { id: "pool_beta", name: "Pool Beta" },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ providerStrategies: {} }) };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const renderCard = async (providerId) => {
    const NoAuthProxyCard = loadComponent(createMocks());
    const harness = createComponentHarness(NoAuthProxyCard);
    harness.render({ providerId });
    await harness.flushEffects();
    await new Promise((r) => setTimeout(r, 10));
    const html = harness.render({ providerId });
    return { harness, html };
  };

  it("names the break: generic header for opencode does NOT make 'ready to use' or 'bypass IP-based limits' claims", async () => {
    const { html } = await renderCard("opencode");
    expect(html).not.toContain("ready to use");
    expect(html).not.toContain("bypass IP-based limits");
  });

  it("names the break: generic header for other providers maintains neutral scope without country bypass advice", async () => {
    const { html } = await renderCard("pollinations");
    expect(html).not.toContain("bypass IP-based limits");
    expect(html).not.toContain("country");
  });

  it("names the break: renders truthful section for providerId opencode displaying all 3 verified Go workspace settings names", async () => {
    const { html } = await renderCard("opencode");

    // Setting 1: China-hosted models (useChina / workspace.region)
    expect(html).toContain("useChina");

    // Setting 2: Training consent (allowTraining / workspace.allow_training)
    expect(html).toContain("allowTraining");

    // Setting 3: Zen balance overflow (useBalance / billing.lite.useBalance)
    expect(html).toContain("useBalance");
  });

  it("names the break: explicitly states in text that these 3 settings are unsupported on anonymous Free tier", async () => {
    const { html } = await renderCard("opencode");
    expect(html).toMatch(/OpenCode Free operates anonymously/i);
    expect(html).toMatch(/cannot grant server-side consent/i);
    expect(html).toMatch(/unsupported on (?:the )?anonymous free tier/i);
  });

  it("names the break: renders zero fake enable checkboxes or toggles claiming to grant server consent on Free tier", async () => {
    const { html } = await renderCard("opencode");
    // Must NOT contain input type="checkbox" or toggles claiming to enable China/training/balance
    expect(html).not.toMatch(/<input[^>]+type="checkbox"/i);
    expect(html).not.toContain("data-toggle");
  });

  it("names the break: renders accessible link to OpenCode Go Console with secure rel=noopener noreferrer", async () => {
    const { html } = await renderCard("opencode");
    expect(html).toContain('href="https://opencode.ai/workspace"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/Manage in OpenCode Go Console/i);
  });

  it("names the break: explains upstream error difference: countryNotAllowed/RegionError vs Go China/training opt-in vs FreeTierError", async () => {
    const { html } = await renderCard("opencode");
    expect(html).toContain("RegionError");
    expect(html).toContain("countryNotAllowed");
    expect(html).toContain("FreeTierError");
  });

  it("names the break: does NOT render OpenCode Go workspace settings section for non-opencode provider", async () => {
    const { html } = await renderCard("pollinations");
    expect(html).not.toContain("useChina");
    expect(html).not.toContain("allowTraining");
    expect(html).not.toContain("useBalance");
    expect(html).not.toContain("OpenCode Go Console");
  });

  it("names the break: keeps proxy pool and rotation controls fully functional and accessible", async () => {
    const { html } = await renderCard("opencode");
    expect(html).toContain("Proxy Pool");
    expect(html).toContain("Rotation Strategy");
    expect(capturedSelect).not.toBeNull();
  });
});
