import { describe, it, expect, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("OpenCode combo fallback policy", () => {
  it("checkFallbackError classifies HTTP 403 RegionError as fallbackable and not permanent", () => {
    const errorText = JSON.stringify({
      error: {
        type: "permission_error",
        code: "region_restricted",
        message: "RegionError: Models hosted in China require workspace consent.",
      },
    });

    const fallbackDecision = checkFallbackError(403, errorText);
    expect(fallbackDecision.shouldFallback).toBe(true);
    expect(fallbackDecision.cooldownMs).toBeGreaterThan(0);
  });

  it("multi-provider combo proceeds to next model when model 1 encounters HTTP 403 RegionError", async () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = [
      "opencode/muse-spark-1.2-contributor-free",
      "mock/second-model",
    ];

    const regionErrorResponse = Response.json(
      {
        error: {
          type: "permission_error",
          code: "region_restricted",
          message: "RegionError: Models hosted in China require workspace consent.",
        },
      },
      { status: 403 }
    );

    const successResponse = Response.json(
      { choices: [{ message: { content: "Success from second model" } }] },
      { status: 200 }
    );

    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(regionErrorResponse)
      .mockResolvedValueOnce(successResponse);

    const result = await handleComboChat({
      body,
      models,
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "opencode-region-fallback",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls[0][1]).toBe("opencode/muse-spark-1.2-contributor-free");
    expect(handleSingleModel.mock.calls[1][1]).toBe("mock/second-model");
    expect(result).toBe(successResponse);
    expect(result.status).toBe(200);
  });
});
