import { describe, expect, it } from "vitest";
import {
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  parseQuotaData,
  trimHiddenQuotaKeys,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("provider quota visibility", () => {
  const data = {
    quotas: {
      "gemini-pro-agent": {
        displayName: "Gemini 3.1 Pro (High)",
        used: 200,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 80,
      },
      "claude-opus-4-6-thinking": {
        displayName: "Claude Opus 4.6 (Thinking)",
        used: 100,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 90,
      },
    },
  };

  it("hides per-model mirror rows; only native summary windows render", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(quotas).toEqual([]);
  });

  it("shows all quotas by default and hides configured provider rows", () => {
    const windowed = {
      quotas: {
        ...data.quotas,
        gemini_5h: { displayName: "Gemini (5h)", used: 100, total: 1000, resetAt: "2026-07-04T05:00:00Z", remainingPercentage: 90 },
        gemini_weekly: { displayName: "Gemini Weekly", used: 200, total: 1000, resetAt: "2026-07-11T00:00:00Z", remainingPercentage: 80 },
      },
    };
    const quotas = parseQuotaData("antigravity", windowed);
    expect(quotas.map((q) => q.modelKey)).toEqual(["gemini_5h", "gemini_weekly"]);

    const visibility = {
      antigravity: { hidden: ["gemini_weekly"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini_5h"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["gemini_weekly"]);
  });

  it("trims stale or obsolete model keys", () => {
    const windowed = {
      quotas: {
        ...data.quotas,
        gemini_5h: { displayName: "Gemini (5h)", used: 100, total: 1000, resetAt: "2026-07-04T05:00:00Z", remainingPercentage: 90 },
      },
    };
    const quotas = parseQuotaData("antigravity", windowed);
    const trimmed = trimHiddenQuotaKeys(["gemini_5h", "stale-model-xyz", "gemini-3.8-flash-low"], quotas);
    expect(trimmed).toEqual(["gemini_5h"]);

    const visibility = {
      antigravity: { hidden: ["gemini_5h", "stale-model-xyz"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible).toEqual([]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["gemini_5h"]);
  });

  it("does not apply one provider hidden list to another provider", () => {
    const windowed = {
      quotas: {
        ...data.quotas,
        gemini_5h: { displayName: "Gemini (5h)", used: 100, total: 1000, resetAt: "2026-07-04T05:00:00Z", remainingPercentage: 90 },
      },
    };
    const quotas = parseQuotaData("antigravity", windowed);
    const visibility = {
      codex: { hidden: ["gemini_5h"] },
    };
    expect(filterQuotasByVisibility("antigravity", quotas, visibility)).toHaveLength(1);
  });
});
