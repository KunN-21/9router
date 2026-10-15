import { describe, expect, it, vi } from "vitest";
import { hasValidUsage, mergeUsage, extractUsage, canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const { createSSEStream } = await import("../../open-sse/utils/stream.js");

const est = (p, c) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c, estimated: true });

describe("usage-estimate-vs-real: real usage must beat the body-size estimate", () => {
  it("cache-only body with input_tokens 0 is valid usage", () => {
    expect(hasValidUsage({ input_tokens: 0, cache_read_input_tokens: 12000 })).toBe(true);
    expect(hasValidUsage({ prompt_tokens: 0, cached_tokens: 4096 })).toBe(true);
    expect(hasValidUsage({ input_tokens: 0, output_tokens: 0 })).toBe(false);
  });

  it("real trailer replaces the body-size estimate; a later estimate is blocked", () => {
    const real = { prompt_tokens: 120, completion_tokens: 45, cache_read_input_tokens: 900 };
    const m = mergeUsage(est(2500, 3), real);
    expect(m).toMatchObject(real);
    expect(m.estimated).toBeUndefined();
    expect(mergeUsage(real, est(2500, 999999))).toEqual(real);
  });

  it("cache-only real input beats an estimate when input_tokens is 0", () => {
    const m = mergeUsage(est(2500, 3), { input_tokens: 0, output_tokens: 12, cache_read_input_tokens: 8000 });
    expect(m).toMatchObject({ input_tokens: 0, cache_read_input_tokens: 8000 });
    expect(m.estimated).toBeUndefined();
  });

  it("cache-only nested cached_tokens trailer beats an estimate", () => {
    const trailer = { prompt_tokens: 0, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4096 } };
    expect(hasValidUsage(trailer)).toBe(true);
    const m = mergeUsage(est(2500, 3), trailer);
    expect(m).toMatchObject(trailer);
    expect(m.estimated).toBeUndefined();
  });

  it("Anthropic input/output split keeps prior input; wire stays cache-exclusive", () => {
    const start = extractUsage({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } } });
    const m = mergeUsage(start, extractUsage({ type: "message_delta", usage: { output_tokens: 50 } }));
    expect(m).toMatchObject({ prompt_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, completion_tokens: 50 });
    expect(m.total_tokens).toBeUndefined();
    // message_delta only carries output_tokens; max-merge must not zero out input/cache of message_start.
    expect(m.prompt_tokens).toBe(100);
    expect(canonicalizeUsage(m).prompt_tokens).toBe(330);
    expect(canonicalizeUsage(m)).toMatchObject({ cached_tokens: 200, cache_creation_input_tokens: 30, completion_tokens: 50 });
  });

  it("shallow-merges nested details and ignores non-finite numbers", () => {
    const m = mergeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } },
      { completion_tokens: 40, prompt_tokens: NaN, completion_tokens_details: { reasoning_tokens: 12 } });
    expect(m).toMatchObject({ prompt_tokens: 100, completion_tokens: 40 });
    expect(m.prompt_tokens_details).toEqual({ cached_tokens: 80 });
    expect(mergeUsage(m, { completion_tokens_details: { audio_tokens: 3 } }).completion_tokens_details)
      .toEqual({ reasoning_tokens: 12, audio_tokens: 3 });
  });

  it("real usage trailer wins over the finish-chunk estimate in the passthrough lane", async () => {
    const onStreamComplete = vi.fn();
    const enc = new TextEncoder();
    const frames = [
      'data: {"id":"c1","object":"chat.completion","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"c1","object":"chat.completion","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"c1","object":"chat.completion","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45,"total_tokens":165,"prompt_tokens_details":{"cached_tokens":90}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = new ReadableStream({
      start(c) { for (const s of frames) c.enqueue(enc.encode(s)); c.close(); },
    });
    const reader = upstream.pipeThrough(createSSEStream({
      mode: "passthrough", provider: "openai", model: "gpt-4o",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(2000) }] }, onStreamComplete,
    })).getReader();
    while (!(await reader.read()).done) { /* drain */ }
    const usage = onStreamComplete.mock.calls[0][1];
    expect(usage.prompt_tokens).toBe(120);
    expect(usage.estimated).toBeUndefined();
  });
});
