import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const encoder = new TextEncoder();
const reasoningCases = [
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.reasoning.delta",
].flatMap((type) => {
  const event = { type, item_id: "rs_fixture", content_index: 0, delta: "active reasoning" };
  return [
    { name: `${type} with event field`, text: `event: ${type}\ndata: ${JSON.stringify(event)}\n\n` },
    { name: `${type} with compact data only`, text: `data: ${JSON.stringify(event)}\n\n` },
    { name: `${type} with spaced data only`, text: `data: ${JSON.stringify(event).replaceAll(":", ": ")}\n\n` },
  ];
});

function openResponse(text = "") {
  let input;
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      input = controller;
      if (text) controller.enqueue(encoder.encode(text));
    },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    input,
    isCancelled: () => cancelled,
  };
}

async function dispose(fixture, peek) {
  if (peek?.replacementBody && !peek.replacementBody.locked) await peek.replacementBody.cancel();
  else if (!fixture.response.body.locked) await fixture.response.body.cancel();
}

describe("Codex SSE peek progress", () => {
  it.each(reasoningCases)("replays $name without timing out", async ({ text }) => {
    const fixture = openResponse(text);
    let peek;
    try {
      const pending = new CodexExecutor()._peekSseTransientError(fixture.response, { timeoutMs: 70 });
      await vi.advanceTimersByTimeAsync(100);
      peek = await pending;
      expect(peek.matched).toBeNull();
      expect(peek.timedOut ?? false).toBe(false);
      expect(fixture.isCancelled()).toBe(false);
      expect(peek.replacementBody).not.toBeNull();
      fixture.input.close();
      await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await dispose(fixture, peek);
    }
  });

  it("still cancels a silent stream at the existing deadline", async () => {
    const fixture = openResponse();
    let peek;
    try {
      const pending = new CodexExecutor()._peekSseTransientError(fixture.response, { timeoutMs: 70 });
      await vi.advanceTimersByTimeAsync(100);
      peek = await pending;
      expect(peek).toMatchObject({ matched: "peek_timeout", timedOut: true, replacementBody: null });
      expect(fixture.isCancelled()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await dispose(fixture, peek);
    }
  });

  it("still classifies a structured capacity error", async () => {
    const fixture = openResponse('event: error\ndata: {"error":{"message":"Selected model is at capacity. Please try a different model."}}\n\n');
    let peek;
    try {
      peek = await new CodexExecutor()._peekSseTransientError(fixture.response, { timeoutMs: 70 });
      expect(peek).toMatchObject({ accountFallback: true, replacementBody: null });
      expect(peek.matched).not.toBeNull();
      expect(fixture.isCancelled()).toBe(true);
    } finally {
      await dispose(fixture, peek);
    }
  });
});
