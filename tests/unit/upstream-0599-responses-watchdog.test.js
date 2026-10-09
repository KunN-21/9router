import { describe, it, expect, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";

const encoder = new TextEncoder();

function readAllChunks(output) {
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      // Stream error / abort / cancel
    }
    return text;
  })();
  return { reader, done, getText: () => text };
}

async function runTransform(lines) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n")));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "test", null, null, "test-model"),
  );

  const { done } = readAllChunks(output);
  return done;
}

function parseEvents(text) {
  return text
    .split("\n\n")
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (!event || !data || data === "[DONE]") return null;
      return { event, data: JSON.parse(data) };
    })
    .filter(Boolean);
}

const sse = (data) => [`data: ${JSON.stringify(data)}`, ""];

describe("Codex Responses usage deferral and 3s watchdog (7111db359, fbcaa2828)", () => {
  it("defers response.completed on finish_reason until usage trailer arrives", () => {
    const state = {
      ...initState(FORMATS.OPENAI_RESPONSES),
      targetFormat: FORMATS.OPENAI,
    };

    // Step 1: finish chunk without usage
    const finishChunk = {
      id: "c1",
      choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }],
    };
    const events1 = openaiToOpenAIResponsesResponse(finishChunk, state);
    expect(events1.some((e) => e.event === "response.completed")).toBe(false);
    expect(state.completionPending).toBe(true);

    // Step 2: usage trailer with choices: []
    const trailerChunk = {
      id: "c1",
      choices: [],
      usage: { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190 },
    };
    const events2 = openaiToOpenAIResponsesResponse(trailerChunk, state);
    const completedEvent = events2.find((e) => e.event === "response.completed");
    expect(completedEvent).toBeDefined();
    expect(completedEvent.data.response.usage).toMatchObject({
      input_tokens: 150,
      output_tokens: 40,
      total_tokens: 190,
    });
  });

  it("ignores zeroed placeholder usage and waits for real usage trailer", async () => {
    const placeholder = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const text = await runTransform([
      ...sse({ id: "c2", object: "chat.completion.chunk", usage: placeholder, choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] }),
      ...sse({ id: "c2", object: "chat.completion.chunk", usage: placeholder, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ...sse({ id: "c2", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 } }),
      "data: [DONE]",
      "",
    ]);

    const events = parseEvents(text);
    const completed = events.filter((e) => e.event === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].data.response.usage).toEqual({ input_tokens: 300, output_tokens: 20, total_tokens: 320 });
  });

  it("watchdog flushes deferred completion when stream stalls for 3s", async () => {
    vi.useFakeTimers();
    try {
      let source;
      const input = new ReadableStream({ start(c) { source = c; } });
      const output = input.pipeThrough(
        createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "test", null, null, "test-model"),
      );
      const { done } = readAllChunks(output);

      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "stall-1",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      })}\n\n`));

      await vi.advanceTimersByTimeAsync(20);
      // At this point, completion is deferred waiting for usage
      // Advance by 3000ms watchdog
      await vi.advanceTimersByTimeAsync(3000);
      source.close();

      const text = await done;
      const events = parseEvents(text);
      const completed = events.filter((e) => e.event === "response.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].data.response.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finish -> error -> advance 3s emits only failure and no response.completed", async () => {
    vi.useFakeTimers();
    try {
      let source;
      const input = new ReadableStream({ start(c) { source = c; } });
      const output = input.pipeThrough(
        createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "test", null, null, "test-model"),
      );
      const { done } = readAllChunks(output);

      // Chunk 1: finish without usage -> timer 3s started
      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "err-1",
        choices: [{ index: 0, delta: { content: "part" }, finish_reason: "stop" }],
      })}\n\n`));
      await vi.advanceTimersByTimeAsync(20);

      // Chunk 2: error chunk arrives before 3s
      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "err-1",
        error: { message: "rate limit exceeded", type: "insufficient_quota", code: "rate_limit_exceeded" },
      })}\n\n`));
      await vi.advanceTimersByTimeAsync(20);

      // Advance by full 3000ms watchdog
      await vi.advanceTimersByTimeAsync(3000);
      source.close();

      const text = await done;
      const events = parseEvents(text);
      const failed = events.filter((e) => e.event === "response.failed");
      const completed = events.filter((e) => e.event === "response.completed");
      expect(failed).toHaveLength(1);
      expect(completed).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks late text and tool chunks arriving after completion", async () => {
    vi.useFakeTimers();
    try {
      let source;
      const input = new ReadableStream({ start(c) { source = c; } });
      const output = input.pipeThrough(
        createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "test", null, null, "test-model"),
      );
      const { done } = readAllChunks(output);

      // Step 1: finish without usage -> watchdog triggers completion after 3s
      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "late-1",
        choices: [{ index: 0, delta: { content: "initial" }, finish_reason: "stop" }],
      })}\n\n`));
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(3000);

      // Step 2: upstream sends late text chunk and late tool call chunk
      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "late-1",
        choices: [{ index: 0, delta: { content: " late leak text" } }],
      })}\n\n`));
      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "late-1",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_late", function: { name: "tool", arguments: "{}" } }] } }],
      })}\n\n`));
      await vi.advanceTimersByTimeAsync(20);
      source.close();

      const text = await done;
      const events = parseEvents(text);
      const completedIdx = events.findIndex((e) => e.event === "response.completed");
      expect(completedIdx).toBeGreaterThanOrEqual(0);
      // No events allowed after response.completed
      const eventsAfterCompleted = events.slice(completedIdx + 1);
      expect(eventsAfterCompleted).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears watchdog timer immediately when valid usage and DONE arrive before 3s", async () => {
    vi.useFakeTimers();
    try {
      let source;
      const input = new ReadableStream({ start(c) { source = c; } });
      const output = input.pipeThrough(
        createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "test", null, null, "test-model"),
      );
      const { done } = readAllChunks(output);

      // Step 1: finish without usage
      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "early-usage",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
      })}\n\n`));
      await vi.advanceTimersByTimeAsync(20);
      expect(vi.getTimerCount()).toBe(1);

      // Step 2: valid usage trailer arrives before 3s
      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "early-usage",
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      })}\n\n`));
      await vi.advanceTimersByTimeAsync(20);

      // Step 3: [DONE] arrives
      source.enqueue(encoder.encode("data: [DONE]\n\n"));
      await vi.advanceTimersByTimeAsync(20);
      source.close();

      // Timer must be cleared immediately without waiting for 3s
      expect(vi.getTimerCount()).toBe(0);

      const text = await done;
      const events = parseEvents(text);
      const completed = events.filter((e) => e.event === "response.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].data.response.usage).toEqual({ input_tokens: 120, output_tokens: 30, total_tokens: 150 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit synthetic success when aborted or closed before watchdog fires", async () => {
    vi.useFakeTimers();
    try {
      let source;
      let onCompleteCalled = false;
      const input = new ReadableStream({ start(c) { source = c; } });
      const output = input.pipeThrough(
        createSSETransformStreamWithLogger(
          FORMATS.OPENAI,
          FORMATS.OPENAI_RESPONSES,
          "test",
          null,
          null,
          "test-model",
          null,
          null,
          () => { onCompleteCalled = true; }
        ),
      );
      const { reader } = readAllChunks(output);

      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "abort-1",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      })}\n\n`));
      await vi.advanceTimersByTimeAsync(20);

      // Client cancels / aborts reader
      await reader.cancel("aborted");

      // Advance watchdog by 3s
      await vi.advanceTimersByTimeAsync(3000);
      try { source.close(); } catch { /* source might already be closed */ }

      // Must not record synthetic success on aborted stream
      expect(onCompleteCalled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
