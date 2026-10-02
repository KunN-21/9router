import { describe, it, expect, beforeEach } from "vitest";

import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { hasValuableContent, parseSSELine, formatSSE } from "../../open-sse/utils/streamHelpers.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const encoder = new TextEncoder();

function sseResponse(chunks, { status = 200, contentType = "text/event-stream" } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

const D = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const E = (name, obj) => `event: ${name}\n` + D(obj);

const SECOND_MODEL_BODY = D({ choices: [{ delta: { content: "rescued by second model" } }] }) + "data: [DONE]\n\n";

function makeLog(store = []) {
  return {
    store,
    info(...a) { store.push(["info", ...a].join(" ")); },
    warn(...a) { store.push(["warn", ...a].join(" ")); },
    error(...a) { store.push(["error", ...a].join(" ")); },
    debug() {},
  };
}

async function runComboHelper({
  firstChunks,
  firstOpts = {},
  models = ["cx/gpt-6.1-sol(max)", "probe/second"],
  clientSource = FORMATS.OPENAI,
  signal = null,
}) {
  resetComboRotation();
  const warns = [];
  const log = makeLog(warns);
  const attempted = [];

  const response = await handleComboChat({
    body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
    models,
    handleSingleModel: async (_b, modelStr) => {
      attempted.push(modelStr);
      if (modelStr === "probe/second") return sseResponse([SECOND_MODEL_BODY]);
      return sseResponse(firstChunks, firstOpts);
    },
    log,
    comboName: "test-combo",
    comboStrategy: "fallback",
    signal,
  });

  const text = await response.text().catch((e) => `UNREADABLE: ${e.message}`);
  const emptyWarn = warns.find((w) => w.includes("returned an empty stream"));
  const streamErrorWarn = warns.find((w) => w.includes("failed with stream error") || w.includes("stream error"));

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  return {
    attempted,
    status: response.status,
    emptyStreamWarned: Boolean(emptyWarn),
    streamErrorWarned: Boolean(streamErrorWarn),
    warnLine: emptyWarn || streamErrorWarn || null,
    text,
    json,
  };
}

function walkTranslateHelper(rawChunks, sourceFormat = FORMATS.OPENAI, target = FORMATS.OPENAI_RESPONSES) {
  const state = initState(sourceFormat);
  const items = [];
  const emitted = [];

  for (const raw of rawChunks.flatMap((c) => c.split("\n"))) {
    const line = raw.trim();
    if (!line || line.startsWith("event:") || line.startsWith(":")) continue;
    const parsed = parseSSELine(line, target);
    if (!parsed) continue;
    const out = translateResponse(target, sourceFormat, parsed, state);
    for (const item of out || []) {
      if (item == null) continue;
      items.push(item);
      if (hasValuableContent(item, sourceFormat)) {
        emitted.push(formatSSE(item, sourceFormat));
      }
    }
  }

  const flush = translateResponse(target, sourceFormat, null, state);
  for (const item of flush || []) {
    if (item == null) continue;
    items.push(item);
    if (hasValuableContent(item, sourceFormat)) {
      emitted.push(formatSSE(item, sourceFormat));
    }
  }

  return { items, emitted, frameCount: emitted.length };
}

describe("Priority Fix: Codex GPT-6.1 Sol stream and error handling", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  describe("Defect 1: Combo preserves upstream error in HTTP 200 SSE", () => {
    it("preserves original error message and status when fallback is exhausted", async () => {
      const errorStream = [
        E("response.created", { type: "response.created", response: { id: "resp_err", status: "in_progress" } }),
        E("response.failed", {
          type: "response.failed",
          response: {
            status: "failed",
            error: { message: "The model cx/gpt-6.1-sol encountered an internal error", type: "server_error", code: "internal_error" },
          },
        }),
      ];

      const res = await runComboHelper({
        firstChunks: errorStream,
        models: ["cx/gpt-6.1-sol(max)"], // single model -> fallback exhausted immediately
      });

      expect(res.attempted).toEqual(["cx/gpt-6.1-sol(max)"]);
      expect(res.emptyStreamWarned).toBe(false);
      expect(res.json?.error?.message).toBe("The model cx/gpt-6.1-sol encountered an internal error");
      expect(res.json?.error?.message).not.toContain("empty stream");
      expect(res.status).toBeGreaterThanOrEqual(500);
    });

    it("preserves translated error object without converting to empty stream", async () => {
      const translatedErrorStream = [
        D({
          error: {
            message: "model overloaded",
            type: "server_error",
            code: "server_is_overloaded",
          },
        }),
      ];

      const res = await runComboHelper({
        firstChunks: translatedErrorStream,
        models: ["cx/gpt-6.1-sol(max)"],
      });

      expect(res.emptyStreamWarned).toBe(false);
      expect(res.json?.error?.message).toBe("model overloaded");
      expect(res.json?.error?.code).toBe("server_is_overloaded");
    });

    it("does not fallback on permanent client error (400) in stream", async () => {
      const clientErrorStream = [
        D({
          error: {
            message: "Unsupported parameter: reasoning_effort",
            type: "invalid_request_error",
            code: "invalid_parameter",
            status: 400,
          },
        }),
      ];

      const res = await runComboHelper({
        firstChunks: clientErrorStream,
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
      });

      // Permanent 400 must NOT fallback to probe/second
      expect(res.attempted).toEqual(["cx/gpt-6.1-sol(max)"]);
      expect(res.status).toBe(400);
      expect(res.json?.error?.message).toBe("Unsupported parameter: reasoning_effort");
    });

    it("falls back to second model on transient stream error", async () => {
      const transientErrorStream = [
        E("response.failed", {
          type: "response.failed",
          response: {
            status: "failed",
            error: { message: "Capacity exceeded", type: "server_error", code: "capacity" },
          },
        }),
      ];

      const res = await runComboHelper({
        firstChunks: transientErrorStream,
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
      });

      expect(res.attempted).toEqual(["cx/gpt-6.1-sol(max)", "probe/second"]);
      expect(res.emptyStreamWarned).toBe(false);
      expect(res.text).toContain("rescued by second model");
    });
  });

  describe("Defect 2: Responses translator recovers done-only text", () => {
    it("recovers text delivered only in response.output_text.done", () => {
      const chunks = [
        E("response.output_item.added", { type: "response.output_item.added", item: { id: "msg_1", type: "message" } }),
        E("response.output_text.done", { type: "response.output_text.done", item_id: "msg_1", text: "text only in done" }),
        E("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ id: "msg_1", type: "message" }] } }),
      ];

      const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
      const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].choices[0].delta.content).toBe("text only in done");
    });

    it("recovers text delivered only in response.output_item.done", () => {
      const chunks = [
        E("response.output_item.done", {
          type: "response.output_item.done",
          item: { id: "msg_2", type: "message", content: [{ type: "output_text", text: "text in item done" }] },
        }),
        E("response.completed", { type: "response.completed", response: { id: "resp_2", status: "completed", output: [] } }),
      ];

      const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
      const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].choices[0].delta.content).toBe("text in item done");
    });

    it("does not duplicate text when both output_text.done and output_item.done arrive", () => {
      const chunks = [
        E("response.output_item.added", { type: "response.output_item.added", item: { id: "msg_3", type: "message" } }),
        E("response.output_text.done", { type: "response.output_text.done", item_id: "msg_3", text: "same text" }),
        E("response.output_item.done", {
          type: "response.output_item.done",
          item: { id: "msg_3", type: "message", content: [{ type: "output_text", text: "same text" }] },
        }),
        E("response.completed", {
          type: "response.completed",
          response: {
            id: "resp_3",
            status: "completed",
            output: [{ id: "msg_3", type: "message", content: [{ type: "output_text", text: "same text" }] }],
          },
        }),
      ];

      const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
      const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].choices[0].delta.content).toBe("same text");
    });

    it("emits remaining text when partial deltas were sent", () => {
      const chunks = [
        E("response.output_item.added", { type: "response.output_item.added", item: { id: "msg_4", type: "message" } }),
        E("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_4", delta: "hello " }),
        E("response.output_text.done", { type: "response.output_text.done", item_id: "msg_4", text: "hello world" }),
        E("response.completed", { type: "response.completed", response: { id: "resp_4", status: "completed", output: [] } }),
      ];

      const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
      const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

      expect(textDeltas.length).toBe(2);
      expect(textDeltas[0].choices[0].delta.content).toBe("hello ");
      expect(textDeltas[1].choices[0].delta.content).toBe("world");
    });

    it("recovers text delivered only in response.completed output", () => {
      const chunks = [
        E("response.completed", {
          type: "response.completed",
          response: {
            id: "resp_5",
            status: "completed",
            output: [{ id: "msg_5", type: "message", content: [{ type: "output_text", text: "completed text" }] }],
          },
        }),
      ];

      const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
      const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].choices[0].delta.content).toBe("completed text");
    });

    it("preserves empty completion when output is empty and tokens are 0", () => {
      const chunks = [
        E("response.completed", {
          type: "response.completed",
          response: {
            id: "resp_empty",
            status: "completed",
            output: [],
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
      ];

      const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
      const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

      expect(textDeltas.length).toBe(0);
    });

    it("handles multi-item message blocks independently without cross-talk", () => {
      const chunks = [
        E("response.output_item.done", {
          type: "response.output_item.done",
          item: { id: "item_a", type: "message", content: [{ type: "output_text", text: "first item" }] },
        }),
        E("response.output_item.done", {
          type: "response.output_item.done",
          item: { id: "item_b", type: "message", content: [{ type: "output_text", text: "second item" }] },
        }),
        E("response.completed", { type: "response.completed", response: { id: "resp_multi", status: "completed", output: [] } }),
      ];

      const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
      const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

      expect(textDeltas.length).toBe(2);
      expect(textDeltas[0].choices[0].delta.content).toBe("first item");
      expect(textDeltas[1].choices[0].delta.content).toBe("second item");
    });

    describe("CODEX61-RESPONSES-MULTI-CONTENT-PART-SHADOWING: per-part tracking without shadowing", () => {
      it("emits all parts from output_item.done when item has multiple content parts without deltas", () => {
        const chunks = [
          E("response.output_item.done", {
            type: "response.output_item.done",
            item: {
              id: "msg_multi",
              type: "message",
              content: [
                { type: "output_text", text: "Alpha " },
                { type: "output_text", text: "Beta" },
              ],
            },
          }),
          E("response.completed", {
            type: "response.completed",
            response: { id: "resp_multi", status: "completed", output: [] },
          }),
        ];

        const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
        const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

        expect(textDeltas.map((it) => it.choices[0].delta.content)).toEqual(["Alpha ", "Beta"]);
      });

      it("emits all parts from response.completed when item has multiple content parts and done/delta missing", () => {
        const chunks = [
          E("response.completed", {
            type: "response.completed",
            response: {
              id: "resp_comp_multi",
              status: "completed",
              output: [
                {
                  id: "msg_comp",
                  type: "message",
                  content: [
                    { type: "output_text", text: "PartOne " },
                    { type: "output_text", text: "PartTwo" },
                  ],
                },
              ],
            },
          }),
        ];

        const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
        const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

        expect(textDeltas.map((it) => it.choices[0].delta.content)).toEqual(["PartOne ", "PartTwo"]);
      });

      it("emits remaining text across multiple parts with partial deltas without dropping or duplicating", () => {
        const chunks = [
          E("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "msg_parts", type: "message" },
          }),
          E("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: "msg_parts",
            content_index: 0,
            delta: "Part0-start ",
          }),
          E("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: "msg_parts",
            content_index: 1,
            delta: "Part1-start ",
          }),
          E("response.output_text.done", {
            type: "response.output_text.done",
            item_id: "msg_parts",
            content_index: 0,
            text: "Part0-start Part0-end",
          }),
          E("response.output_text.done", {
            type: "response.output_text.done",
            item_id: "msg_parts",
            content_index: 1,
            text: "Part1-start Part1-end",
          }),
          E("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "msg_parts",
              type: "message",
              content: [
                { type: "output_text", text: "Part0-start Part0-end" },
                { type: "output_text", text: "Part1-start Part1-end" },
              ],
            },
          }),
          E("response.completed", {
            type: "response.completed",
            response: {
              id: "resp_p",
              status: "completed",
              output: [
                {
                  id: "msg_parts",
                  type: "message",
                  content: [
                    { type: "output_text", text: "Part0-start Part0-end" },
                    { type: "output_text", text: "Part1-start Part1-end" },
                  ],
                },
              ],
            },
          }),
        ];

        const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
        const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

        expect(textDeltas.map((it) => it.choices[0].delta.content)).toEqual([
          "Part0-start ",
          "Part1-start ",
          "Part0-end",
          "Part1-end",
        ]);
      });

      it("handles multiple content parts with identical text without shadowing", () => {
        const chunks = [
          E("response.output_item.done", {
            type: "response.output_item.done",
            item: {
              id: "msg_dup",
              type: "message",
              content: [
                { type: "output_text", text: "echo " },
                { type: "output_text", text: "echo " },
              ],
            },
          }),
          E("response.completed", {
            type: "response.completed",
            response: { id: "resp_dup", status: "completed", output: [] },
          }),
        ];

        const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
        const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

        expect(textDeltas.map((it) => it.choices[0].delta.content)).toEqual(["echo ", "echo "]);
      });

      it("handles multiple content parts with shared prefix text without shadowing", () => {
        const chunks = [
          E("response.output_item.done", {
            type: "response.output_item.done",
            item: {
              id: "msg_prefix",
              type: "message",
              content: [
                { type: "output_text", text: "prefix" },
                { type: "output_text", text: "prefix more" },
              ],
            },
          }),
          E("response.completed", {
            type: "response.completed",
            response: { id: "resp_prefix", status: "completed", output: [] },
          }),
        ];

        const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
        const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

        expect(textDeltas.map((it) => it.choices[0].delta.content)).toEqual(["prefix", "prefix more"]);
      });

      it("resolves output_index and item_id aliases across multi-item events without cross-talk", () => {
        const chunks = [
          E("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "item_0", type: "message" },
          }),
          E("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 1,
            item: { id: "item_1", type: "message" },
          }),
          E("response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: "item0 delta ",
          }),
          E("response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: 1,
            content_index: 0,
            delta: "item1 delta ",
          }),
          E("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "item_0",
              type: "message",
              content: [{ type: "output_text", text: "item0 delta item0 done" }],
            },
          }),
          E("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              id: "item_1",
              type: "message",
              content: [{ type: "output_text", text: "item1 delta item1 done" }],
            },
          }),
          E("response.completed", {
            type: "response.completed",
            response: { id: "resp_order", status: "completed", output: [] },
          }),
        ];

        const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
        const textDeltas = items.filter((it) => it.choices?.[0]?.delta?.content);

        expect(textDeltas.map((it) => it.choices[0].delta.content)).toEqual([
          "item0 delta ",
          "item1 delta ",
          "item0 done",
          "item1 done",
        ]);
      });
    });
  });

  describe("Defect 3: Native Responses passthrough in combo", () => {
    it("recognizes output_item.done text as content without output tokens in usage", async () => {
      const nativeDoneStream = [
        E("response.output_item.done", {
          type: "response.output_item.done",
          item: { id: "msg_n1", type: "message", content: [{ type: "output_text", text: "native text" }] },
        }),
        E("response.completed", {
          type: "response.completed",
          response: { id: "resp_n1", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 0 } },
        }),
      ];

      const res = await runComboHelper({
        firstChunks: nativeDoneStream,
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
        clientSource: FORMATS.OPENAI_RESPONSES,
      });

      expect(res.attempted).toEqual(["cx/gpt-6.1-sol(max)"]);
      expect(res.emptyStreamWarned).toBe(false);
      expect(res.status).toBe(200);
    });

    it("triggers empty stream fallback when native completed has output: [] and output_tokens: 0", async () => {
      const nativeEmptyStream = [
        E("response.created", { type: "response.created", response: { id: "resp_n2", status: "in_progress" } }),
        E("response.completed", {
          type: "response.completed",
          response: { id: "resp_n2", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 0 } },
        }),
      ];

      const res = await runComboHelper({
        firstChunks: nativeEmptyStream,
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
        clientSource: FORMATS.OPENAI_RESPONSES,
      });

      expect(res.attempted).toEqual(["cx/gpt-6.1-sol(max)", "probe/second"]);
      expect(res.emptyStreamWarned).toBe(true);
      expect(res.text).toContain("rescued by second model");
    });
  });

  describe("Controls & Local Invariants", () => {
    it("treats reasoning deltas as valid content without empty stream warning", async () => {
      const reasoningStream = [
        E("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "thinking deeply" }),
        E("response.completed", {
          type: "response.completed",
          response: { id: "resp_r", status: "completed", output: [] },
        }),
      ];

      const res = await runComboHelper({
        firstChunks: reasoningStream,
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
      });

      expect(res.attempted).toEqual(["cx/gpt-6.1-sol(max)"]);
      expect(res.emptyStreamWarned).toBe(false);
    });

    it("survives heartbeat comments and detects delayed reasoning", async () => {
      const delayedStream = [
        ": ping\n\n",
        ": keepalive\n\n",
        E("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "delayed start" }),
        E("response.completed", { type: "response.completed", response: { id: "resp_d", status: "completed" } }),
      ];

      const res = await runComboHelper({
        firstChunks: delayedStream,
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
      });

      expect(res.attempted).toEqual(["cx/gpt-6.1-sol(max)"]);
      expect(res.emptyStreamWarned).toBe(false);
    });

    it("returns HTTP 499 and does not fallback when client aborts", async () => {
      const abortController = new AbortController();
      setTimeout(() => abortController.abort(new Error("client disconnect")), 50);

      const hangingStream = new ReadableStream({ start() {} });
      const res = await handleComboChat({
        body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
        handleSingleModel: async () => new Response(hangingStream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
        log: makeLog(),
        comboName: "test-abort",
        comboStrategy: "fallback",
        signal: abortController.signal,
      });

      expect(res.status).toBe(499);
    });

    it("survives split TCP chunks across packet boundaries", async () => {
      const part1 = encoder.encode('data: {"choices":[{"delta":{"content":"split-');
      const part2 = encoder.encode('chunk"}}]}\n\n');

      const splitStream = new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(part1);
            c.enqueue(part2);
            c.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );

      const attempted = [];
      const res = await handleComboChat({
        body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
        handleSingleModel: async (_b, m) => {
          attempted.push(m);
          return splitStream;
        },
        log: makeLog(),
        comboName: "test-split",
        comboStrategy: "fallback",
      });

      const text = await res.text();
      expect(attempted).toEqual(["cx/gpt-6.1-sol(max)"]);
      expect(text).toContain("split-chunk");
    });

    it("CodexExecutor preserves model cx/gpt-6.1-sol and effort max", () => {
      const executor = new CodexExecutor();
      const body = { model: "gpt-6.1-sol", reasoning: { effort: "max", summary: "auto" } };
      executor.transformRequest("gpt-6.1-sol", body, true, { apiKey: "test-token" });
      expect(body.model).toBe("gpt-6.1-sol");
      expect(body.reasoning.effort).toBe("max");
    });

    it("does not fallback or emit success terminal when stream errors after initial content committed", async () => {
      const lateErrorStream = [
        E("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: "msg_late",
          delta: "initial content committed",
        }),
        E("response.failed", {
          type: "response.failed",
          response: {
            status: "failed",
            error: { message: "Late upstream crash", type: "server_error", code: "late_error" },
          },
        }),
      ];

      const res = await runComboHelper({
        firstChunks: lateErrorStream,
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
      });

      expect(res.attempted).toEqual(["cx/gpt-6.1-sol(max)"]);
      expect(res.text).toContain("initial content committed");
      expect(res.text).not.toContain("rescued by second model");
      expect(res.text).not.toContain('"finish_reason":"stop"');
    });

    it("does not fallback when stream is truncated after content committed", async () => {
      const truncatedStream = [
        E("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: "msg_trunc",
          delta: "started content",
        }),
      ];

      const res = await runComboHelper({
        firstChunks: truncatedStream,
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
      });

      expect(res.attempted).toEqual(["cx/gpt-6.1-sol(max)"]);
      expect(res.text).toContain("started content");
      expect(res.text).not.toContain("rescued by second model");
    });

    it("aborts cleanly with 499 without falling back to second model on client cancellation", async () => {
      const abortController = new AbortController();
      abortController.abort(new Error("client canceled"));

      const res = await runComboHelper({
        firstChunks: [": keepalive\n\n"],
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
        signal: abortController.signal,
      });

      expect(res.status).toBe(499);
      expect(res.attempted).toEqual([]);
    });

    it("survives multi-byte UTF-8 character split across packet boundaries", async () => {
      const fullPayload = 'data: {"choices":[{"delta":{"content":"Xin chào thế giới 🚀"}}]}\n\n';
      const fullBytes = encoder.encode(fullPayload);
      const rocketIdx = fullPayload.indexOf("🚀");
      const byteIdxOfRocket = encoder.encode(fullPayload.slice(0, rocketIdx)).length;
      const splitPoint = byteIdxOfRocket + 2;

      const part1 = fullBytes.slice(0, splitPoint);
      const part2 = fullBytes.slice(splitPoint);

      const splitStream = new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(part1);
            c.enqueue(part2);
            c.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );

      const attempted = [];
      const res = await handleComboChat({
        body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["cx/gpt-6.1-sol(max)", "probe/second"],
        handleSingleModel: async (_b, m) => {
          attempted.push(m);
          return splitStream;
        },
        log: makeLog(),
        comboName: "test-utf8-split",
        comboStrategy: "fallback",
      });

      const text = await res.text();
      expect(attempted).toEqual(["cx/gpt-6.1-sol(max)"]);
      expect(text).toContain("Xin chào thế giới 🚀");
    });

    it("handles done-only native tool call arguments in Responses API", () => {
      const chunks = [
        E("response.output_item.added", {
          type: "response.output_item.added",
          item: { id: "fc_1", type: "function_call", name: "get_weather", call_id: "call_123" },
        }),
        E("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          arguments: '{"location":"Hanoi"}',
        }),
        E("response.output_item.done", {
          type: "response.output_item.done",
          item: { id: "fc_1", type: "function_call", name: "get_weather", call_id: "call_123", arguments: '{"location":"Hanoi"}' },
        }),
        E("response.completed", {
          type: "response.completed",
          response: { id: "resp_tools", status: "completed", output: [] },
        }),
      ];

      const { items } = walkTranslateHelper(chunks, FORMATS.OPENAI);
      const toolCallChunks = items.filter((it) => it.choices?.[0]?.delta?.tool_calls);

      expect(toolCallChunks.length).toBeGreaterThanOrEqual(1);
      const args = toolCallChunks.map((tc) => tc.choices[0].delta.tool_calls[0].function?.arguments || "").join("");
      expect(args).toBe('{"location":"Hanoi"}');
    });

    it("CodexExecutor handles Sol and Luna with Lite headers", () => {
      const executor = new CodexExecutor();
      const credentials = { connectionId: "test", accessToken: "token-123" };
      const headersSol = executor.buildHeaders(credentials, true, null, "gpt-6.1-sol");
      const headersLuna = executor.buildHeaders(credentials, true, null, "gpt-6.1-luna");

      expect(headersSol).toBeDefined();
      expect(headersLuna).toBeDefined();
    });
  });
});
