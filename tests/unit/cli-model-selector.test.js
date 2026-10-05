import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it, beforeEach, afterEach } from "vitest";

const require = createRequire(import.meta.url);
const api = require("../../cli/src/cli/api/client");
const modelSelector = require("../../cli/src/cli/utils/modelSelector");

describe("cli/src/cli/utils/modelSelector", () => {
  let origGetAvailableModels;
  let origGetProviders;

  beforeEach(() => {
    origGetAvailableModels = api.getAvailableModels;
    origGetProviders = api.getProviders;
  });

  afterEach(() => {
    api.getAvailableModels = origGetAvailableModels;
    api.getProviders = origGetProviders;
  });

  it("includes oc in PROVIDER_ALIAS_ORDER and PROVIDER_ALIAS_NAMES", () => {
    assert.ok(modelSelector.PROVIDER_ALIAS_ORDER.includes("oc"), "PROVIDER_ALIAS_ORDER should include 'oc'");
    assert.strictEqual(modelSelector.PROVIDER_ALIAS_NAMES.oc, "OpenCode Free");
    assert.strictEqual(modelSelector.PROVIDER_ALIAS_NAMES.opencode, "OpenCode Free");
  });

  it("filters out inactive providers and keeps active connections", async () => {
    api.getAvailableModels = async () => ({
      success: true,
      data: {
        data: [
          { id: "gpt-4o", owned_by: "openai" },
          { id: "claude-3-7-sonnet", owned_by: "claude" },
          { id: "gemini-2.5-pro", owned_by: "gemini" },
        ],
      },
    });

    api.getProviders = async () => ({
      success: true,
      data: {
        connections: [
          { provider: "claude", isActive: true },
          { provider: "gemini", isActive: false },
        ],
      },
    });

    const result = await modelSelector.getAvailableModelsGrouped();
    assert.deepStrictEqual(result.combos, []);
    assert.ok(result.groups.claude, "active provider claude should be included");
    assert.deepStrictEqual(result.groups.claude, ["claude-3-7-sonnet"]);
    assert.strictEqual(result.groups.gemini, undefined, "inactive provider gemini should be filtered out");
    assert.strictEqual(result.groups.openai, undefined, "unconnected provider openai should be filtered out");
  });

  it("always includes NO_AUTH_PROVIDERS (opencode, oc) even when unconnected", async () => {
    api.getAvailableModels = async () => ({
      success: true,
      data: {
        data: [
          { id: "oc-free-mini", owned_by: "opencode" },
          { id: "oc-fast", owned_by: "oc" },
          { id: "gpt-4", owned_by: "openai" },
        ],
      },
    });

    api.getProviders = async () => ({
      success: true,
      data: {
        connections: [],
      },
    });

    const result = await modelSelector.getAvailableModelsGrouped();
    assert.ok(result.groups.opencode, "noAuth provider opencode should be included");
    assert.ok(result.groups.oc, "noAuth provider oc should be included");
    assert.strictEqual(result.groups.openai, undefined, "unconnected non-free provider should be excluded");
  });

  it("always preserves combo models", async () => {
    api.getAvailableModels = async () => ({
      success: true,
      data: {
        data: [
          { id: "combo-1", owned_by: "combo" },
          { id: "combo-2", owned_by: "combo" },
        ],
      },
    });

    api.getProviders = async () => ({
      success: true,
      data: {
        connections: [],
      },
    });

    const result = await modelSelector.getAvailableModelsGrouped();
    assert.deepStrictEqual(result.combos, ["combo-1", "combo-2"]);
    assert.deepStrictEqual(result.groups, {});
  });

  it("resolves dynamic prefixes and PROVIDER_ID_TO_ALIAS mappings", async () => {
    api.getAvailableModels = async () => ({
      success: true,
      data: {
        data: [
          { id: "codex-preview", owned_by: "cx" },
          { id: "custom-prefix-model", owned_by: "my-prefix" },
        ],
      },
    });

    api.getProviders = async () => ({
      success: true,
      data: {
        connections: [
          { provider: "codex", isActive: true },
          { provider: "custom-p", providerSpecificData: { prefix: "my-prefix" }, isActive: true },
        ],
      },
    });

    const result = await modelSelector.getAvailableModelsGrouped();
    assert.ok(result.groups.cx, "codex alias cx should be mapped");
    assert.ok(result.groups["my-prefix"], "custom prefix should be mapped");
  });

  it("returns empty structure when getAvailableModels fails", async () => {
    api.getAvailableModels = async () => ({ success: false });
    api.getProviders = async () => ({ success: true, data: { connections: [] } });

    const result = await modelSelector.getAvailableModelsGrouped();
    assert.deepStrictEqual(result, { combos: [], groups: {} });
  });
});
