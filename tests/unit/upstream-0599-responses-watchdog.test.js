import { describe, it, expect, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";

const encoder = new TextEncoder();

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

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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
      const reader = output.getReader();
      const decoder = new TextDecoder();

      source.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "stall-1",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      })}\n\n`));

      await vi.advanceTimersByTimeAsync(20);
      // At this point, completion is deferred waiting for usage
      // Advance by 3000ms watchdog
      await vi.advanceTimersByTimeAsync(3000);
      source.close();

      let text = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();

      const events = parseEvents(text);
      const completed = events.filter((e) => e.event === "response.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].data.response.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });
});
