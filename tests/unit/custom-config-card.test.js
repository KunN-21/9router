import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import React from "react";
import ReactDOMServer from "react-dom/server";
import swc from "next/dist/build/swc";

const require = createRequire(import.meta.url);

const makeDefault = (fn) => {
  fn.default = fn;
  fn.__esModule = true;
  return fn;
};

function resolveProjectPath(relativePath) {
  if (path.isAbsolute(relativePath)) return relativePath;
  const fromParent = path.resolve(process.cwd(), "..", relativePath);
  if (fs.existsSync(fromParent)) return fromParent;
  const fromCwd = path.resolve(process.cwd(), relativePath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return process.cwd().endsWith("tests") ? fromParent : fromCwd;
}

/**
 * Loads a React component using Next SWC compiler for isolated Node testing.
 */
function loadComponentWithSwc(relativePath, mocks = {}) {
  const resolvedPath = resolveProjectPath(relativePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Component file not found: ${resolvedPath}`);
  }

  const content = fs.readFileSync(resolvedPath, "utf8");
  const transformed = swc.transformSync(content, {
    jsc: {
      parser: { syntax: "ecmascript", jsx: true },
      transform: { react: { runtime: "automatic" } },
    },
    module: { type: "commonjs" },
  });

  const moduleDir = path.dirname(resolvedPath);
  const mod = { exports: {} };

  function customRequire(id) {
    if (mocks[id]) return mocks[id];
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return require("react/jsx-runtime");
    if (id === "prop-types") return require("prop-types");
    const dummy = (props) => props?.children || null;
    dummy.default = dummy;
    dummy.__esModule = true;
    return dummy;
  }

  const fn = vm.compileFunction(
    transformed.code,
    ["exports", "require", "module", "__filename", "__dirname"],
    { filename: resolvedPath }
  );
  fn(mod.exports, customRequire, mod, resolvedPath, moduleDir);
  return mod.exports.default || mod.exports;
}

/**
 * Recursively search a React element tree for elements matching predicate.
 */
function findInTree(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  if (node.props && node.props.children) {
    if (Array.isArray(node.props.children)) {
      node.props.children.forEach((child) => findInTree(child, predicate, out));
    } else {
      findInTree(node.props.children, predicate, out);
    }
  }
  return out;
}

/**
 * Stateful hook harness that emulates React useState/useEffect lifecycle
 * for CustomConfigCard without external test framework dependencies.
 */
function createCardHarness(Component, initialProps = { providerId: "codex" }, initialStateOverrides = {}, options = { executeEffects: true }) {
  const hooks = [];
  const effectHooks = [];
  const refHooks = [];
  let isInitial = true;
  let currentProps = { ...initialProps };

  function render(propsUpdate = null) {
    if (propsUpdate) {
      currentProps = { ...currentProps, ...propsUpdate };
    }
    let hookIndex = 0;
    let effectIndex = 0;
    let refIndex = 0;
    const prevUseState = React.useState;
    const prevUseEffect = React.useEffect;
    const prevUseCallback = React.useCallback;
    const prevUseRef = React.useRef;
    const pendingEffects = [];
    let stateUpdatedInEffect = false;

    React.useState = (initial) => {
      const idx = hookIndex++;
      if (isInitial || !hooks[idx]) {
        let initVal = typeof initial === "function" ? initial() : initial;
        if (idx in initialStateOverrides) {
          initVal = initialStateOverrides[idx];
        }
        const setter = (update) => {
          const nextVal = typeof update === "function" ? update(hooks[idx].value) : update;
          hooks[idx].value = nextVal;
        };
        hooks[idx] = { value: initVal, setter };
      }
      return [
        hooks[idx].value,
        (update) => {
          hooks[idx].setter(update);
          stateUpdatedInEffect = true;
        },
      ];
    };

    React.useCallback = (fn, _deps) => fn;
    React.useRef = (init) => {
      const idx = refIndex++;
      if (!refHooks[idx]) {
        refHooks[idx] = { current: typeof init === "function" ? init() : init };
      }
      return refHooks[idx];
    };

    if (options.executeEffects) {
      React.useEffect = (effect, deps) => {
        const idx = effectIndex++;
        const prev = effectHooks[idx];
        let hasChanged = true;
        if (prev && deps && prev.deps) {
          hasChanged = deps.some((d, i) => !Object.is(d, prev.deps[i]));
        }
        if (hasChanged) {
          pendingEffects.push({ idx, effect, deps });
        }
      };
    } else {
      React.useEffect = () => {};
    }

    let tree;
    try {
      tree = Component(currentProps);
      isInitial = false;
    } finally {
      React.useState = prevUseState;
      React.useEffect = prevUseEffect;
      React.useCallback = prevUseCallback;
      React.useRef = prevUseRef;
    }

    if (options.executeEffects) {
      for (const item of pendingEffects) {
        if (effectHooks[item.idx]?.cleanup) {
          try { effectHooks[item.idx].cleanup(); } catch {}
        }
        const cleanup = item.effect();
        effectHooks[item.idx] = {
          deps: item.deps,
          cleanup: typeof cleanup === "function" ? cleanup : null,
        };
      }

      if (stateUpdatedInEffect) {
        hookIndex = 0;
        React.useState = (initial) => {
          const idx = hookIndex++;
          return [hooks[idx].value, hooks[idx].setter];
        };
        refIndex = 0;
        React.useCallback = (fn) => fn;
        React.useRef = (init) => {
          const idx = refIndex++;
          if (!refHooks[idx]) {
            refHooks[idx] = { current: typeof init === "function" ? init() : init };
          }
          return refHooks[idx];
        };
        React.useEffect = () => {};
        try {
          tree = Component(currentProps);
        } finally {
          React.useState = prevUseState;
          React.useEffect = prevUseEffect;
          React.useCallback = prevUseCallback;
          React.useRef = prevUseRef;
        }
      }
    }

    return tree;
  }

  function unmount() {
    for (const hook of effectHooks) {
      if (hook?.cleanup) {
        try { hook.cleanup(); } catch {}
      }
    }
  }

  async function renderAsync(propsUpdate = null) {
    render(propsUpdate);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return render();
  }

  return {
    render,
    renderAsync,
    unmount,
    getHookState: (idx) => hooks[idx]?.value,
    setHookState: (idx, val) => hooks[idx]?.setter(val),
    getHtml: (tree) => ReactDOMServer.renderToString(tree),
  };
}

describe("CustomConfigCard Module Presence & ProviderDetailPage Mount (TDD RED Gate)", () => {
  it("names the break: CustomConfigCard module exists and exports a valid React component", () => {
    const cardPath = resolveProjectPath(
      "src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js"
    );
    expect(fs.existsSync(cardPath)).toBe(true);

    const CustomConfigCard = loadComponentWithSwc(cardPath, {
      "@/shared/components": {
        Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
        Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
      },
      "@/store/notificationStore": {
        useNotificationStore: () => ({ success: vi.fn(), error: vi.fn() }),
      },
    });
    expect(typeof CustomConfigCard).toBe("function");
  });

  it("names the break: ProviderDetailPage mounts CustomConfigCard directly above Models Card with providerId", () => {
    let capturedCardProps = null;
    const MockCustomConfigCard = (props) => {
      capturedCardProps = props;
      return React.createElement("div", { "data-custom-config-card": true, "data-provider-id": props.providerId });
    };

    const makeComp = (name) => {
      const c = ({ children }) => (children ? React.createElement(React.Fragment, null, children) : null);
      c.displayName = name;
      return c;
    };

    const compNames = [
      "Button", "Badge", "Input", "Modal", "CardSkeleton", "OAuthModal",
      "KiroOAuthWrapper", "CursorAuthModal", "ZedAuthModal", "XiaomiMimoAuthModal",
      "IFlowCookieModal", "GitLabAuthModal", "Toggle", "Select",
      "NoAuthProxyCard", "ConfirmModal"
    ];

    const sharedComponentsMock = { __esModule: true };
    for (const name of compNames) {
      sharedComponentsMock[name] = makeComp(name);
    }
    sharedComponentsMock.Card = function MockCard({ children, ...props }) { return React.createElement("div", { "data-card": true, ...props }, children); };
    sharedComponentsMock.Button = function MockButton({ children, ...props }) { return React.createElement("button", props, children); };
    sharedComponentsMock.Badge = function MockBadge({ children, ...props }) { return React.createElement("span", props, children); };
    sharedComponentsMock.EditConnectionModal = function MockEditConnectionModal() { return null; };

    const pageMocks = {
      "next/navigation": {
        useParams: () => ({ id: "codex" }),
        useRouter: () => ({ push: () => {} }),
      },
      "next/link": makeDefault(({ children, ...props }) => React.createElement("a", props, children)),
      "next/image": makeDefault((props) => React.createElement("img", props)),
      "@/shared/components": sharedComponentsMock,
      "@/shared/hooks/useModelCaps": { useModelCaps: () => ({}) },
      "@/shared/hooks/useCopyToClipboard": { useCopyToClipboard: () => ({ copy: () => {} }) },
      "@/shared/utils/providerIcon": {
        getProviderIconSrc: () => "/providers/codex.png",
        markProviderIconMissing: () => {},
      },
      "@/shared/constants/models": {
        getModelsByProviderId: () => [],
        getModelKind: () => "chat",
      },
      "@/shared/constants/providers": {
        OAUTH_PROVIDERS: { codex: { id: "codex", name: "OpenAI Codex", authModes: ["oauth"] } },
        APIKEY_PROVIDERS: {},
        FREE_PROVIDERS: {},
        FREE_TIER_PROVIDERS: {},
        WEB_COOKIE_PROVIDERS: {},
        getProviderAlias: (p) => p,
        isOpenAICompatibleProvider: () => false,
        isAnthropicCompatibleProvider: () => false,
        AI_PROVIDERS: { codex: { id: "codex", name: "OpenAI Codex" } },
      },
      "@/shared/utils/providerCustomModels": { getProviderCustomModelRows: () => [] },
      "@/shared/utils/providerModelsFetcher": { fetchSuggestedModels: () => Promise.resolve([]) },
      "@/i18n/runtime": { translate: (k, def) => def || k },
      "open-sse/providers/thinkingLevels.js": { getThinkingLevels: () => [] },
      "@/store/notificationStore": {
        useNotificationStore: Object.assign(() => ({ error: vi.fn(), success: vi.fn() }), {
          getState: () => ({ error: vi.fn(), success: vi.fn() }),
        }),
      },
      "./CustomConfigCard": makeDefault(MockCustomConfigCard),
      "./ConnectionRow": makeDefault(() => null),
      "./ModelRow": makeDefault(() => null),
      "./PassthroughModelsSection": makeDefault(() => null),
      "./CompatibleModelsSection": makeDefault(() => null),
      "./AddApiKeyModal": makeDefault(() => null),
      "./EditCompatibleNodeModal": makeDefault(() => null),
      "./AddCustomModelModal": makeDefault(() => null),
      "./BulkImportCodexModal": makeDefault(() => null),
      "./BulkImportGrokCliModal": makeDefault(() => null),
      "./AutoPingScheduleModal": makeDefault(() => null),
      "../components/WebLoginButton.js": Object.assign(makeDefault(() => null), {
        WEB_LOGIN_PROVIDERS: new Set(),
      }),
      "@/shared/services/quotaPingSchedule": { getScheduleSlotLabels: () => [] },
    };

    const targetPath = resolveProjectPath("src/app/(dashboard)/dashboard/providers/[id]/page.js");
    const Page = loadComponentWithSwc(targetPath, pageMocks);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    try {
      const pageHarness = createCardHarness(Page, {}, { 2: false }, { executeEffects: false });
      const pageTree = pageHarness.render();
      const html = ReactDOMServer.renderToString(pageTree);

      expect(capturedCardProps).not.toBeNull();
      expect(capturedCardProps.providerId).toBe("codex");
      expect(html).toContain("data-custom-config-card");
      expect(html).toContain('data-provider-id="codex"');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("CustomConfigCard - Layout, Accessibility & Constraints", () => {
  let CustomConfigCard;
  const originalFetch = global.fetch;

  beforeEach(() => {
    const cardPath = resolveProjectPath(
      "src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js"
    );
    CustomConfigCard = loadComponentWithSwc(cardPath, {
      "@/shared/components": {
        Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
        Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
      },
      "@/store/notificationStore": {
        useNotificationStore: () => ({ success: vi.fn(), error: vi.fn() }),
      },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("names the break: TC-UI-01 - renders card for empty builtin provider (e.g. opencode-go) and never returns null", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ headers: {}, builtinHeaders: {} }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "opencode-go" });
    const tree = await harness.renderAsync();
    const html = harness.getHtml(tree);

    expect(tree).not.toBeNull();
    expect(html).toContain("Custom Headers");

    const expandBtn = findInTree(tree, (n) => n.type === "button")[0];
    expandBtn.props.onClick();
    const expandedTree = harness.render();
    const expandedHtml = harness.getHtml(expandedTree);

    expect(expandedHtml).toContain("Add header");
    expect(expandedHtml).toContain("Reset");
    expect(expandedHtml).toContain("Save");
  });

  it("names the break: TC-UI-12 - all button controls have native type=button", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        headers: { "X-Custom": "val" },
        builtinHeaders: { "User-Agent": "9router" },
      }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    const expandBtn = findInTree(tree, (n) => n.type === "button")[0];
    expandBtn.props.onClick();
    tree = harness.render();

    const buttons = findInTree(tree, (n) => n.type === "button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      expect(btn.props.type).toBe("button");
    }
  });

  it("names the break: TC-UI-10 - native button toggles password masking for sensitive headers", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        headers: { Authorization: "Bearer sk-12345" },
        builtinHeaders: {},
      }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    const expandBtn = findInTree(tree, (n) => n.type === "button")[0];
    expandBtn.props.onClick();
    tree = harness.render();

    const inputs = findInTree(tree, (n) => n.type === "input");
    const valInput = inputs.find((i) => i.props.value === "Bearer sk-12345");
    expect(valInput).toBeDefined();
    expect(valInput.props.type).toBe("password");

    const toggleBtn = findInTree(tree, (n) => n.type === "button" && (n.props.title?.includes("value") || n.props["aria-label"]?.includes("value")))[0];
    expect(toggleBtn).toBeDefined();
    expect(toggleBtn.props.type).toBe("button");

    toggleBtn.props.onClick();
    tree = harness.render();

    const updatedInputs = findInTree(tree, (n) => n.type === "input");
    const updatedValInput = updatedInputs.find((i) => i.props.value === "Bearer sk-12345");
    expect(updatedValInput.props.type).toBe("text");
  });

  it("names the break: TC-UI-11 - sensitive header advisory warning is non-blocking", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        headers: { Authorization: "Bearer test" },
        builtinHeaders: {},
      }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const html = harness.getHtml(tree);
    expect(html).toMatch(/advisory|warning|sensitive|unexpected|may affect/i);

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    expect(saveBtn).toBeDefined();
    expect(saveBtn.props.disabled).toBeFalsy();
  });

  it("names the break: TC-UI-14 - nameless non-empty value cannot silently drop (triggers error alert)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ headers: {}, builtinHeaders: {} }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const inputs = findInTree(tree, (n) => n.type === "input");
    const nameInput = inputs.find((i) => i.props.placeholder === "Header-Name");
    const valInput = inputs.find((i) => i.props.placeholder === "Value");

    nameInput.props.onChange({ target: { value: "   " } });
    valInput.props.onChange({ target: { value: "orphan-value" } });

    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    await saveBtn.props.onClick();

    tree = harness.render();
    const html = harness.getHtml(tree);

    expect(html).toContain('role="alert"');
    expect(html).toMatch(/name cannot be empty|Header name is required|invalid/i);
  });

  it("names the break: TC-UI-13 - supports >20 headers and 9000-char values without artificial frontend caps", async () => {
    const longValue = "A".repeat(9000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        headers: { "X-Long-Val": longValue },
        builtinHeaders: {},
      }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const addBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Add"))[0];
    for (let i = 0; i < 24; i++) {
      addBtn.props.onClick();
    }
    tree = harness.render();

    const nameInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
    expect(nameInputs.length).toBe(25);

    const valInput = findInTree(tree, (n) => n.type === "input" && n.props.value === longValue)[0];
    expect(valInput).toBeDefined();
    expect(valInput.props.value.length).toBe(9000);
  });
});

describe("CustomConfigCard - Wire Contracts & State Synchronization", () => {
  let CustomConfigCard;
  const originalFetch = global.fetch;

  beforeEach(() => {
    const cardPath = resolveProjectPath(
      "src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js"
    );
    CustomConfigCard = loadComponentWithSwc(cardPath, {
      "@/shared/components": {
        Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
        Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
      },
      "@/store/notificationStore": {
        useNotificationStore: () => ({ success: vi.fn(), error: vi.fn() }),
      },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("names the break: TC-UI-02 - mounts and fetches /api/providers/[id]/overrides with cache: no-store and URL-encoded id", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        headers: { "X-Test": "1" },
        builtinHeaders: { "User-Agent": "test" },
      }),
    });
    global.fetch = fetchSpy;

    const harness = createCardHarness(CustomConfigCard, { providerId: "anthropic/compatible-test" });
    await harness.renderAsync();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/providers/anthropic%2Fcompatible-test/overrides",
      { cache: "no-store" }
    );
  });

  it("names the break: TC-UI-03 - add header button appends new empty row", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ headers: {}, builtinHeaders: {} }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const initialInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
    expect(initialInputs.length).toBe(1);

    const addBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Add"))[0];
    addBtn.props.onClick();
    tree = harness.render();

    const updatedInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
    expect(updatedInputs.length).toBe(2);
  });

  it("names the break: TC-UI-04 - editing name and value updates row state", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ headers: {}, builtinHeaders: {} }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const nameInput = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name")[0];
    const valInput = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value")[0];

    nameInput.props.onChange({ target: { value: "X-Trace-Id" } });
    valInput.props.onChange({ target: { value: "abc-123" } });

    tree = harness.render();

    const updatedName = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name")[0];
    const updatedVal = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value")[0];

    expect(updatedName.props.value).toBe("X-Trace-Id");
    expect(updatedVal.props.value).toBe("abc-123");
  });

  it("names the break: TC-UI-05 - delete row removes override to allow restoring default", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        headers: { "X-Custom": "custom-val" },
        builtinHeaders: { "User-Agent": "9router" },
      }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const deleteBtns = findInTree(tree, (n) => n.type === "button" && (n.props.title === "Remove header" || n.props["aria-label"] === "Remove header"));
    expect(deleteBtns.length).toBe(2);

    deleteBtns[0].props.onClick();
    tree = harness.render();

    const remainingRows = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
    expect(remainingRows.length).toBe(1);
  });

  it("names the break: TC-UI-06 - blank value is explicitly retained on wire", async () => {
    const fetchSpy = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            headers: JSON.parse(opts.body).headers,
            builtinHeaders: {},
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ headers: {}, builtinHeaders: {} }),
      });
    });
    global.fetch = fetchSpy;

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const nameInput = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name")[0];
    const valInput = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value")[0];

    nameInput.props.onChange({ target: { value: "X-Empty-Header" } });
    valInput.props.onChange({ target: { value: "" } });

    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    await saveBtn.props.onClick();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/providers/codex/overrides",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headers: {
            "X-Empty-Header": "",
          },
        }),
      })
    );
  });

  it("names the break: TC-UI-07 - diff-only payload omits untouched builtin headers (case-insensitive)", async () => {
    const fetchSpy = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            headers: JSON.parse(opts.body).headers,
            builtinHeaders: { "User-Agent": "9router/1.0", "X-Builtin": "orig" },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          headers: {},
          builtinHeaders: { "User-Agent": "9router/1.0", "X-Builtin": "orig" },
        }),
      });
    });
    global.fetch = fetchSpy;

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const valInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");
    valInputs[1].props.onChange({ target: { value: "modified" } });

    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    await saveBtn.props.onClick();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/providers/codex/overrides",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          headers: {
            "X-Builtin": "modified",
          },
        }),
      })
    );
  });

  it("names the break: TC-UI-08 - reset button sends PUT with empty dict { headers: {} } for this provider only", async () => {
    const fetchSpy = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            headers: {},
            builtinHeaders: { "User-Agent": "9router" },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          headers: { "X-Custom": "test" },
          builtinHeaders: { "User-Agent": "9router" },
        }),
      });
    });
    global.fetch = fetchSpy;

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const resetBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Reset"))[0];
    await resetBtn.props.onClick();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/providers/codex/overrides",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers: {} }),
      })
    );
  });

  it("names the break: TC-UI-09 - save failure retains unsaved edits and renders role=alert banner", async () => {
    const fetchSpy = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ error: "Invalid header name: bad:token" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ headers: {}, builtinHeaders: {} }),
      });
    });
    global.fetch = fetchSpy;

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const nameInput = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name")[0];
    const valInput = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value")[0];

    nameInput.props.onChange({ target: { value: "bad:token" } });
    valInput.props.onChange({ target: { value: "secret-data" } });

    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    await saveBtn.props.onClick();

    tree = harness.render();
    const html = harness.getHtml(tree);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Invalid header name: bad:token");

    const updatedName = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name")[0];
    const updatedVal = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value")[0];

    expect(updatedName.props.value).toBe("bad:token");
    expect(updatedVal.props.value).toBe("secret-data");
  });

  it("names the break: TC-UI-15 - failed GET disables writes and displays error alert", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal Server Error" }),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const html = harness.getHtml(tree);
    expect(html).toContain('role="alert"');

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    expect(saveBtn.props.disabled).toBe(true);

    const inputs = findInTree(tree, (n) => n.type === "input");
    for (const input of inputs) {
      expect(input.props.disabled).toBe(true);
    }
  });

  it("names the break: TC-UI-16 - pending concurrent guard disables actions during save/reset", async () => {
    let resolveSave;
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ headers: { "X-Test": "1" }, builtinHeaders: {} }),
      });
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    const savePromise = saveBtn.props.onClick();

    tree = harness.render();

    const pendingSaveBtn = findInTree(tree, (n) => n.type === "button" && (n.props.children?.toString().includes("Saving") || n.props.children?.toString().includes("Save")))[0];
    expect(pendingSaveBtn.props.disabled).toBe(true);

    const resetBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Reset"))[0];
    expect(resetBtn.props.disabled).toBe(true);

    resolveSave({
      ok: true,
      json: async () => ({ headers: { "X-Test": "1" }, builtinHeaders: {} }),
    });
    await savePromise;

    tree = harness.render();
    const finalSaveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    expect(finalSaveBtn.props.disabled).toBeFalsy();
  });

  it("names the break: TC-UI-17 - provider switch discards stale in-flight responses", async () => {
    let resolveFirst;
    let resolveSecond;

    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes("provider-A")) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      if (url.includes("provider-B")) {
        return new Promise((resolve) => { resolveSecond = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => ({ headers: {}, builtinHeaders: {} }) });
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "provider-A" });
    let tree = harness.render();

    tree = harness.render({ providerId: "provider-B" });

    resolveSecond({
      ok: true,
      json: async () => ({
        headers: { "X-Provider": "B" },
        builtinHeaders: {},
      }),
    });
    await new Promise((r) => setTimeout(r, 10));
    tree = harness.render();

    resolveFirst({
      ok: true,
      json: async () => ({
        headers: { "X-Provider": "A" },
        builtinHeaders: {},
      }),
    });
    await new Promise((r) => setTimeout(r, 10));
    tree = harness.render();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const valInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");
    expect(valInputs.some((i) => i.props.value === "B")).toBe(true);
    expect(valInputs.some((i) => i.props.value === "A")).toBe(false);
  });
});

describe("CustomConfigCard - Gap Reproduction & Invariant Bounds", () => {
  let CustomConfigCard;
  const originalFetch = global.fetch;

  beforeEach(() => {
    const cardPath = resolveProjectPath(
      "src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js"
    );
    CustomConfigCard = loadComponentWithSwc(cardPath, {
      "@/shared/components": {
        Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
        Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
      },
      "@/store/notificationStore": {
        useNotificationStore: () => ({ success: vi.fn(), error: vi.fn() }),
      },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("names the break: TC-UI-GAP-01A - malformed GET response (null) must not enable writes without error alert", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => null,
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const html = harness.getHtml(tree);
    expect(html).toContain('role="alert"');

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    expect(saveBtn.props.disabled).toBe(true);
  });

  it("names the break: TC-UI-GAP-01B - HTTP 200 non-JSON or malformed map on save must not fabricate success notification or reset active override", async () => {
    const notifySpy = { success: vi.fn(), error: vi.fn() };
    const cardPath = resolveProjectPath(
      "src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js"
    );
    const CardWithSpy = loadComponentWithSwc(cardPath, {
      "@/shared/components": {
        Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
        Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
      },
      "@/store/notificationStore": {
        useNotificationStore: () => notifySpy,
      },
    });

    global.fetch = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
          },
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          headers: { "X-Custom": "val" },
          builtinHeaders: { "User-Agent": "9router" },
        }),
      });
    });

    const harness = createCardHarness(CardWithSpy, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    await saveBtn.props.onClick();

    tree = harness.render();
    const html = harness.getHtml(tree);

    expect(notifySpy.success).not.toHaveBeenCalled();
    expect(html).toContain('role="alert"');
  });

  it("names the break: TC-UI-GAP-01C - HTTP 200 non-JSON or malformed map on reset must not fabricate reset success notification", async () => {
    const notifySpy = { success: vi.fn(), error: vi.fn() };
    const cardPath = resolveProjectPath(
      "src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js"
    );
    const CardWithSpy = loadComponentWithSwc(cardPath, {
      "@/shared/components": {
        Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
        Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
      },
      "@/store/notificationStore": {
        useNotificationStore: () => notifySpy,
      },
    });

    global.fetch = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
          },
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          headers: { "X-Custom": "val" },
          builtinHeaders: { "User-Agent": "9router" },
        }),
      });
    });

    const harness = createCardHarness(CardWithSpy, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const resetBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Reset"))[0];
    await resetBtn.props.onClick();

    tree = harness.render();
    const html = harness.getHtml(tree);

    expect(notifySpy.success).not.toHaveBeenCalled();
    expect(html).toContain('role="alert"');
  });

  it("names the break: TC-UI-GAP-02 - pending save on provider A completing after switch to provider B must not corrupt provider B state", async () => {
    let resolvePutA;
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      if (url.includes("provider-A") && opts?.method === "PUT") {
        return new Promise((resolve) => {
          resolvePutA = resolve;
        });
      }
      if (url.includes("provider-A")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            headers: { "X-Provider-A": "custom-A" },
            builtinHeaders: { "X-Provider-A": "def-A" },
          }),
        });
      }
      if (url.includes("provider-B")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            headers: {},
            builtinHeaders: { "X-Provider-B": "def-B" },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ headers: {}, builtinHeaders: {} }) });
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "provider-A" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    const savePromise = saveBtn.props.onClick();

    tree = await harness.renderAsync({ providerId: "provider-B" });

    resolvePutA({
      ok: true,
      json: async () => ({
        headers: { "X-Provider-A": "custom-A" },
        builtinHeaders: { "X-Provider-A": "def-A" },
      }),
    });
    await savePromise;

    tree = harness.render();
    const html = harness.getHtml(tree);

    expect(html).not.toContain("Active");
  });

  it("names the break: TC-UI-GAP-03A - literal HTTP-valid __proto__ header key is preserved on load from GET without prototype pollution", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => JSON.parse('{"headers":{"__proto__":"custom-proto-value","constructor":"custom-ctor-value","toString":"custom-str-value","__Proto__":"custom-case-proto"},"builtinHeaders":{}}'),
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const nameInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
    const valInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");

    expect(nameInputs.some((i) => i.props.value === "constructor")).toBe(true);
    expect(valInputs.some((i) => i.props.value === "custom-ctor-value")).toBe(true);
    expect(nameInputs.some((i) => i.props.value === "toString")).toBe(true);
    expect(valInputs.some((i) => i.props.value === "custom-str-value")).toBe(true);
    expect(nameInputs.some((i) => i.props.value === "__Proto__")).toBe(true);
    expect(valInputs.some((i) => i.props.value === "custom-case-proto")).toBe(true);

    expect(nameInputs.some((i) => i.props.value === "__proto__")).toBe(true);
    expect(valInputs.some((i) => i.props.value === "custom-proto-value")).toBe(true);
    expect(Object.prototype.polluted).toBeUndefined();
  });

  it("names the break: TC-UI-GAP-03B - literal HTTP-valid __proto__ header key entered in UI is preserved in PUT body without prototype pollution", async () => {
    let capturedBody = null;
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        capturedBody = opts.body;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            headers: JSON.parse(opts.body).headers,
            builtinHeaders: {},
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ headers: {}, builtinHeaders: {} }),
      });
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const addBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Add"))[0];
    addBtn.props.onClick();
    addBtn.props.onClick();
    addBtn.props.onClick();
    tree = harness.render();

    const nameInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
    const valInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");

    nameInputs[0].props.onChange({ target: { value: "__proto__" } });
    valInputs[0].props.onChange({ target: { value: "custom-proto-override" } });

    nameInputs[1].props.onChange({ target: { value: "constructor" } });
    valInputs[1].props.onChange({ target: { value: "custom-ctor-override" } });

    nameInputs[2].props.onChange({ target: { value: "toString" } });
    valInputs[2].props.onChange({ target: { value: "custom-str-override" } });

    nameInputs[3].props.onChange({ target: { value: "__Proto__" } });
    valInputs[3].props.onChange({ target: { value: "custom-case-proto-override" } });

    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    await saveBtn.props.onClick();

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody);
    expect(parsed.headers["constructor"]).toBe("custom-ctor-override");
    expect(parsed.headers["toString"]).toBe("custom-str-override");
    expect(parsed.headers["__Proto__"]).toBe("custom-case-proto-override");
    expect(Object.prototype.hasOwnProperty.call(parsed.headers, "__proto__")).toBe(true);
    expect(parsed.headers["__proto__"]).toBe("custom-proto-override");
    expect(Object.prototype.polluted).toBeUndefined();
  });

  it("names the break: TC-UI-GAP-04A - case-insensitive duplicate row restoring builtin default must supersede earlier custom override under last-write-wins", async () => {
    let capturedBody = null;
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        capturedBody = opts.body;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            headers: JSON.parse(opts.body).headers,
            builtinHeaders: { "x-custom": "default-val" },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          headers: {},
          builtinHeaders: { "x-custom": "default-val" },
        }),
      });
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const valInput0 = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value")[0];
    valInput0.props.onChange({ target: { value: "overridden-val" } });

    const addBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Add"))[0];
    addBtn.props.onClick();
    tree = harness.render();

    const nameInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
    const valInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");

    nameInputs[1].props.onChange({ target: { value: "X-CUSTOM" } });
    valInputs[1].props.onChange({ target: { value: "default-val" } });

    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    await saveBtn.props.onClick();

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody);
    expect(parsed.headers).toEqual({});
  });

  it("names the break: TC-UI-GAP-04B - deleting override row must restore builtin header in table rows on authoritative success", async () => {
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            headers: {},
            builtinHeaders: { "User-Agent": "9router/1.0" },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          headers: { "User-Agent": "custom-agent" },
          builtinHeaders: { "User-Agent": "9router/1.0" },
        }),
      });
    });

    const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
    let tree = await harness.renderAsync();

    findInTree(tree, (n) => n.type === "button")[0].props.onClick();
    tree = harness.render();

    const valInput = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value")[0];
    expect(valInput.props.value).toBe("custom-agent");

    const deleteBtn = findInTree(tree, (n) => n.type === "button" && (n.props.title === "Remove header" || n.props["aria-label"] === "Remove header"))[0];
    deleteBtn.props.onClick();
    tree = harness.render();

    const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
    await saveBtn.props.onClick();

    tree = harness.render();

    const nameInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
    const valInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");

    expect(nameInputs[0].props.value).toBe("User-Agent");
    expect(valInputs[0].props.value).toBe("9router/1.0");
  });

  describe("Authoritative Response Shape Validation (GET, Save, Reset)", () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    const invalidResponseShapes = [
      { label: "empty object {}", payload: {} },
      { label: "missing builtinHeaders", payload: { headers: {} } },
      { label: "missing headers", payload: { builtinHeaders: {} } },
      { label: "null headers", payload: { headers: null, builtinHeaders: {} } },
      { label: "null builtinHeaders", payload: { headers: {}, builtinHeaders: null } },
      { label: "array headers", payload: { headers: [], builtinHeaders: {} } },
      { label: "array builtinHeaders", payload: { headers: {}, builtinHeaders: [] } },
      { label: "numeric header value", payload: { headers: { "X-Test": 123 }, builtinHeaders: {} } },
      { label: "null header value", payload: { headers: { "X-Test": null }, builtinHeaders: {} } },
      { label: "object header value", payload: { headers: { "X-Test": {} }, builtinHeaders: {} } },
      { label: "numeric builtin value", payload: { headers: {}, builtinHeaders: { "User-Agent": 456 } } },
    ];

    describe.each(invalidResponseShapes)("GET response validation: $label", ({ label, payload }) => {
      it(`names the break: malformed GET response (${label}) must display error alert and disable writes`, async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => payload,
        });

        const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
        let tree = await harness.renderAsync();

        findInTree(tree, (n) => n.type === "button")[0].props.onClick();
        tree = harness.render();

        const html = harness.getHtml(tree);
        expect(html).toContain('role="alert"');

        const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
        expect(saveBtn.props.disabled).toBe(true);

        const resetBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Reset"))[0];
        expect(resetBtn.props.disabled).toBe(true);
      });
    });

    describe.each(invalidResponseShapes)("Save response validation: $label", ({ label, payload }) => {
      it(`names the break: malformed save response (${label}) must retain rows, keep active state, and not fabricate success`, async () => {
        const notifySpy = { success: vi.fn(), error: vi.fn() };
        const cardPath = resolveProjectPath("src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js");
        const CardWithSpy = loadComponentWithSwc(cardPath, {
          "@/shared/components": {
            Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
            Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
          },
          "@/store/notificationStore": {
            useNotificationStore: () => notifySpy,
          },
        });

        global.fetch = vi.fn().mockImplementation((url, opts) => {
          if (opts?.method === "PUT") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => payload,
            });
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              headers: { "X-Custom": "orig-val" },
              builtinHeaders: { "User-Agent": "9router" },
            }),
          });
        });

        const harness = createCardHarness(CardWithSpy, { providerId: "codex" });
        let tree = await harness.renderAsync();

        findInTree(tree, (n) => n.type === "button")[0].props.onClick();
        tree = harness.render();

        const valInputsBefore = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");
        valInputsBefore[0].props.onChange({ target: { value: "modified-val" } });
        tree = harness.render();

        const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
        await saveBtn.props.onClick();

        tree = harness.render();
        const html = harness.getHtml(tree);

        expect(notifySpy.success).not.toHaveBeenCalled();
        expect(notifySpy.error).toHaveBeenCalled();
        expect(html).toContain('role="alert"');

        const valInputsAfter = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");
        expect(valInputsAfter[0].props.value).toBe("modified-val");
      });
    });

    describe.each(invalidResponseShapes)("Reset response validation: $label", ({ label, payload }) => {
      it(`names the break: malformed reset response (${label}) must retain rows, keep active state, and not fabricate success`, async () => {
        const notifySpy = { success: vi.fn(), error: vi.fn() };
        const cardPath = resolveProjectPath("src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js");
        const CardWithSpy = loadComponentWithSwc(cardPath, {
          "@/shared/components": {
            Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
            Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
          },
          "@/store/notificationStore": {
            useNotificationStore: () => notifySpy,
          },
        });

        global.fetch = vi.fn().mockImplementation((url, opts) => {
          if (opts?.method === "PUT") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => payload,
            });
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              headers: { "X-Custom": "custom-val" },
              builtinHeaders: { "User-Agent": "9router" },
            }),
          });
        });

        const harness = createCardHarness(CardWithSpy, { providerId: "codex" });
        let tree = await harness.renderAsync();

        findInTree(tree, (n) => n.type === "button")[0].props.onClick();
        tree = harness.render();

        const resetBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Reset"))[0];
        await resetBtn.props.onClick();

        tree = harness.render();
        const html = harness.getHtml(tree);

        expect(notifySpy.success).not.toHaveBeenCalled();
        expect(notifySpy.error).toHaveBeenCalled();
        expect(html).toContain('role="alert"');

        const valInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");
        expect(valInputs.some((i) => i.props.value === "custom-val")).toBe(true);
      });
    });

    it("names the break: reset must validate authoritative returned map and not claim defaults cleared if server returns non-empty overrides", async () => {
      const notifySpy = { success: vi.fn(), error: vi.fn() };
      const cardPath = resolveProjectPath("src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js");
      const CardWithSpy = loadComponentWithSwc(cardPath, {
        "@/shared/components": {
          Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
          Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
        },
        "@/store/notificationStore": {
          useNotificationStore: () => notifySpy,
        },
      });

      global.fetch = vi.fn().mockImplementation((url, opts) => {
        if (opts?.method === "PUT") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              headers: { "X-Retained-Override": "still-active" },
              builtinHeaders: { "User-Agent": "9router" },
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            headers: { "X-Retained-Override": "still-active" },
            builtinHeaders: { "User-Agent": "9router" },
          }),
        });
      });

      const harness = createCardHarness(CardWithSpy, { providerId: "codex" });
      let tree = await harness.renderAsync();

      findInTree(tree, (n) => n.type === "button")[0].props.onClick();
      tree = harness.render();

      const resetBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Reset"))[0];
      await resetBtn.props.onClick();

      tree = harness.render();
      const html = harness.getHtml(tree);

      expect(notifySpy.success).not.toHaveBeenCalledWith("Headers reset to defaults");
      expect(notifySpy.error).toHaveBeenCalled();
      expect(html).toContain('role="alert"');

      const nameInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
      const valInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");
      expect(nameInputs.some((i) => i.props.value === "X-Retained-Override")).toBe(true);
      expect(valInputs.some((i) => i.props.value === "still-active")).toBe(true);
      expect(html).toContain("Active");
    });
  });

  describe("Deferred Sequence & Component Lifecycle Stale Protection", () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    describe.each([
      {
        caseName: "HTTP 400 error",
        mockResponse: {
          ok: false,
          status: 400,
          json: async () => ({ error: "Bad Request" }),
        },
      },
      {
        caseName: "invalid JSON syntax",
        mockResponse: {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
          },
        },
      },
      {
        caseName: "successful HTTP 200",
        mockResponse: {
          ok: true,
          status: 200,
          json: async () => ({
            headers: { "X-Provider-A": "saved-val" },
            builtinHeaders: {},
          }),
        },
      },
    ])("Deferred unmount sequence: $caseName", ({ caseName, mockResponse }) => {
      it(`names the break: stale completion of ${caseName} after component unmount must not notify or corrupt state`, async () => {
        const notifySpy = { success: vi.fn(), error: vi.fn() };
        const cardPath = resolveProjectPath("src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js");
        const CardWithSpy = loadComponentWithSwc(cardPath, {
          "@/shared/components": {
            Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
            Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
          },
          "@/store/notificationStore": {
            useNotificationStore: () => notifySpy,
          },
        });

        let resolvePutA;
        global.fetch = vi.fn().mockImplementation((url, opts) => {
          if (url.includes("provider-A") && opts?.method === "PUT") {
            return new Promise((resolve) => {
              resolvePutA = resolve;
            });
          }
          if (url.includes("provider-A")) {
            return Promise.resolve({
              ok: true,
              json: async () => ({ headers: { "X-A": "orig" }, builtinHeaders: {} }),
            });
          }
          return Promise.resolve({ ok: true, json: async () => ({ headers: {}, builtinHeaders: {} }) });
        });

        const harnessA = createCardHarness(CardWithSpy, { providerId: "provider-A" });
        let treeA = await harnessA.renderAsync();

        findInTree(treeA, (n) => n.type === "button")[0].props.onClick();
        treeA = harnessA.render();

        const saveBtn = findInTree(treeA, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
        const savePromise = saveBtn.props.onClick();

        harnessA.unmount();

        resolvePutA(mockResponse);
        await savePromise;

        expect(notifySpy.success).not.toHaveBeenCalled();
        expect(notifySpy.error).not.toHaveBeenCalled();
      });
    });

    it("names the break: same-component provider change A-B-A discards old generation completion", async () => {
      const notifySpy = { success: vi.fn(), error: vi.fn() };
      const cardPath = resolveProjectPath("src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js");
      const CardWithSpy = loadComponentWithSwc(cardPath, {
        "@/shared/components": {
          Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
          Badge: ({ children, ...props }) => React.createElement("span", { "data-badge": true, ...props }, children),
        },
        "@/store/notificationStore": {
          useNotificationStore: () => notifySpy,
        },
      });

      let resolveFirstPutA;
      global.fetch = vi.fn().mockImplementation((url, opts) => {
        if (url.includes("provider-A") && opts?.method === "PUT") {
          return new Promise((resolve) => {
            resolveFirstPutA = resolve;
          });
        }
        if (url.includes("provider-A")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ headers: {}, builtinHeaders: {} }),
          });
        }
        if (url.includes("provider-B")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ headers: {}, builtinHeaders: {} }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ headers: {}, builtinHeaders: {} }) });
      });

      const harness = createCardHarness(CardWithSpy, { providerId: "provider-A" });
      let tree = await harness.renderAsync();

      findInTree(tree, (n) => n.type === "button")[0].props.onClick();
      tree = harness.render();

      const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
      const firstSavePromise = saveBtn.props.onClick();

      await harness.renderAsync({ providerId: "provider-B" });
      await harness.renderAsync({ providerId: "provider-A" });

      resolveFirstPutA({
        ok: true,
        status: 200,
        json: async () => ({
          headers: { "X-Old-Gen": "stale" },
          builtinHeaders: {},
        }),
      });
      await firstSavePromise;

      tree = harness.render();
      const html = harness.getHtml(tree);

      expect(notifySpy.success).not.toHaveBeenCalled();
      expect(html).not.toContain("X-Old-Gen");
    });
  });

  describe("Prototype and Standard HTTP Header Keys", () => {
    it("names the break: sensitive and prototype header keys in PUT payload are unblocked and preserved", async () => {
      let capturedBody = null;
      global.fetch = vi.fn().mockImplementation((url, opts) => {
        if (opts?.method === "PUT") {
          capturedBody = opts.body;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              headers: JSON.parse(opts.body).headers,
              builtinHeaders: {},
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ headers: {}, builtinHeaders: {} }),
        });
      });

      const harness = createCardHarness(CustomConfigCard, { providerId: "codex" });
      let tree = await harness.renderAsync();

      findInTree(tree, (n) => n.type === "button")[0].props.onClick();
      tree = harness.render();

      const addBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Add"))[0];
      for (let i = 0; i < 7; i++) {
        addBtn.props.onClick();
      }
      tree = harness.render();

      const headersToTest = [
        ["Authorization", "Bearer secret-token"],
        ["Cookie", "session=123"],
        ["Host", "custom.api.com"],
        ["Content-Type", "application/json"],
        ["Content-Length", "1024"],
        ["Transfer-Encoding", "chunked"],
        ["valueOf", "custom-valueOf"],
        ["__proto__", "custom-proto"],
      ];

      const nameInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Header-Name");
      const valInputs = findInTree(tree, (n) => n.type === "input" && n.props.placeholder === "Value");

      headersToTest.forEach(([name, val], idx) => {
        nameInputs[idx].props.onChange({ target: { value: name } });
        valInputs[idx].props.onChange({ target: { value: val } });
      });

      tree = harness.render();

      const saveBtn = findInTree(tree, (n) => n.type === "button" && n.props.children?.toString().includes("Save"))[0];
      await saveBtn.props.onClick();

      expect(capturedBody).not.toBeNull();
      const parsed = JSON.parse(capturedBody);
      headersToTest.forEach(([name, val]) => {
        expect(parsed.headers[name]).toBe(val);
      });
    });
  });
});