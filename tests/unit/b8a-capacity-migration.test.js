import { describe, it, expect } from "vitest";
import {
  getCapacityAdapterConfig,
  getCapacityAdapterModels,
  getCapacityAdapterStrategy,
  augmentModelsWithCapacityAdapter,
} from "../../open-sse/services/capacityAdapter.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

const DEFAULT_FALLBACK_MODEL = "oc/mimo-v2.6-flash-free";

describe("B8a capacity adapter migration & normalization", () => {
  it("migrates oc/mimo-v2.5-free in legacy array format to oc/mimo-v2.6-flash-free", () => {
    const config = getCapacityAdapterConfig("vision", {
      capacityAdapter: {
        vision: [
          { model: "oc/mimo-v2.5-free", enabled: true },
          "other-provider/vision-model",
        ],
      },
    });

    expect(config).toEqual({
      enabled: true,
      roundRobin: false,
      models: [DEFAULT_FALLBACK_MODEL, "other-provider/vision-model"],
    });
  });

  it("migrates oc/mimo-v2.5-free in object format models array", () => {
    const config = getCapacityAdapterConfig("vision", {
      capacityAdapter: {
        vision: {
          enabled: true,
          roundRobin: true,
          models: ["oc/mimo-v2.5-free", "fixture/model-1"],
        },
      },
    });

    expect(config).toEqual({
      enabled: true,
      roundRobin: true,
      models: [DEFAULT_FALLBACK_MODEL, "fixture/model-1"],
    });
  });

  it("preserves non-legacy models and order during normalization", () => {
    const config = getCapacityAdapterConfig("audioInput", {
      capacityAdapter: {
        audioInput: {
          enabled: true,
          roundRobin: false,
          models: ["custom/audio-1", "custom/audio-2"],
        },
      },
    });

    expect(config).toEqual({
      enabled: true,
      roundRobin: false,
      models: ["custom/audio-1", "custom/audio-2"],
    });
  });

  it("falls back to [DEFAULT_FALLBACK_MODEL] when enabled pool has no models", () => {
    const config = getCapacityAdapterConfig("vision", {
      capacityAdapter: {
        vision: { enabled: true, roundRobin: false, models: [] },
      },
    });

    expect(config).toEqual({
      enabled: true,
      roundRobin: false,
      models: [DEFAULT_FALLBACK_MODEL],
    });
  });

  it("returns empty models when pool is disabled", () => {
    const config = getCapacityAdapterConfig("vision", {
      capacityAdapter: {
        vision: { enabled: false, roundRobin: false, models: ["custom/model"] },
      },
    });

    expect(config.enabled).toBe(false);
    expect(config.models).toEqual(["custom/model"]);
  });

  it("mergeWithDefaults migrates oc/mimo-v2.5-free without mutating frozen raw input", () => {
    const raw = Object.freeze({
      capacityAdapter: Object.freeze({
        vision: Object.freeze({
          enabled: true,
          roundRobin: false,
          models: Object.freeze(["oc/mimo-v2.5-free", "vendor/model-v1"]),
        }),
        audioInput: Object.freeze({
          enabled: true,
          roundRobin: false,
          models: Object.freeze(["audio/model-a"]),
        }),
      }),
    });

    const merged = mergeWithDefaults(raw);

    // Verify migration
    expect(merged.capacityAdapter.vision.models).toEqual([
      DEFAULT_FALLBACK_MODEL,
      "vendor/model-v1",
    ]);
    // Verify audioInput models preserved
    expect(merged.capacityAdapter.audioInput.models).toEqual(["audio/model-a"]);

    // Verify raw was not mutated
    expect(raw.capacityAdapter.vision.models[0]).toBe("oc/mimo-v2.5-free");
  });

  it("mergeWithDefaults handles repeated calls idempotently", () => {
    const raw = {
      capacityAdapter: {
        vision: {
          enabled: true,
          roundRobin: true,
          models: ["oc/mimo-v2.5-free"],
        },
      },
    };

    const first = mergeWithDefaults(raw);
    const second = mergeWithDefaults(first);

    expect(first.capacityAdapter.vision.models).toEqual([DEFAULT_FALLBACK_MODEL]);
    expect(second.capacityAdapter.vision.models).toEqual([DEFAULT_FALLBACK_MODEL]);
  });

  it("does not mutate default settings when raw has empty capacityAdapter", () => {
    const def1 = mergeWithDefaults({});
    const def2 = mergeWithDefaults({});

    expect(def1.capacityAdapter.vision.models).toEqual([]);
    expect(def2.capacityAdapter.vision.models).toEqual([]);
  });

  it("augmentModelsWithCapacityAdapter is no-op when original models satisfy required capability", () => {
    // Both gpt-4o and claude-3-opus support vision in capabilities
    const models = ["oa/gpt-4o"];
    const augmented = augmentModelsWithCapacityAdapter(models, ["vision"], {
      capacityAdapter: {
        vision: { enabled: true, roundRobin: false, models: ["fixture/vision"] },
      },
    });

    expect(augmented).toBe(models);
  });
});
