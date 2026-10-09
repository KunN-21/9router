import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { extractUsageFromResponse } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { extractUsage } from "../../open-sse/utils/usageTracking.js";
import { matchPattern } from "../../open-sse/providers/pricing.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let pricingRepo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pricing-task2-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  pricingRepo = await import("@/lib/db/repos/pricingRepo.js");
});

afterAll(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Usage and pricing selective upstream fixes", () => {
  describe("Ollama cached token accounting (466272490)", () => {
    it("extractUsageFromResponse parses Ollama top-level prompt_eval_cached_count", () => {
      const response = {
        model: "llama3",
        done: true,
        prompt_eval_count: 500,
        eval_count: 100,
        prompt_eval_cached_count: 350,
      };
      const usage = extractUsageFromResponse(response);
      expect(usage).toEqual({
        prompt_tokens: 500,
        completion_tokens: 100,
        total_tokens: 600,
        cached_tokens: 350,
      });
    });

    it("usageTracking extractUsage extracts Ollama cached_tokens", () => {
      const chunk = {
        model: "llama3",
        done: true,
        prompt_eval_count: 1200,
        eval_count: 400,
        prompt_eval_cached_count: 800,
      };
      const usage = extractUsage(chunk);
      expect(usage).toBeDefined();
      expect(usage.cached_tokens).toBe(800);
      expect(usage.prompt_tokens).toBe(1200);
    });
  });

  describe("Effort-annotated pricing fallback (PR 4635)", () => {
    it("prices annotated codex model at base model rate when no exact override exists", async () => {
      const base = await pricingRepo.getPricingForModel("codex", "gpt-6.1-sol");
      const annotated = await pricingRepo.getPricingForModel("codex", "gpt-6.1-sol(xhigh)");
      expect(base).not.toBeNull();
      expect(annotated).toEqual(base);
    });

    it("preserves exact user override on annotated id over base override", async () => {
      const baseOverride = { input: 8.88, output: 88.88 };
      const exactOverride = { input: 1.11, output: 11.11 };
      await pricingRepo.updatePricing({
        codex: { "gpt-6-sol": baseOverride, "gpt-6-sol(max)": exactOverride },
      });
      expect(await pricingRepo.getPricingForModel("codex", "gpt-6-sol(max)")).toEqual(exactOverride);
    });
  });

  describe("Pricing pattern regex cache (PR 4628)", () => {
    it("caches compiled pattern regexes on matchPattern._cache", () => {
      matchPattern("*warmup-task2*", "test-model");
      expect(matchPattern._cache).toBeInstanceOf(Map);
      expect(matchPattern._cache.has("*warmup-task2*")).toBe(true);
    });
  });

  describe("DefaultExecutor stream_options.include_usage injection (PR 4633)", () => {
    const PROVIDER = "openai-compatible-chat-test-task2";

    it("injects include_usage for streaming chat requests", () => {
      const ex = new DefaultExecutor(PROVIDER);
      const body = { model: "kimi/kimi-k3", messages: [{ role: "user", content: "hi" }] };
      const out = ex.transformRequest("kimi/kimi-k3", body, true, { providerSpecificData: { apiType: "chat" } });
      expect(out.stream_options).toEqual({ include_usage: true });
    });

    it("does not inject for non-streaming requests", () => {
      const ex = new DefaultExecutor(PROVIDER);
      const body = { model: "kimi/kimi-k3", messages: [{ role: "user", content: "hi" }] };
      const out = ex.transformRequest("kimi/kimi-k3", body, false, null);
      expect(out.stream_options).toBeUndefined();
    });
  });
});
