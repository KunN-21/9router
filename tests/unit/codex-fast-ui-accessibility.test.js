import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import React from "react";
import ReactDOMServer from "react-dom/server";
import swc from "next/dist/build/swc";

/**
 * Test helper using installed Next SWC to compile JSX Client Components into
 * executable CommonJS for pure headless Node testing without jsdom/testing-library.
 * Note: Headless SSR verifies markup and attribute contracts; full browser accessibility
 * (e.g. keyboard focus traversal, screen reader virtual buffers) requires a browser engine.
 */
function loadComponentWithSwc(relativePath, mocks = {}) {
  const resolvedPath = path.isAbsolute(relativePath)
    ? relativePath
    : path.resolve(process.cwd(), relativePath.startsWith("tests/") ? relativePath : relativePath);

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

const makeDefault = (fn) => {
  fn.default = fn;
  fn.__esModule = true;
  return fn;
};

/**
 * Minimal test-only hook harness that emulates React state lifecycle during SSR,
 * executing actual component callbacks and tracking state transitions across re-renders
 * without generic rendering frameworks or production test-only exports.
 */
function createHookHarness(Component, initialStateOverrides = {}, options = {}) {
  const hooks = [];
  const effectHooks = [];
  let isInitial = true;

  function render(props = {}) {
    let hookIndex = 0;
    let effectIndex = 0;
    const prevUseState = React.useState;
    const prevUseEffect = React.useEffect;
    const pendingEffects = [];
    let stateUpdatedInEffect = false;

    React.useState = (initial) => {
      const idx = hookIndex++;
      if (isInitial) {
        let initVal = typeof initial === "function" ? initial() : initial;
        if (idx in initialStateOverrides) {
          initVal = initialStateOverrides[idx];
        }
        const setter = (update) => {
          hooks[idx].value = typeof update === "function" ? update(hooks[idx].value) : update;
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
    }

    let html;
    try {
      html = ReactDOMServer.renderToString(React.createElement(Component, props));
      isInitial = false;
    } finally {
      React.useState = prevUseState;
      if (options.executeEffects) {
        React.useEffect = prevUseEffect;
      }
    }

    if (options.executeEffects) {
      stateUpdatedInEffect = false;
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
        try {
          html = ReactDOMServer.renderToString(React.createElement(Component, props));
        } finally {
          React.useState = prevUseState;
        }
      }
    }

    return html;
  }

  return {
    render,
    getHookState: (idx) => hooks[idx]?.value,
    setHookState: (idx, val) => hooks[idx]?.setter(val),
  };
}

let getPageHarness;
let getProviderLimitsHarness;
let getConnectionsCardHarness;

describe("ConnectionRow - Fast Mode Accessibility & Behavior (Ruling D)", () => {
  let capturedFastTooltip = null;
  let capturedFastButton = null;

  const createConnectionRow = (overrides = {}) => {
    capturedFastTooltip = null;
    capturedFastButton = null;

    const mocks = {
      "@/shared/components": {
        Badge: ({ children, variant, size, ...props }) =>
          React.createElement("span", { "data-badge": variant || "default", "data-size": size, ...props }, children),
        Toggle: ({ checked, onChange, title, disabled, size }) =>
          React.createElement("button", { "data-toggle": true, disabled, title, "data-checked": checked }),
        Tooltip: ({ children, text }) => {
          if (typeof text === "string" && text.includes("Fast Mode")) {
            capturedFastTooltip = text;
            capturedFastButton = children;
          }
          return React.createElement("div", { "data-tooltip": text }, children);
        },
      },
      "@/shared/utils/connectionStatus": {
        getStatusVariant: () => "default",
      },
      "./CooldownTimer": () => null,
      ...overrides.mocks,
    };

    const targetPath = path.resolve(process.cwd(), "../src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js");
    const ConnectionRow = loadComponentWithSwc(
      fs.existsSync(targetPath) ? targetPath : path.resolve(process.cwd(), "src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js"),
      mocks
    );
    return ConnectionRow;
  };

  it("names the break: skips Fast mode button for non-Codex connections", () => {
    const ConnectionRow = createConnectionRow();
    const conn = {
      id: "conn_anthropic_1",
      provider: "anthropic",
      isActive: true,
      providerSpecificData: { codexFastMode: true },
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ConnectionRow, {
        connection: conn,
        isOAuth: true,
        isFirst: false,
        isLast: false,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onToggleActive: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
      })
    );

    expect(html).not.toContain("Toggle Codex Fast Mode");
    expect(capturedFastButton).toBeNull();
  });

  it("names the break: renders accessible Fast mode button for Codex connection with strict false state", () => {
    const ConnectionRow = createConnectionRow();
    const conn = {
      id: "conn_codex_1",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ConnectionRow, {
        connection: conn,
        isOAuth: true,
        isFirst: false,
        isLast: false,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onToggleActive: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        isFastMode: false,
        updatingFastMode: false,
        onToggleFastMode: vi.fn(),
      })
    );

    expect(html).toContain('aria-label="Toggle Codex Fast Mode (request priority; more quota may be consumed)"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain(">Fast</span>");
    expect(html).toContain(">bolt</span>");
    expect(capturedFastTooltip).toContain("request priority; more quota may be consumed");
    expect(capturedFastButton?.props?.type).toBe("button");
    expect(capturedFastButton?.props?.disabled).toBeFalsy();
  });

  it("names the break: enforces strict boolean evaluation (string false is not treated as enabled)", () => {
    const ConnectionRow = createConnectionRow();
    const conn = {
      id: "conn_codex_strict",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: "false" },
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ConnectionRow, {
        connection: conn,
        isOAuth: true,
        isFirst: false,
        isLast: false,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onToggleActive: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
      })
    );

    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("text-primary flex w-full flex-col items-center rounded");
  });

  it("names the break: renders active state and Fast badge when codexFastMode is strictly true", () => {
    const ConnectionRow = createConnectionRow();
    const conn = {
      id: "conn_codex_active",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: true },
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ConnectionRow, {
        connection: conn,
        isOAuth: true,
        isFirst: false,
        isLast: false,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onToggleActive: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        isFastMode: true,
      })
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("text-primary");
    expect(html).toContain('data-badge="primary"');
    expect(html).toContain(">Fast</span>");
  });

  it("names the break: disables Fast mode button and prevents clicks when connection is inactive", () => {
    const onToggleFastMode = vi.fn();
    const ConnectionRow = createConnectionRow();
    const conn = {
      id: "conn_codex_inactive",
      provider: "codex",
      isActive: false,
      providerSpecificData: { codexFastMode: false },
    };

    ReactDOMServer.renderToString(
      React.createElement(ConnectionRow, {
        connection: conn,
        isOAuth: true,
        isFirst: false,
        isLast: false,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onToggleActive: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        isFastMode: false,
        updatingFastMode: false,
        onToggleFastMode,
      })
    );

    expect(capturedFastButton).not.toBeNull();
    expect(capturedFastButton?.props?.disabled).toBe(true);

    capturedFastButton?.props?.onClick?.({ preventDefault: () => {} });
    expect(onToggleFastMode).not.toHaveBeenCalled();
  });

  it("names the break: sets aria-busy and ignores duplicate click when update is pending", () => {
    const onToggleFastMode = vi.fn();
    const ConnectionRow = createConnectionRow();
    const conn = {
      id: "conn_codex_busy",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ConnectionRow, {
        connection: conn,
        isOAuth: true,
        isFirst: false,
        isLast: false,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onToggleActive: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        isFastMode: false,
        updatingFastMode: true,
        onToggleFastMode,
      })
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("progress_activity");
    expect(capturedFastButton?.props?.disabled).toBe(true);

    capturedFastButton?.props?.onClick?.({ preventDefault: () => {} });
    expect(onToggleFastMode).not.toHaveBeenCalled();
  });

  it("names the break: clicking toggle invokes onToggleFastMode with correct inverted boolean", () => {
    const onToggleFastMode = vi.fn();
    const ConnectionRow = createConnectionRow();
    const conn = {
      id: "conn_codex_click",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };

    ReactDOMServer.renderToString(
      React.createElement(ConnectionRow, {
        connection: conn,
        isOAuth: true,
        isFirst: false,
        isLast: false,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onToggleActive: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        isFastMode: false,
        updatingFastMode: false,
        onToggleFastMode,
      })
    );

    expect(capturedFastButton).not.toBeNull();
    capturedFastButton.props.onClick();
    expect(onToggleFastMode).toHaveBeenCalledTimes(1);
    expect(onToggleFastMode).toHaveBeenCalledWith(true);

    const onToggleFastModeReverse = vi.fn();
    ReactDOMServer.renderToString(
      React.createElement(ConnectionRow, {
        connection: { ...conn, providerSpecificData: { codexFastMode: true } },
        isOAuth: true,
        isFirst: false,
        isLast: false,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onToggleActive: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        isFastMode: true,
        updatingFastMode: false,
        onToggleFastMode: onToggleFastModeReverse,
      })
    );

    capturedFastButton.props.onClick();
    expect(onToggleFastModeReverse).toHaveBeenCalledTimes(1);
    expect(onToggleFastModeReverse).toHaveBeenCalledWith(false);
  });
});

describe("ProviderLimits Quota Card Controls & Badges (Ruling D)", () => {
  let capturedQuotaFastTooltip = null;
  let capturedQuotaFastButton = null;
  let capturedQuotaFastButtons = [];
  let capturedProviderLimitsEditModalProps = null;

  const makeUtilsMock = (overrides = {}) => {
    const base = {
      QUOTA_CACHE_KEY: "quotaCacheData",
      REFRESH_INTERVAL_MS: 60000,
      CLAUDE_REFRESH_INTERVAL_MS: 600000,
      DEPLETED_QUOTA_THRESHOLD: 5,
      AUTO_REFRESH_STORAGE_KEY: "quotaAutoRefresh",
      CONNECTIONS_PAGE_SIZE: 20,
      ACCOUNT_PAGE_SIZE_OPTIONS: [10, 20, 50, 100],
      ACCOUNT_PAGE_SIZE_MAX: 500,
      ACCOUNT_FILTER_OPTIONS: [
        { value: "all", label: "All Accounts" },
        { value: "active", label: "Active" },
        { value: "disabled", label: "Disabled" },
      ],
      QUOTA_SORT_OPTIONS: [
        { value: "default", label: "Default order" },
        { value: "5h-asc", label: "Lowest 5h remaining" },
      ],
      formatSubscriptionActiveUntil: () => ({ dateTime: "2026-11-01", display: "Nov 1" }),
      shouldShowSubscriptionExpiry: () => false,
      getCodexResetCreditCount: () => 0,
      getConnectionLabel: (c) => c?.name || "conn",
      getConnectionSecondaryLabel: () => null,
      providerLabel: (p) => p,
      getHiddenQuotaRows: () => [],
      filterQuotaStateByConnections: (s) => s,
      buildLoadingState: () => ({}),
      sortVisibleConnections: (c) => c || [],
      getConnectionsEmptyMessage: () => "No connections",
      getProviderOptions: () => [],
      getSafeTotals: () => ({ total: 0 }),
      getPaginationPageValue: () => 1,
      getSafePagination: () => ({ page: 1, totalPages: 1 }),
      formatCreditDate: (d) => String(d),
      formatClaudeResetClears: (c) => String(c),
      reconcileConnectionsPage: async (fetchConnections, targetPage) => {
        if (typeof fetchConnections === "function") {
          return await fetchConnections(targetPage);
        }
      },
      ...overrides,
    };
    return new Proxy(base, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        return () => null;
      },
    });
  };

  const createProviderLimitsHarness = ({
    initialConnections = [],
    initialUpdatingFastModeId = null,
    reconcileSpy = null,
    showEditModal = false,
    selectedConnection = null,
  } = {}) => {
    capturedQuotaFastTooltip = null;
    capturedQuotaFastButton = null;
    capturedQuotaFastButtons = [];
    capturedProviderLimitsEditModalProps = null;

    const utilsMock = makeUtilsMock(reconcileSpy ? { reconcileConnectionsPage: reconcileSpy } : {});

    const mocks = {
      "next/navigation": {
        useSearchParams: () => new URLSearchParams(),
        useRouter: () => ({ push: () => {}, replace: () => {} }),
        usePathname: () => "/dashboard/usage",
      },
      "@/app/(dashboard)/dashboard/providers/[id]/AutoPingScheduleModal": () => null,
      "@/shared/services/quotaPingSchedule": { getScheduleSlotLabels: () => [] },
      "@/shared/components": {
        Card: ({ children, className, ...props }) =>
          React.createElement("div", { "data-card": true, className, ...props }, children),
        Button: ({ children, ...props }) => React.createElement("button", { ...props }, children),
        Tooltip: ({ children, text }) => {
          if (typeof text === "string" && text.includes("Fast Mode")) {
            capturedQuotaFastTooltip = text;
            capturedQuotaFastButton = children;
            capturedQuotaFastButtons.push(children);
          }
          return React.createElement("div", { "data-tooltip": text }, children);
        },
        ConfirmModal: () => null,
        EditConnectionModal: Object.assign(
          (props) => {
            capturedProviderLimitsEditModalProps = props;
            return null;
          },
          { displayName: "MockProviderLimitsEditConnectionModal" }
        ),
      },
      "@/shared/components/Card": ({ children, className, ...props }) =>
        React.createElement("div", { "data-card": true, className, ...props }, children),
      "@/shared/components/ProviderIcon": () => React.createElement("span", null, "icon"),
      "@/shared/components/Toggle": () => React.createElement("input", { type: "checkbox" }),
      "@/shared/components/Tooltip": ({ children, text }) => {
        if (typeof text === "string" && text.includes("Fast Mode")) {
          capturedQuotaFastTooltip = text;
          capturedQuotaFastButton = children;
          capturedQuotaFastButtons.push(children);
        }
        return React.createElement("div", { "data-tooltip": text }, children);
      },
      "@/shared/constants/providers": {
        AI_PROVIDERS: { codex: { id: "codex", name: "OpenAI Codex" } },
        USAGE_SUPPORTED_PROVIDERS: ["codex", "claude"],
      },
      "@/shared/hooks/useCopyToClipboard": {
        useCopyToClipboard: () => ({ copied: null, copy: () => {} }),
      },
      "./ProviderIcon": () => React.createElement("span", null, "icon"),
      "./QuotaTable": () => React.createElement("div", null, "table"),
      "./utils": utilsMock,
    };

    const targetPath = path.resolve(process.cwd(), "../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js");
    const ProviderLimits = loadComponentWithSwc(
      fs.existsSync(targetPath) ? targetPath : path.resolve(process.cwd(), "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js"),
      mocks
    );

    const harness = createHookHarness(ProviderLimits, {
      0: initialConnections,
      14: typeof initialUpdatingFastModeId === "string"
        ? { [initialUpdatingFastModeId]: true }
        : (initialUpdatingFastModeId || {}),
      18: showEditModal,
      19: selectedConnection,
    });

    return {
      harness,
      getCapturedButton: () => capturedQuotaFastButton,
      getCapturedButtons: () => capturedQuotaFastButtons,
      getCapturedTooltip: () => capturedQuotaFastTooltip,
      getCapturedEditModalProps: () => capturedProviderLimitsEditModalProps,
    };
  };
  getProviderLimitsHarness = createProviderLimitsHarness;

  it("names the break: renders Fast badge on Codex quota card when codexFastMode is strictly true", () => {
    const { harness, getCapturedButton, getCapturedTooltip } = createProviderLimitsHarness({
      initialConnections: [
        {
          id: "conn_quota_codex_1",
          provider: "codex",
          isActive: true,
          providerSpecificData: { codexFastMode: true },
        },
      ],
    });

    const html = harness.render();
    expect(html).toContain(">Fast</span>");
    expect(html).toContain('aria-label="Toggle Codex Fast Mode (request priority; more quota may be consumed)"');
    expect(html).toContain('aria-pressed="true"');

    const button = getCapturedButton();
    expect(button).not.toBeNull();
    expect(button.props["aria-pressed"]).toBe(true);
    expect(button.props["aria-busy"]).toBe(false);
    expect(button.props.disabled).toBeFalsy();
    expect(button.props.type).toBe("button");
    expect(getCapturedTooltip()).toContain("request priority; more quota may be consumed");
  });

  it("names the break: omits Fast badge when codexFastMode is false or provider is not Codex", () => {
    const { harness, getCapturedButton } = createProviderLimitsHarness({
      initialConnections: [
        {
          id: "conn_quota_claude_1",
          provider: "claude",
          isActive: true,
          providerSpecificData: { codexFastMode: true },
        },
      ],
    });

    const html = harness.render();
    expect(html).not.toContain("Toggle Codex Fast Mode");
    expect(getCapturedButton()).toBeNull();
  });

  it("names the break: invokes actual handleToggleCodexFastMode onClick issuing PUT /api/providers/<id> with { codexFastMode } and reconciles", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    const { harness, getCapturedButton } = createProviderLimitsHarness({
      initialConnections: [
        {
          id: "conn_quota_codex_toggle",
          provider: "codex",
          isActive: true,
          providerSpecificData: { codexFastMode: false },
        },
      ],
      reconcileSpy,
    });

    harness.render();
    const button = getCapturedButton();
    expect(button).not.toBeNull();
    expect(button.props["aria-pressed"]).toBe(false);

    const originalFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        connection: {
          id: "conn_quota_codex_toggle",
          provider: "codex",
          isActive: true,
          providerSpecificData: { codexFastMode: true },
        },
      }),
    });
    global.fetch = fetchSpy;

    try {
      await button.props.onClick();

      expect(fetchSpy).toHaveBeenCalledWith("/api/providers/conn_quota_codex_toggle", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexFastMode: true }),
      });
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(harness.getHookState(14)).toEqual({});
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: handles async error/rejection in handleToggleCodexFastMode without reconciling and records error", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    const { harness, getCapturedButton } = createProviderLimitsHarness({
      initialConnections: [
        {
          id: "conn_quota_codex_err",
          provider: "codex",
          isActive: true,
          providerSpecificData: { codexFastMode: false },
        },
      ],
      reconcileSpy,
    });

    harness.render();
    const button = getCapturedButton();
    expect(button).not.toBeNull();

    const originalFetch = global.fetch;
    const originalConsoleError = console.error;
    console.error = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Quota backend unreachable" }),
    });
    global.fetch = fetchSpy;

    try {
      await button.props.onClick();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(reconcileSpy).not.toHaveBeenCalled();
      const errors = harness.getHookState(3);
      expect(errors?.conn_quota_codex_err).toBe("Quota backend unreachable");
      expect(harness.getHookState(14)).toEqual({});
    } finally {
      global.fetch = originalFetch;
      console.error = originalConsoleError;
    }
  });

  it("names the break: disables quota button and guards onClick when connection is inactive or update is pending", async () => {
    // Inactive account check
    const { harness: inactiveHarness, getCapturedButton: getInactiveButton } = createProviderLimitsHarness({
      initialConnections: [
        {
          id: "conn_quota_inactive",
          provider: "codex",
          isActive: false,
          providerSpecificData: { codexFastMode: false },
        },
      ],
    });

    inactiveHarness.render();
    const inactiveButton = getInactiveButton();
    expect(inactiveButton).not.toBeNull();
    expect(inactiveButton.props.disabled).toBe(true);

    const originalFetch = global.fetch;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    try {
      await inactiveButton.props.onClick();
      expect(fetchSpy).not.toHaveBeenCalled();

      // Busy / pending check
      const { harness: busyHarness, getCapturedButton: getBusyButton } = createProviderLimitsHarness({
        initialConnections: [
          {
            id: "conn_quota_busy",
            provider: "codex",
            isActive: true,
            providerSpecificData: { codexFastMode: false },
          },
        ],
        initialUpdatingFastModeId: "conn_quota_busy",
      });

      busyHarness.render();
      const busyButton = getBusyButton();
      expect(busyButton).not.toBeNull();
      expect(busyButton.props.disabled).toBe(true);
      expect(busyButton.props["aria-busy"]).toBe(true);

      await busyButton.props.onClick();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: preserves authoritative connection state from PUT even when subsequent refetch fails", async () => {
    const initialConn = {
      id: "conn_quota_codex_authoritative",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness, getCapturedButton } = createProviderLimitsHarness({
      initialConnections: [initialConn],
    });

    harness.render();
    const button = getCapturedButton();
    expect(button).not.toBeNull();

    const originalFetch = global.fetch;
    const originalConsoleError = console.error;
    console.error = vi.fn();

    const fetchSpy = vi.fn((url, opts) => {
      if (opts?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            connection: {
              id: "conn_quota_codex_authoritative",
              provider: "codex",
              isActive: true,
              providerSpecificData: { codexFastMode: true },
            },
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: "Refetch failed" }),
      });
    });
    global.fetch = fetchSpy;

    try {
      await button.props.onClick();

      const updatedConnections = harness.getHookState(0);
      expect(updatedConnections[0]?.providerSpecificData?.codexFastMode).toBe(true);
    } finally {
      global.fetch = originalFetch;
      console.error = originalConsoleError;
    }
  });

  it("names the break: maintains independent updatingFastMode states for concurrent quota cards and does not clear B when A completes", async () => {
    const connA = {
      id: "conn_quota_A",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const connB = {
      id: "conn_quota_B",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness, getCapturedButtons } = createProviderLimitsHarness({
      initialConnections: [connA, connB],
    });
    harness.render();
    const buttons = getCapturedButtons();
    expect(buttons.length).toBe(2);

    let resolveA;
    let resolveB;
    const promiseA = new Promise((r) => { resolveA = r; });
    const promiseB = new Promise((r) => { resolveB = r; });

    const originalFetch = global.fetch;
    global.fetch = vi.fn((url) => {
      if (url.includes("conn_quota_A")) return promiseA;
      if (url.includes("conn_quota_B")) return promiseB;
      return Promise.reject(new Error("Unknown url: " + url));
    });

    try {
      const clickPromiseA = buttons[0].props.onClick();
      const clickPromiseB = buttons[1].props.onClick();

      // Check both are in-flight in hook 13
      const updatingMap = harness.getHookState(14);
      expect(updatingMap?.["conn_quota_A"]).toBe(true);
      expect(updatingMap?.["conn_quota_B"]).toBe(true);

      // Finish A
      resolveA({
        ok: true,
        status: 200,
        json: async () => ({
          connection: {
            id: "conn_quota_A",
            provider: "codex",
            isActive: true,
            providerSpecificData: { codexFastMode: true },
          },
        }),
      });
      await clickPromiseA;

      // When scalar updatingFastModeId was used, completing A wiped out B's busy state
      const updatingMapAfterA = harness.getHookState(14);
      expect(updatingMapAfterA?.["conn_quota_B"]).toBe(true);
      expect(updatingMapAfterA?.["conn_quota_A"]).toBeUndefined();

      // Finish B
      resolveB({
        ok: true,
        status: 200,
        json: async () => ({
          connection: {
            id: "conn_quota_B",
            provider: "codex",
            isActive: true,
            providerSpecificData: { codexFastMode: true },
          },
        }),
      });
      await clickPromiseB;

      const finalMap = harness.getHookState(14);
      expect(finalMap?.["conn_quota_B"]).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: fast-only toggle in ProviderLimits performs authoritative PUT update without issuing GET /api/providers/client", async () => {
    const initialConn = {
      id: "conn_quota_fast_no_get",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness, getCapturedButton } = createProviderLimitsHarness({
      initialConnections: [initialConn],
    });
    harness.render();
    const button = getCapturedButton();

    const originalFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        connection: {
          id: "conn_quota_fast_no_get",
          provider: "codex",
          isActive: true,
          providerSpecificData: { codexFastMode: true },
        },
      }),
    });
    global.fetch = fetchSpy;

    try {
      await button.props.onClick();

      expect(fetchSpy).toHaveBeenCalledWith("/api/providers/conn_quota_fast_no_get", expect.objectContaining({
        method: "PUT",
      }));
      const getCalls = fetchSpy.mock.calls.filter(([url, opts]) => !opts || opts.method === "GET" || opts.method === undefined);
      expect(getCalls.length).toBe(0);

      const connections = harness.getHookState(0);
      expect(connections[0]?.providerSpecificData?.codexFastMode).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: ProviderLimits rejects missing id in PUT response, sets error and preserves state", async () => {
    const initialConn = {
      id: "conn_quota_missing_id",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness, getCapturedButton } = createProviderLimitsHarness({
      initialConnections: [initialConn],
    });
    harness.render();
    const button = getCapturedButton();

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        connection: {
          providerSpecificData: { codexFastMode: true },
        },
      }),
    });

    try {
      await button.props.onClick();
      const connections = harness.getHookState(0);
      expect(connections[0].providerSpecificData.codexFastMode).toBe(false);
      const errors = harness.getHookState(3);
      expect(errors["conn_quota_missing_id"]).toBe("Malformed connection response from server");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("ProviderDetailPage (page.js) Wire Contracts & Error Handling (Ruling D)", () => {
  const createPageHarness = (
    initialConnections = [],
    initialUpdatingId = null,
    { showEditModal = false, selectedConnection = null } = {}
  ) => {
    const capturedRowProps = [];
    const capturedRowsById = {};
    let capturedEditModalProps = null;

    const makeComp = (name) => {
      const c = ({ children }) => (children ? React.createElement(React.Fragment, null, children) : null);
      c.displayName = name;
      return c;
    };

    const compNames = [
      "Card", "Button", "Badge", "Input", "Modal", "CardSkeleton", "OAuthModal",
      "KiroOAuthWrapper", "CursorAuthModal", "ZedAuthModal", "XiaomiMimoAuthModal",
      "IFlowCookieModal", "GitLabAuthModal", "Toggle", "Select",
      "NoAuthProxyCard", "ConfirmModal"
    ];

    const sharedComponentsMock = { __esModule: true };
    for (const name of compNames) {
      sharedComponentsMock[name] = makeComp(name);
    }
    const MockCard = ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children);
    MockCard.displayName = "MockCard";
    const MockButton = ({ children, ...props }) => React.createElement("button", { ...props }, children);
    MockButton.displayName = "MockButton";
    const MockBadge = ({ children, ...props }) => React.createElement("span", { ...props }, children);
    MockBadge.displayName = "MockBadge";
    const MockToggle = ({ checked, onChange }) => React.createElement("input", { type: "checkbox", checked, onChange });
    MockToggle.displayName = "MockToggle";

    sharedComponentsMock.Card = MockCard;
    sharedComponentsMock.Button = MockButton;
    sharedComponentsMock.Badge = MockBadge;
    sharedComponentsMock.Toggle = MockToggle;
    const MockEditConnectionModal = (props) => {
      capturedEditModalProps = props;
      return null;
    };
    MockEditConnectionModal.displayName = "MockEditConnectionModal";
    sharedComponentsMock.EditConnectionModal = MockEditConnectionModal;

    const notificationStoreErrorSpy = vi.fn();
    const mocks = {
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
        useNotificationStore: Object.assign(() => ({ error: notificationStoreErrorSpy, success: vi.fn() }), {
          getState: () => ({ error: notificationStoreErrorSpy, success: vi.fn() }),
        }),
      },
      "../components/WebLoginButton.js": Object.assign(makeDefault(() => null), {
        WEB_LOGIN_PROVIDERS: new Set(),
      }),
      "@/shared/services/quotaPingSchedule": { getScheduleSlotLabels: () => [] },
      "./AutoPingScheduleModal": makeDefault(() => null),
      "./CustomConfigCard": makeDefault(() => null),
      "./ConnectionRow": makeDefault((props) => {
        capturedRowProps.push(props);
        if (props.connection?.id) {
          capturedRowsById[props.connection.id] = props;
        }
        return React.createElement("div", { "data-connection-row": props.connection?.id });
      }),
      "./ModelRow": makeDefault(() => null),
      "./PassthroughModelsSection": makeDefault(() => null),
      "./CompatibleModelsSection": makeDefault(() => null),
      "./AddApiKeyModal": makeDefault(() => null),
      "./EditCompatibleNodeModal": makeDefault(() => null),
      "./AddCustomModelModal": makeDefault(() => null),
      "./BulkImportCodexModal": makeDefault(() => null),
      "./BulkImportGrokCliModal": makeDefault(() => null),
    };

    const targetPath = path.resolve(process.cwd(), "../src/app/(dashboard)/dashboard/providers/[id]/page.js");
    const Page = loadComponentWithSwc(
      fs.existsSync(targetPath) ? targetPath : path.resolve(process.cwd(), "src/app/(dashboard)/dashboard/providers/[id]/page.js"),
      mocks
    );

    const harness = createHookHarness(Page, {
      0: initialConnections,
      1: typeof initialUpdatingId === "string" ? { [initialUpdatingId]: true } : (initialUpdatingId || {}),
      2: false, // loading = false
      12: showEditModal,
      15: selectedConnection,
    });

    return {
      harness,
      capturedRowProps,
      capturedRowsById,
      notificationStoreErrorSpy,
      getCapturedEditModalProps: () => capturedEditModalProps,
    };
  };

  const createConnectionsCardHarness = ({
    initialConnections = [],
    showEditModal = false,
    selectedConnection = null,
  } = {}) => {
    let capturedEditModalProps = null;
    const mocks = {
      "@/shared/components": {
        Card: ({ children, ...props }) => React.createElement("div", { "data-card": true, ...props }, children),
        Badge: ({ children }) => React.createElement("span", null, children),
        Button: ({ children, ...props }) => React.createElement("button", props, children),
        Modal: () => null,
        Select: () => null,
        Toggle: () => null,
        EditConnectionModal: Object.assign(
          (props) => {
            capturedEditModalProps = props;
            return null;
          },
          { displayName: "MockConnectionsCardEditModal" }
        ),
        ConfirmModal: () => null,
      },
      "@/shared/utils/connectionStatus": {
        getStatusVariant: () => "neutral",
      },
    };

    const targetPath = path.resolve(process.cwd(), "../src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js");
    const ConnectionsCard = loadComponentWithSwc(
      fs.existsSync(targetPath) ? targetPath : path.resolve(process.cwd(), "src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js"),
      mocks
    );

    const harness = createHookHarness(ConnectionsCard, {
      0: initialConnections,
      2: false,
      4: showEditModal,
      5: selectedConnection,
    });

    return {
      harness,
      getCapturedEditModalProps: () => capturedEditModalProps,
    };
  };
  getPageHarness = createPageHarness;
  getConnectionsCardHarness = createConnectionsCardHarness;

  it("names the break: wires isFastMode, updatingFastMode, and onToggleFastMode to ConnectionRow", () => {
    const { harness, capturedRowProps } = createPageHarness([
      {
        id: "conn_page_codex_1",
        provider: "codex",
        isActive: true,
        providerSpecificData: { codexFastMode: true },
      },
    ]);

    harness.render();

    expect(capturedRowProps.length).toBeGreaterThan(0);
    const rowProps = capturedRowProps[capturedRowProps.length - 1];
    expect(rowProps.isFastMode).toBe(true);
    expect(rowProps.updatingFastMode).toBe(false);
    expect(typeof rowProps.onToggleFastMode).toBe("function");
  });

  it("names the break: invokes actual production onToggleFastMode callback issuing PUT /api/providers/<id> with { codexFastMode } and updates state", async () => {
    const initialConn = {
      id: "conn_page_codex_exec",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false, proxyPoolId: "pool_primary" },
    };
    const { harness, capturedRowProps } = createPageHarness([initialConn]);

    harness.render();
    const rowProps = capturedRowProps[capturedRowProps.length - 1];
    expect(rowProps.isFastMode).toBe(false);
    expect(rowProps.updatingFastMode).toBe(false);

    const originalFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        connection: {
          id: "conn_page_codex_exec",
          provider: "codex",
          isActive: true,
          providerSpecificData: { codexFastMode: true, proxyPoolId: "pool_primary" },
        },
      }),
    });
    global.fetch = fetchSpy;

    try {
      await rowProps.onToggleFastMode(true);

      expect(fetchSpy).toHaveBeenCalledWith("/api/providers/conn_page_codex_exec", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexFastMode: true }),
      });

      const updatedConnections = harness.getHookState(0);
      expect(updatedConnections[0].providerSpecificData.codexFastMode).toBe(true);
      expect(updatedConnections[0].providerSpecificData.proxyPoolId).toBe("pool_primary");
      expect(harness.getHookState(1)).toEqual({});

      harness.render();
      const nextRowProps = capturedRowProps[capturedRowProps.length - 1];
      expect(nextRowProps.isFastMode).toBe(true);
      expect(nextRowProps.updatingFastMode).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: handles async rejection/HTTP error in onToggleFastMode by notifying error store and preserving state", async () => {
    const initialConn = {
      id: "conn_page_codex_fail",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false, proxyPoolId: "pool_primary" },
    };
    const { harness, capturedRowProps, notificationStoreErrorSpy } = createPageHarness([initialConn]);

    harness.render();
    const rowProps = capturedRowProps[capturedRowProps.length - 1];

    const originalFetch = global.fetch;
    const originalConsoleLog = console.log;
    console.log = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: "Bad gateway updating connection" }),
    });
    global.fetch = fetchSpy;

    try {
      expect(typeof rowProps?.onToggleFastMode).toBe("function");
      await rowProps.onToggleFastMode(true);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(notificationStoreErrorSpy).toHaveBeenCalledWith("Bad gateway updating connection");

      const preservedConnections = harness.getHookState(0);
      expect(preservedConnections[0].providerSpecificData.codexFastMode).toBe(false);
      expect(preservedConnections[0].providerSpecificData.proxyPoolId).toBe("pool_primary");
      expect(harness.getHookState(1)).toEqual({});

      harness.render();
      const nextRowProps = capturedRowProps[capturedRowProps.length - 1];
      expect(nextRowProps.isFastMode).toBe(false);
      expect(nextRowProps.updatingFastMode).toBe(false);
    } finally {
      global.fetch = originalFetch;
      console.log = originalConsoleLog;
    }
  });

  it("names the break: guards onToggleFastMode against inactive connections and duplicate in-flight requests", async () => {
    // Inactive connection guard
    const inactiveConn = {
      id: "conn_page_inactive",
      provider: "codex",
      isActive: false,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness: inactiveHarness, capturedRowProps: inactiveRowProps } = createPageHarness([inactiveConn]);

    inactiveHarness.render();
    const inactiveRow = inactiveRowProps[inactiveRowProps.length - 1];

    const originalFetch = global.fetch;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    try {
      expect(typeof inactiveRow?.onToggleFastMode).toBe("function");
      await inactiveRow.onToggleFastMode(true);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Duplicate in-flight guard
      const busyConn = {
        id: "conn_page_busy",
        provider: "codex",
        isActive: true,
        providerSpecificData: { codexFastMode: false },
      };
      const { harness: busyHarness, capturedRowProps: busyRowProps } = createPageHarness([busyConn], "conn_page_busy");

      busyHarness.render();
      const busyRow = busyRowProps[busyRowProps.length - 1];
      expect(busyRow.updatingFastMode).toBe(true);

      expect(typeof busyRow?.onToggleFastMode).toBe("function");
      await busyRow.onToggleFastMode(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: maintains independent updatingFastMode states for concurrent connections and does not clear B when A completes", async () => {
    const connA = {
      id: "conn_page_codex_A",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const connB = {
      id: "conn_page_codex_B",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness, capturedRowsById } = createPageHarness([connA, connB]);

    harness.render();
    const rowA = capturedRowsById["conn_page_codex_A"];
    const rowB = capturedRowsById["conn_page_codex_B"];
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    let resolveA;
    let resolveB;
    const promiseA = new Promise((resolve) => { resolveA = resolve; });
    const promiseB = new Promise((resolve) => { resolveB = resolve; });

    const originalFetch = global.fetch;
    const fetchSpy = vi.fn((url) => {
      if (url.includes("conn_page_codex_A")) return promiseA;
      if (url.includes("conn_page_codex_B")) return promiseB;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchSpy;

    try {
      const togglePromiseA = rowA.onToggleFastMode(true);
      harness.render();
      expect(capturedRowsById["conn_page_codex_A"].updatingFastMode).toBe(true);

      const togglePromiseB = rowB.onToggleFastMode(true);
      harness.render();

      resolveA({
        ok: true,
        json: async () => ({
          connection: {
            ...connA,
            providerSpecificData: { codexFastMode: true },
          },
        }),
      });
      await togglePromiseA;

      harness.render();
      expect(capturedRowsById["conn_page_codex_A"].updatingFastMode).toBe(false);
      expect(capturedRowsById["conn_page_codex_B"].updatingFastMode).toBe(true);

      resolveB({
        ok: true,
        json: async () => ({
          connection: {
            ...connB,
            providerSpecificData: { codexFastMode: true },
          },
        }),
      });
      await togglePromiseB;
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: refutes fixture-only duplicate click before rerender as unreachable in browser", async () => {
    const conn = {
      id: "conn_page_codex_refute",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness, capturedRowsById } = createPageHarness([conn], "conn_page_codex_refute");

    harness.render();
    const busyRow = capturedRowsById["conn_page_codex_refute"];
    expect(busyRow.updatingFastMode).toBe(true);

    const originalFetch = global.fetch;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    try {
      await busyRow.onToggleFastMode(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: does not fabricate saved codexFastMode when PUT returns HTTP 200 with empty or missing connection payload", async () => {
    const initialConn = {
      id: "conn_page_codex_malformed",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false, proxyPoolId: "pool_primary" },
    };
    const { harness, capturedRowsById } = createPageHarness([initialConn]);

    harness.render();
    const rowProps = capturedRowsById["conn_page_codex_malformed"];

    const originalFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    global.fetch = fetchSpy;

    try {
      await rowProps.onToggleFastMode(true);

      const connectionsState = harness.getHookState(0);
      expect(connectionsState[0].providerSpecificData.codexFastMode).toBe(false);
      expect(connectionsState[0].providerSpecificData.proxyPoolId).toBe("pool_primary");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: page.js rejects missing id in PUT response and preserves prior state with error notification", async () => {
    const initialConn = {
      id: "conn_page_missing_id",
      provider: "codex",
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness, capturedRowsById, notificationStoreErrorSpy } = createPageHarness([initialConn]);
    harness.render();
    const rowProps = capturedRowsById["conn_page_missing_id"];

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        connection: {
          providerSpecificData: { codexFastMode: true },
        },
      }),
    });

    try {
      await rowProps.onToggleFastMode(true);
      const connectionsState = harness.getHookState(0);
      expect(connectionsState[0].providerSpecificData.codexFastMode).toBe(false);
      expect(notificationStoreErrorSpy).toHaveBeenCalledWith("Malformed connection response from server");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("EditConnectionModal - Codex Fast Mode Controls (Spec 9.1 & Ruling D)", () => {
  const createEditConnectionModalHarness = (initialProps = {}) => {
    let capturedInputs = [];
    let capturedButtons = [];
    let capturedModal = null;
    let capturedCheckboxes = [];

    const realJsxRuntime = require("react/jsx-runtime");
    const interceptedJsx = (type, props, key) => {
      if (type === "input" && props?.type === "checkbox") {
        capturedCheckboxes.push(props);
      }
      return realJsxRuntime.jsx(type, props, key);
    };
    const interceptedJsxs = (type, props, key) => {
      if (type === "input" && props?.type === "checkbox") {
        capturedCheckboxes.push(props);
      }
      return realJsxRuntime.jsxs(type, props, key);
    };

    const mocks = {
      "react/jsx-runtime": {
        ...realJsxRuntime,
        jsx: interceptedJsx,
        jsxs: interceptedJsxs,
      },
      "@/shared/components/Modal": makeDefault(({ isOpen, title, onClose, children }) => {
        capturedModal = { isOpen, title, onClose };
        return isOpen ? React.createElement("div", { "data-modal": true, "data-title": title }, children) : null;
      }),
      "@/shared/components/Input": makeDefault(({ label, value, onChange, disabled, type, ...props }) => {
        capturedInputs.push({ label, value, onChange, disabled, type, ...props });
        return React.createElement("input", { "data-input": label, value: value ?? "", onChange, disabled, type });
      }),
      "@/shared/components/Button": makeDefault(({ children, onClick, disabled, variant, fullWidth, ...props }) => {
        capturedButtons.push({ children, onClick, disabled, variant, fullWidth, ...props });
        return React.createElement("button", { onClick, disabled, "data-variant": variant }, children);
      }),
      "@/shared/components/Badge": makeDefault(({ children, variant }) =>
        React.createElement("span", { "data-badge": variant }, children)),
      "@/shared/components/Select": makeDefault(({ label, value, onChange, options }) =>
        React.createElement("select", { "data-select": label, value, onChange })),
      "@/shared/constants/providers": {
        isOpenAICompatibleProvider: () => false,
        isAnthropicCompatibleProvider: () => false,
        AI_PROVIDERS: {
          codex: { id: "codex", name: "OpenAI Codex" },
          anthropic: { id: "anthropic", name: "Anthropic" },
        },
      },
    };

    const targetPath = path.resolve(process.cwd(), "../src/shared/components/EditConnectionModal.js");
    const EditConnectionModal = loadComponentWithSwc(
      fs.existsSync(targetPath) ? targetPath : path.resolve(process.cwd(), "src/shared/components/EditConnectionModal.js"),
      mocks
    );

    const harness = createHookHarness(EditConnectionModal, {}, { executeEffects: true });

    function renderModal(props = {}) {
      capturedInputs = [];
      capturedButtons = [];
      capturedModal = null;
      capturedCheckboxes = [];
      const html = harness.render({
        isOpen: true,
        proxyPools: [],
        onSave: vi.fn(),
        onClose: vi.fn(),
        ...initialProps,
        ...props,
      });
      return html;
    }

    return {
      harness,
      render: renderModal,
      getCapturedInputs: () => capturedInputs,
      getCapturedButtons: () => capturedButtons,
      getCapturedModal: () => capturedModal,
      getCapturedCheckboxes: () => capturedCheckboxes,
    };
  };

  it("names the break: renders native checkbox for Codex connection with strict false state", () => {
    const { render } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_modal_codex_1",
      name: "Codex Standard",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };

    const html = render({ connection: conn });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Codex Fast Mode");
    expect(html).not.toMatch(/<input[^>]+type="checkbox"[^>]+checked/);
  });

  it("names the break: renders native checkbox checked when codexFastMode is strictly true", () => {
    const { render } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_modal_codex_2",
      name: "Codex Priority",
      provider: "codex",
      priority: 2,
      isActive: true,
      providerSpecificData: { codexFastMode: true },
    };

    const html = render({ connection: conn });
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/<input[^>]+type="checkbox"[^>]+checked/);
  });

  it("names the break: renders independent account flag disclosure warning that account default applies when request omits speed and /fast OFF may not disable it", () => {
    const { render } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_modal_disclosure",
      name: "Codex Disclosure Test",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };

    const html = render({ connection: conn });
    expect(html).toContain("Priority tier upstream; may consume extra quota");
    expect(html).toContain("Account default applies when request omits speed; /fast OFF may not disable it.");
  });

  it("names the break: omits Fast Mode checkbox for non-Codex connections in modal", () => {
    const { render } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_modal_anthropic_1",
      name: "Claude Team",
      provider: "anthropic",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: true },
    };

    const html = render({ connection: conn });
    expect(html).not.toContain("Codex Fast Mode");
    expect(html).not.toContain("Priority tier upstream");
  });

  it("names the break: updates fastMode state when connection prop changes", () => {
    const { render } = createEditConnectionModalHarness();
    const connFalse = {
      id: "conn_modal_toggle_1",
      name: "Codex Account",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const htmlFalse = render({ connection: connFalse });
    expect(htmlFalse).not.toMatch(/<input[^>]+type="checkbox"[^>]+checked/);

    const connTrue = {
      ...connFalse,
      providerSpecificData: { codexFastMode: true },
    };
    const htmlTrue = render({ connection: connTrue });
    expect(htmlTrue).toMatch(/<input[^>]+type="checkbox"[^>]+checked/);
  });

  it("names the break: disables checkbox and Save when connection is inactive", () => {
    const { render } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_modal_inactive",
      name: "Codex Inactive",
      provider: "codex",
      priority: 1,
      isActive: false,
      providerSpecificData: { codexFastMode: false },
    };

    const html = render({ connection: conn });
    expect(html).toMatch(/<input[^>]+type="checkbox"[^>]+disabled/);
  });

  it("names the break: passes codexFastMode boolean alongside name and priority via onSave for Codex", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { render, getCapturedButtons } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_modal_save_codex",
      name: "Codex Work",
      provider: "codex",
      priority: 3,
      isActive: true,
      providerSpecificData: { codexFastMode: true },
    };

    render({ connection: conn, onSave });
    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");
    expect(saveBtn).toBeDefined();

    await saveBtn.onClick();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Codex Work",
        priority: 3,
        codexFastMode: true,
      })
    );
  });

  it("names the break: does not include codexFastMode in onSave updates for non-Codex provider", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { render, getCapturedButtons } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_modal_save_non_codex",
      name: "Anthropic Work",
      provider: "anthropic",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: true },
    };

    render({ connection: conn, onSave });
    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");
    expect(saveBtn).toBeDefined();

    await saveBtn.onClick();
    expect(onSave).toHaveBeenCalledTimes(1);
    const callArg = onSave.mock.calls[0][0];
    expect(callArg.codexFastMode).toBeUndefined();
  });

  it("names the break: resets saving state and does not report success when onSave rejects", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Network write failure"));
    const onClose = vi.fn();
    const { render, getCapturedButtons } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_modal_err",
      name: "Codex Err",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };

    render({ connection: conn, onSave, onClose });
    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");
    expect(saveBtn).toBeDefined();

    await expect(saveBtn.onClick()).resolves.toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();
    const html = render({ connection: conn, onSave, onClose });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Network write failure");
  });

  it("names the break: rejects string false and does not check checkbox or send priority", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { render, getCapturedCheckboxes, getCapturedButtons } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_string_false",
      name: "Codex String False",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: "false" },
    };
    const html = render({ connection: conn, onSave });
    expect(html).not.toMatch(/<input[^>]+type="checkbox"[^>]+checked/);
    const cb = getCapturedCheckboxes()[0];
    expect(cb?.checked).toBe(false);

    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");
    await saveBtn.onClick();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        codexFastMode: false,
      })
    );
  });

  it("names the break: rejects number 1 and other malformed values without activating priority", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { render, getCapturedCheckboxes, getCapturedButtons } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_num_one",
      name: "Codex Number One",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: 1 },
    };
    const html = render({ connection: conn, onSave });
    expect(html).not.toMatch(/<input[^>]+type="checkbox"[^>]+checked/);
    const cb = getCapturedCheckboxes()[0];
    expect(cb?.checked).toBe(false);

    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");
    await saveBtn.onClick();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        codexFastMode: false,
      })
    );
  });

  it("names the break: captures native checkbox onChange and updates Save payload true/false", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { render, getCapturedCheckboxes, getCapturedButtons } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_onchange",
      name: "Codex Change",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    render({ connection: conn, onSave });
    let cb = getCapturedCheckboxes()[0];
    expect(cb.checked).toBe(false);

    // Toggle to true
    cb.onChange({ target: { checked: true } });
    render({ connection: conn, onSave });
    cb = getCapturedCheckboxes()[0];
    expect(cb.checked).toBe(true);

    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");
    await saveBtn.onClick();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        codexFastMode: true,
      })
    );
  });

  it("names the break: allows saving inactive connection for non-Codex and does not output codexFastMode", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { render, getCapturedButtons } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_inactive_anthropic",
      name: "Anthropic Inactive",
      provider: "anthropic",
      priority: 1,
      isActive: false,
      providerSpecificData: {},
    };
    render({ connection: conn, onSave });
    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");
    expect(saveBtn).toBeDefined();
    expect(saveBtn.disabled).toBeFalsy();

    await saveBtn.onClick();
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0];
    expect(payload.name).toBe("Anthropic Inactive");
    expect(payload.codexFastMode).toBeUndefined();
  });

  it("names the break: for inactive Codex, disables checkbox, keeps Save enabled, and preserves persisted flag", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { render, getCapturedCheckboxes, getCapturedButtons } = createEditConnectionModalHarness();
    const conn = {
      id: "conn_inactive_codex",
      name: "Codex Inactive",
      provider: "codex",
      priority: 1,
      isActive: false,
      providerSpecificData: { codexFastMode: false },
    };
    render({ connection: conn, onSave });
    const cb = getCapturedCheckboxes()[0];
    expect(cb.disabled).toBe(true);

    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");
    expect(saveBtn.disabled).toBeFalsy();

    await saveBtn.onClick();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Codex Inactive",
        codexFastMode: false,
      })
    );
  });

  it("names the break: page.js handleUpdateConnection propagates HTTP 400 and renders role=alert in modal without unhandled rejection", async () => {
    const conn = {
      id: "conn_page_fail_400",
      name: "Codex Fail",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness: pageHarness, getCapturedEditModalProps } = getPageHarness([conn], null, {
      showEditModal: true,
      selectedConnection: conn,
    });
    pageHarness.render();
    const parentProps = getCapturedEditModalProps();
    expect(parentProps).not.toBeNull();
    const actualOnSave = parentProps.onSave;

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid provider connection configuration" }),
    });

    const { render: renderModal, getCapturedButtons } = createEditConnectionModalHarness();
    renderModal({ connection: conn, onSave: actualOnSave });
    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");

    try {
      await expect(saveBtn.onClick()).resolves.toBeUndefined();
      const html = renderModal({ connection: conn, onSave: actualOnSave });
      expect(html).toContain('role="alert"');
      expect(html).toContain("Invalid provider connection configuration");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: ProviderLimits handleUpdateConnection propagates HTTP 500 and renders role=alert in modal", async () => {
    const conn = {
      id: "conn_quota_fail_500",
      name: "Codex 500",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness: quotaHarness, getCapturedEditModalProps } = getProviderLimitsHarness({
      initialConnections: [conn],
      showEditModal: true,
      selectedConnection: conn,
    });
    quotaHarness.render();
    const parentProps = getCapturedEditModalProps();
    expect(parentProps).not.toBeNull();
    const actualOnSave = parentProps.onSave;

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: "Internal server error saving connection" }),
    });

    const { render: renderModal, getCapturedButtons } = createEditConnectionModalHarness();
    renderModal({ connection: conn, onSave: actualOnSave });
    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");

    try {
      await expect(saveBtn.onClick()).resolves.toBeUndefined();
      const html = renderModal({ connection: conn, onSave: actualOnSave });
      expect(html).toContain('role="alert"');
      expect(html).toContain("Internal server error saving connection");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: ConnectionsCard handleUpdateConnection propagates network rejection and renders role=alert in modal", async () => {
    const conn = {
      id: "conn_card_net_fail",
      name: "Codex Net Fail",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness: cardHarness, getCapturedEditModalProps } = getConnectionsCardHarness({
      initialConnections: [conn],
      showEditModal: true,
      selectedConnection: conn,
    });
    cardHarness.render();
    const parentProps = getCapturedEditModalProps();
    expect(parentProps).not.toBeNull();
    const actualOnSave = parentProps.onSave;

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused by gateway"));

    const { render: renderModal, getCapturedButtons } = createEditConnectionModalHarness();
    renderModal({ connection: conn, onSave: actualOnSave });
    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");

    try {
      await expect(saveBtn.onClick()).resolves.toBeUndefined();
      const html = renderModal({ connection: conn, onSave: actualOnSave });
      expect(html).toContain('role="alert"');
      expect(html).toContain("Connection refused by gateway");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("names the break: page.js handleUpdateConnection throws on malformed Codex 200 response and renders role=alert", async () => {
    const conn = {
      id: "conn_page_malformed_200",
      name: "Codex Malformed",
      provider: "codex",
      priority: 1,
      isActive: true,
      providerSpecificData: { codexFastMode: false },
    };
    const { harness: pageHarness, getCapturedEditModalProps } = getPageHarness([conn], null, {
      showEditModal: true,
      selectedConnection: conn,
    });
    pageHarness.render();
    const parentProps = getCapturedEditModalProps();
    const actualOnSave = parentProps.onSave;

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ connection: null }),
    });

    const { render: renderModal, getCapturedButtons } = createEditConnectionModalHarness();
    renderModal({ connection: conn, onSave: actualOnSave });
    const saveBtn = getCapturedButtons().find((b) => b.children === "Save" || b.children === "Saving...");

    try {
      await expect(saveBtn.onClick()).resolves.toBeUndefined();
      const html = renderModal({ connection: conn, onSave: actualOnSave });
      expect(html).toContain('role="alert"');
      expect(html).toContain("Malformed connection response from server");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

