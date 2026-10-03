import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

// The translator registry imports request-side executors and signature storage.
// Neither boundary belongs to this synthetic response/transport test.
vi.mock("../../open-sse/executors/antigravity.js", () => ({
  AntigravityExecutor: class {},
}));
vi.mock("../../open-sse/services/thoughtSignatureStore.js", () => ({
  storeGeminiThoughtSignature: vi.fn(),
  getGeminiThoughtSignature: vi.fn(async () => null),
  getGeminiThoughtSignatureSync: vi.fn(() => null),
  signatureFamily: vi.fn(() => null),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateResponse } = await import("../../open-sse/translator/index.js");
const { responsesToClaudeResponse } = await import(
  "../../open-sse/translator/response/responses-to-claude.js"
);
const { CLAUDE_TOOL_PROGRESS_PING_INTERVAL_MS, HTTP_STATUS } = await import(
  "../../open-sse/config/runtimeConfig.js"
);
const { SSE_PING_EVENT } = await import("../../open-sse/utils/sseConstants.js");
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { createStreamController, pipeWithDisconnect } = await import(
  "../../open-sse/utils/streamHandler.js"
);
const { buildStreamErrorBytes } = await import("../../open-sse/utils/streamHelpers.js");
const { handleForcedSSEToJson } = await import(
  "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
);
// A comparison run materializes BASE inside the synthetic evidence directory;
// the shared product files stay intact. Normal gates exercise current source.
const progressComparisonTranslator = process.env.CODEX_PROGRESS_BASE_MODULE
  ? (await import(/* @vite-ignore */ process.env.CODEX_PROGRESS_BASE_MODULE)).responsesToClaudeResponse
  : responsesToClaudeResponse;

const PING_MS = 15 * 1000;

function newClaudeState() {
  return {
    messageStartSent: false,
    messageId: null,
    model: "gpt-6.1-sol",
    nextBlockIndex: 0,
    toolCalls: new Map(),
    toolArgBuffers: new Map(),
    toolIndexByKey: new Map(),
    thinkingBlockStarted: false,
    thinkingBlockIndex: null,
    textBlockStarted: false,
    textBlockIndex: null,
    textBlockClosed: false,
    finishReasonSent: false,
    errorSent: false,
    usage: null,
  };
}

const TOOL_ADDED = {
  type: "response.output_item.added",
  output_index: 0,
  item: {
    id: "fc_prog_1",
    type: "function_call",
    call_id: "call_prog_1",
    name: "Read",
    arguments: "",
  },
};

function deltaEvent(text, key = "fc_prog_1") {
  return { type: "response.function_call_arguments.delta", item_id: key, delta: text };
}

function drive(state, event) {
  return responsesToClaudeResponse(event, state);
}

describe("tool progress ping constants", () => {
  it("fixed 15s interval and ping discriminator exist", () => {
    expect(CLAUDE_TOOL_PROGRESS_PING_INTERVAL_MS).toBe(PING_MS);
    expect(SSE_PING_EVENT).toBe("ping");
  });
});

describe("buffered tool progress emits throttled ping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    try {
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("post-fix BASE comparison: known buffered progress emits a heartbeat", () => {
    const state = newClaudeState();
    progressComparisonTranslator(TOOL_ADDED, state);
    const out = progressComparisonTranslator(deltaEvent('{"file_path":"/partial'), state);
    expect((out || []).filter((e) => e.type === "ping")).toEqual([{ type: "ping" }]);
  });

  it("first nonempty delta pings immediately even at timestamp 0", () => {
    const state = newClaudeState();
    drive(state, TOOL_ADDED);
    const out = drive(state, deltaEvent('{"file_path":"/a'));
    const pings = (out || []).filter((e) => e.type === SSE_PING_EVENT);
    expect(pings).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delta before interval does not ping but still buffers", () => {
    const state = newClaudeState();
    drive(state, TOOL_ADDED);
    drive(state, deltaEvent('{"file_path":"/a'));
    vi.setSystemTime(10 * 1000);
    const out = drive(state, deltaEvent('.txt"'));
    expect((out || []).filter((e) => e.type === SSE_PING_EVENT)).toHaveLength(0);
    expect(state.toolArgBuffers.get(0)).toBe('{"file_path":"/a.txt"');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delta at interval boundary pings exactly once", () => {
    const state = newClaudeState();
    drive(state, TOOL_ADDED);
    drive(state, deltaEvent('{"file_path":"/a'));
    vi.setSystemTime(PING_MS);
    const out = drive(state, deltaEvent('.txt"'));
    expect((out || []).filter((e) => e.type === SSE_PING_EVENT)).toHaveLength(1);
  });

  it("cadence is per request: parallel tools share one throttle", () => {
    const state = newClaudeState();
    drive(state, TOOL_ADDED);
    drive(state, {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "fc_prog_2", type: "function_call", call_id: "call_prog_2", name: "Read", arguments: "" },
    });
    const first = drive(state, deltaEvent('{"a":', "fc_prog_1"));
    expect((first || []).filter((e) => e.type === SSE_PING_EVENT)).toHaveLength(1);
    vi.setSystemTime(5 * 1000);
    const second = drive(state, deltaEvent('{"b":', "fc_prog_2"));
    expect((second || []).filter((e) => e.type === SSE_PING_EVENT)).toHaveLength(0);
    vi.setSystemTime(PING_MS);
    const third = drive(state, deltaEvent("1}", "fc_prog_2"));
    expect((third || []).filter((e) => e.type === SSE_PING_EVENT)).toHaveLength(1);
  });

  it("separate request states ping independently", () => {
    const a = newClaudeState();
    const b = newClaudeState();
    drive(a, TOOL_ADDED);
    drive(b, TOOL_ADDED);
    expect(((drive(a, deltaEvent("x")) || []).filter((e) => e.type === SSE_PING_EVENT))).toHaveLength(1);
    expect(((drive(b, deltaEvent("y")) || []).filter((e) => e.type === SSE_PING_EVENT))).toHaveLength(1);
  });

  it.each(["", undefined, null, 7, { ignored: true }, ["ignored"], false])(
    "non-string or empty delta %j cannot ping or consume cadence",
    (delta) => {
      const state = newClaudeState();
      drive(state, TOOL_ADDED);
      expect(drive(state, deltaEvent(delta)) || []).toEqual([]);
      expect(state.lastToolProgressPingAt).toBeUndefined();
      expect(drive(state, deltaEvent("valid progress"))).toEqual([{ type: "ping" }]);
    }
  );

  it("unknown keys and closed tools emit no ping", () => {
    const state = newClaudeState();
    drive(state, TOOL_ADDED);
    expect(drive(state, deltaEvent("zzz", "no_such_key")) || []).toEqual([]);
    expect(drive(state, { type: "response.function_call_arguments.delta", item_id: "fc_prog_1", delta: "" }) || []).toEqual([]);
    expect(drive(state, { type: "response.function_call_arguments.delta", item_id: "fc_prog_1" }) || []).toEqual([]);
    drive(state, {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "fc_prog_1", call_id: "call_prog_1", type: "function_call", name: "Read" },
    });
    const late = drive(state, deltaEvent("late"));
    expect((late || []).filter((e) => e.type === SSE_PING_EVENT)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no ping after terminal finish or error", () => {
    const state = newClaudeState();
    drive(state, TOOL_ADDED);
    drive(state, {
      type: "response.completed",
      response: { id: "resp_t", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const out = drive(state, deltaEvent("late"));
    expect((out || []).filter((e) => e.type === SSE_PING_EVENT)).toHaveLength(0);

    const errState = newClaudeState();
    drive(errState, TOOL_ADDED);
    drive(errState, { type: "error", error: { message: "boom", type: "api_error" } });
    const out2 = drive(errState, deltaEvent("late"));
    expect((out2 || []).filter((e) => e.type === SSE_PING_EVENT)).toHaveLength(0);
  });

  it("done still emits sanitized args exactly once with ids/names preserved", () => {
    const state = newClaudeState();
    state.toolNameMap = new Map([["read", "Read"]]);
    const added = drive(state, { ...TOOL_ADDED, item: { ...TOOL_ADDED.item, name: "read" } });
    expect(added.find((e) => e.type === "content_block_start").content_block).toEqual({
      type: "tool_use", id: "call_prog_1", name: "Read", input: {},
    });
    drive(state, deltaEvent('{"path":"/tmp/x.js","offset":-3,"limit":"5000","pages":"2"'));
    vi.setSystemTime(60 * 1000);
    drive(state, deltaEvent("}"));
    const done = drive(state, {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "fc_prog_1", call_id: "call_prog_1", type: "function_call", name: "Read" },
    });
    const argDeltas = (done || []).filter(
      (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
    );
    expect(argDeltas).toHaveLength(1);
    expect(JSON.parse(argDeltas[0].delta.partial_json)).toEqual({
      path: "/tmp/x.js", file_path: "/tmp/x.js", offset: 0, limit: 2000,
    });
    expect((done || []).filter((e) => e.type === SSE_PING_EVENT)).toHaveLength(0);
    const stop = (done || []).find((e) => e.type === "content_block_stop");
    expect(stop).toEqual({ type: "content_block_stop", index: 0 });
    expect(state.toolCalls.get(0)).toMatchObject({
      id: "fc_prog_1", call_id: "call_prog_1", name: "Read", closed: true,
    });
    expect(drive(state, {
      type: "response.function_call_arguments.done", item_id: "fc_prog_1", arguments: "{}",
    }) || []).toEqual([]);
    expect(drive(state, {
      type: "response.output_item.done", output_index: 0, item: TOOL_ADDED.item,
    }) || []).toEqual([]);
  });

  it("raw unsanitized partial never emitted as input_json_delta before done", () => {
    const state = newClaudeState();
    drive(state, TOOL_ADDED);
    const out = drive(state, deltaEvent('{"path":"/tmp/partial'));
    const argDeltas = (out || []).filter(
      (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
    );
    expect(argDeltas).toHaveLength(0);
  });
});

describe("non-Claude clients never ping", () => {
  it("same-format OpenAI and Responses passthrough carry no ping", () => {
    const chunk = { choices: [{ index: 0, delta: { content: "hi" } }] };
    const openai = translateResponse(FORMATS.OPENAI, FORMATS.OPENAI, chunk, {});
    expect(openai.flat().some((e) => e?.type === SSE_PING_EVENT)).toBe(false);
    const resp = translateResponse(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      { type: "response.output_text.delta", delta: "hi" },
      {}
    );
    expect(resp.flat().some((e) => e?.type === SSE_PING_EVENT)).toBe(false);
  });
});

describe("continuous-reader pipeline and actual termination paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    try {
      // Check before restoring real timers: do not hide leaks with clearAllTimers.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  const enc = new TextEncoder();
  const sseFrame = (event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n";
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_pipe", status: "completed",
      usage: { input_tokens: 10, output_tokens: 50 },
    },
  };

  function splitFrames(text) {
    return text.split("\n\n").filter((f) => f.trim()).map((raw) => {
      const lines = raw.split("\n");
      const payload = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() || null;
      // Parsing failures are test failures; [DONE] is the sole non-JSON payload.
      return { event, data: payload === "[DONE]" ? "[DONE]" : JSON.parse(payload), raw };
    });
  }

  function runPipeline(sourceFormat = FORMATS.CLAUDE) {
    const timerBaseline = vi.getTimerCount();
    const reqLogger = { appendProviderChunk: vi.fn() };
    const onStreamComplete = vi.fn();
    const onError = vi.fn();
    const onDisconnect = vi.fn();
    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES, sourceFormat, "codex", reqLogger, null,
      "gpt-6.1-sol", "conn-ping", null, onStreamComplete
    );
    const controller = createStreamController({
      provider: "codex", model: "gpt-6.1-sol", onError, onDisconnect,
      log: { line: vi.fn(), errorLine: vi.fn() },
    });
    let upstreamController;
    let upstreamState = "open";
    const upstreamCancelled = vi.fn();
    const upstream = new ReadableStream({
      start(c) { upstreamController = c; },
      cancel(reason) {
        upstreamState = "cancelled";
        upstreamCancelled(reason);
      },
    });
    const downstream = pipeWithDisconnect(
      new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      transform, controller,
      (message) => buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, message, sourceFormat),
      360 * 1000, sourceFormat === FORMATS.CLAUDE ? 240 * 1000 : null
    );
    const reader = downstream.getReader();
    const received = [];
    let readerDone = false;
    const drain = (async () => {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        received.push(result.value);
      }
      readerDone = true;
    })();
    // Observe rejections immediately and assert the outcome at every termination.
    // A failed reader is never silently converted into a successful drain.
    const drainOutcome = drain.then(
      () => ({ status: "fulfilled" }),
      (reason) => ({ status: "rejected", reason })
    );
    const text = () => new TextDecoder().decode(
      Buffer.concat(received.map((c) => Buffer.from(c)))
    );
    const settle = () => vi.advanceTimersByTimeAsync(0);
    const finishDrain = async () => {
      const outcome = await drainOutcome;
      expect(outcome).toEqual({ status: "fulfilled" });
      expect(readerDone).toBe(true);
      await settle();
    };
    return {
      controller, reqLogger, onStreamComplete, onError, onDisconnect,
      upstreamCancelled, timerBaseline, text,
      frames: () => splitFrames(text()),
      isReaderDone: () => readerDone,
      upstreamState: () => upstreamState,
      async push(event) {
        expect(upstreamState).toBe("open");
        const raw = sseFrame(event);
        upstreamController.enqueue(enc.encode(raw));
        await settle();
        // Confirm upstream ingestion, including events producing no output.
        expect(reqLogger.appendProviderChunk).toHaveBeenLastCalledWith(raw);
      },
      async close() {
        expect(upstreamState).toBe("open");
        upstreamState = "eof";
        upstreamController.close();
        await finishDrain();
      },
      async error(error) {
        expect(upstreamState).toBe("open");
        upstreamState = "errored";
        upstreamController.error(error);
        await finishDrain();
      },
      async cancel() {
        await reader.cancel("synthetic client cancel");
        await finishDrain();
      },
      finishDrain,
      async dispose() {
        // Tests explicitly terminate after their assertions. This fallback owns
        // cleanup if an assertion fails, and reports every cleanup failure.
        if (!readerDone && controller.isConnected()) {
          await reader.cancel("test cleanup");
        }
        await vi.advanceTimersByTimeAsync(500); // existing disconnect abort grace
        await finishDrain();
        expect(vi.getTimerCount()).toBe(timerBaseline);
        expect(upstreamState).not.toBe("open");
        reader.releaseLock();
      },
    };
  }

  it("gpt-6.1-sol pings keep buffered progress alive past 300s and preserve sanitized tool identity", async () => {
    const pipeline = runPipeline();
    const fragments = [
      '{"path":"/tmp/x.js","offset":-3,"limit":"5000","pages":"2","pad":"',
      ...Array.from({ length: 30 }, () => "x".repeat(40)),
      '"}',
    ];
    const fullArgs = fragments.join("");
    expect(() => JSON.parse(fullArgs)).not.toThrow();
    try {
      await pipeline.push(TOOL_ADDED);
      for (const fragment of fragments) {
        await pipeline.push(deltaEvent(fragment));
        await vi.advanceTimersByTimeAsync(10 * 1000);
      }
      expect(Date.now()).toBe(320 * 1000);
      expect(pipeline.controller.isConnected()).toBe(true);
      expect(pipeline.controller.signal.aborted).toBe(false);
      expect(pipeline.isReaderDone()).toBe(false);
      expect(pipeline.onError).not.toHaveBeenCalled();
      const activeFrames = pipeline.frames();
      expect(activeFrames.filter((f) => f.event === "ping")).toHaveLength(16);
      expect(activeFrames.filter((f) => f.data?.type === "content_block_delta")).toHaveLength(0);
      expect(activeFrames.filter((f) => f.event === "error")).toHaveLength(0);
      expect(activeFrames[0].event).toBe("message_start");
      expect(activeFrames[0].data.message.model).toBe("gpt-6.1-sol");
      expect(activeFrames[1].data.content_block).toEqual({
        type: "tool_use", id: "call_prog_1", name: "Read", input: {},
      });
      expect(activeFrames[2]).toMatchObject({ event: "ping", data: { type: "ping" } });

      await pipeline.push({
        type: "response.function_call_arguments.done", item_id: "fc_prog_1", arguments: fullArgs,
      });
      const afterDone = pipeline.text();
      await pipeline.push({
        type: "response.function_call_arguments.done", item_id: "fc_prog_1", arguments: fullArgs,
      });
      await pipeline.push({ type: "response.output_item.done", output_index: 0, item: TOOL_ADDED.item });
      expect(pipeline.text()).toBe(afterDone);

      await pipeline.push(completed);
      const afterCompleted = pipeline.text();
      await pipeline.push(completed);
      await pipeline.push(deltaEvent("late"));
      expect(pipeline.text()).toBe(afterCompleted);
      // completed is a protocol terminal; actual EOF closes the transport.
      expect(pipeline.isReaderDone()).toBe(false);
      await pipeline.close();
      expect(pipeline.text()).toBe(afterCompleted);
      const finalFrames = pipeline.frames();
      const args = finalFrames.filter((f) => f.data?.delta?.type === "input_json_delta");
      expect(args).toHaveLength(1);
      expect(JSON.parse(args[0].data.delta.partial_json)).toEqual({
        path: "/tmp/x.js", file_path: "/tmp/x.js", offset: 0, limit: 2000, pad: "x".repeat(1200),
      });
      expect(args[0].data.index).toBe(0);
      expect(finalFrames.filter((f) => f.event === "content_block_stop")).toHaveLength(1);
      expect(finalFrames.filter((f) => f.event === "message_stop")).toHaveLength(1);
      expect(finalFrames.filter((f) => f.event === "message_delta")).toHaveLength(1);
      expect(finalFrames.find((f) => f.event === "message_delta").data).toMatchObject({
        delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 50 },
      });
      expect(finalFrames.at(-1).event).toBe("message_stop");
      expect(pipeline.onStreamComplete).toHaveBeenCalledTimes(1);
      expect(pipeline.onError).not.toHaveBeenCalled();
      expect(pipeline.upstreamCancelled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
    } finally {
      await pipeline.dispose();
    }
  });

  it("an open Claude stream with genuine silence aborts at the actual 240s client watchdog", async () => {
    const pipeline = runPipeline();
    try {
      await pipeline.push(TOOL_ADDED);
      await vi.advanceTimersByTimeAsync(240 * 1000 - 1);
      expect(pipeline.controller.isConnected()).toBe(true);
      expect(pipeline.isReaderDone()).toBe(false);
      expect(pipeline.onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pipeline.finishDrain();
      expect(pipeline.controller.signal.aborted).toBe(true);
      expect(pipeline.controller.isConnected()).toBe(false);
      expect(pipeline.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "client event stall timeout" })
      );
      const frames = pipeline.frames();
      expect(frames.filter((f) => f.event === "ping")).toHaveLength(0);
      expect(frames.filter((f) => f.event === "error")).toHaveLength(1);
      expect(frames.find((f) => f.event === "error").data.error.message).toContain("client event stall timeout");
      expect(frames.filter((f) => f.event === "message_stop")).toHaveLength(0);
      expect(pipeline.upstreamState()).toBe("cancelled");
      expect(pipeline.upstreamCancelled).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
    } finally {
      await pipeline.dispose();
    }
  });

  it("an OpenAI client keeps the raw watchdog at 360s and receives no Claude ping", async () => {
    const pipeline = runPipeline(FORMATS.OPENAI);
    try {
      await pipeline.push({ type: "response.output_text.delta", delta: "started" });
      await vi.advanceTimersByTimeAsync(360 * 1000 - 1);
      expect(pipeline.controller.isConnected()).toBe(true);
      expect(pipeline.isReaderDone()).toBe(false);
      expect(pipeline.onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pipeline.finishDrain();
      expect(pipeline.controller.signal.aborted).toBe(true);
      expect(pipeline.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "stream stall timeout" })
      );
      const frames = pipeline.frames();
      expect(frames.filter((f) => f.event === "ping" || f.data?.type === "ping")).toHaveLength(0);
      expect(frames.filter((f) => f.data?.error)).toHaveLength(1);
      expect(frames.find((f) => f.data?.error).data.error.message).toContain("stream stall timeout");
      expect(frames.filter((f) => f.data === "[DONE]")).toHaveLength(1);
      expect(pipeline.upstreamState()).toBe("cancelled");
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
    } finally {
      await pipeline.dispose();
    }
  });

  it("Responses clients pass buffered argument traffic through beyond 300s without Claude pings", async () => {
    const pipeline = runPipeline(FORMATS.OPENAI_RESPONSES);
    const fragments = ['{"file_path":"/tmp/x.js","pad":"', ...Array.from({ length: 30 }, () => "x"), '"}'];
    try {
      await pipeline.push(TOOL_ADDED);
      for (const fragment of fragments) {
        await pipeline.push(deltaEvent(fragment));
        await vi.advanceTimersByTimeAsync(10 * 1000);
      }
      expect(Date.now()).toBe(320 * 1000);
      expect(pipeline.controller.isConnected()).toBe(true);
      expect(pipeline.controller.signal.aborted).toBe(false);
      const frames = pipeline.frames();
      expect(frames.filter((f) => f.event === "ping" || f.data?.type === "ping")).toHaveLength(0);
      expect(frames.filter((f) => f.event === "response.function_call_arguments.delta")
        .map((f) => f.data.delta)).toEqual(fragments);
      await pipeline.push(completed);
      await pipeline.close();
      expect(pipeline.frames().filter((f) => f.event === "response.completed")).toHaveLength(1);
      expect(pipeline.frames().filter((f) => f.data === "[DONE]")).toHaveLength(1);
      expect(pipeline.onError).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
    } finally {
      await pipeline.dispose();
    }
  });

  it.each([
    ["unknown key", deltaEvent("junk", "unknown_key")],
    ["empty string", deltaEvent("")],
    ["object delta", deltaEvent({ junk: true })],
    ["number delta", deltaEvent(7)],
    ["closed tool", deltaEvent("junk")],
  ])("raw %s traffic cannot keep a Claude stream alive with a fake ping", async (kind, event) => {
    const pipeline = runPipeline();
    try {
      await pipeline.push(TOOL_ADDED);
      if (kind === "closed tool") {
        await pipeline.push({ type: "response.output_item.done", output_index: 0, item: TOOL_ADDED.item });
      }
      for (let i = 0; i < 23; i++) {
        await vi.advanceTimersByTimeAsync(10 * 1000);
        await pipeline.push(event);
        expect(pipeline.controller.isConnected()).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(10 * 1000 - 1);
      expect(pipeline.isReaderDone()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pipeline.finishDrain();
      expect(pipeline.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "client event stall timeout" })
      );
      expect(pipeline.controller.signal.aborted).toBe(true);
      expect(pipeline.frames().filter((f) => f.event === "ping")).toHaveLength(0);
      expect(pipeline.frames().filter((f) => f.event === "error")).toHaveLength(1);
      expect(pipeline.upstreamCancelled).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
    } finally {
      await pipeline.dispose();
    }
  });

  it("real cancel before terminal/EOF clears watchdogs and aborts after the 500ms grace", async () => {
    const pipeline = runPipeline();
    try {
      await pipeline.push(TOOL_ADDED);
      await pipeline.push(deltaEvent('{"file_path":"/partial'));
      const beforeCancel = pipeline.text();
      await pipeline.cancel();
      expect(pipeline.onDisconnect).toHaveBeenCalledTimes(1);
      expect(pipeline.controller.isConnected()).toBe(false);
      expect(pipeline.controller.signal.aborted).toBe(false);
      expect(pipeline.upstreamState()).toBe("cancelled");
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline + 1);
      await vi.advanceTimersByTimeAsync(499);
      expect(pipeline.controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(pipeline.controller.signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
      await vi.advanceTimersByTimeAsync(360 * 1000);
      expect(pipeline.text()).toBe(beforeCancel);
      expect(pipeline.onError).not.toHaveBeenCalled();
      expect(pipeline.frames().filter((f) => ["error", "message_stop"].includes(f.event))).toHaveLength(0);
      expect(pipeline.onStreamComplete).not.toHaveBeenCalled();
    } finally {
      await pipeline.dispose();
    }
  });

  it("actual EOF before a protocol terminal emits one error and leaves no timers", async () => {
    const pipeline = runPipeline();
    try {
      await pipeline.push(TOOL_ADDED);
      await pipeline.close();
      expect(pipeline.controller.isConnected()).toBe(false);
      expect(pipeline.controller.signal.aborted).toBe(false);
      expect(pipeline.upstreamState()).toBe("eof");
      expect(pipeline.frames().filter((f) => f.event === "error")).toHaveLength(1);
      expect(pipeline.frames().find((f) => f.event === "error").data.error.message).toContain("without terminal");
      expect(pipeline.frames().filter((f) => ["ping", "message_stop"].includes(f.event))).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
      const afterEOF = pipeline.text();
      await vi.advanceTimersByTimeAsync(360 * 1000);
      expect(pipeline.text()).toBe(afterEOF);
      expect(pipeline.onError).not.toHaveBeenCalled();
      expect(pipeline.onStreamComplete).not.toHaveBeenCalled();
    } finally {
      await pipeline.dispose();
    }
  });

  it("protocol completed followed by actual EOF cleans timers without duplicate terminal", async () => {
    const pipeline = runPipeline();
    try {
      await pipeline.push({ type: "response.output_text.delta", delta: "done" });
      await pipeline.push(completed);
      expect(pipeline.isReaderDone()).toBe(false);
      await pipeline.close();
      expect(pipeline.controller.isConnected()).toBe(false);
      expect(pipeline.controller.signal.aborted).toBe(false);
      expect(pipeline.frames().filter((f) => f.event === "message_stop")).toHaveLength(1);
      expect(pipeline.frames().filter((f) => ["ping", "error"].includes(f.event))).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
      const afterEOF = pipeline.text();
      await vi.advanceTimersByTimeAsync(360 * 1000);
      expect(pipeline.text()).toBe(afterEOF);
      expect(pipeline.onStreamComplete).toHaveBeenCalledTimes(1);
      expect(pipeline.onError).not.toHaveBeenCalled();
      expect(pipeline.upstreamCancelled).not.toHaveBeenCalled();
    } finally {
      await pipeline.dispose();
    }
  });

  it("upstream transport error before EOF emits one error and cleans timers", async () => {
    const pipeline = runPipeline();
    try {
      await pipeline.push(TOOL_ADDED);
      await pipeline.error(new Error("synthetic upstream connection lost"));
      expect(pipeline.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "synthetic upstream connection lost" })
      );
      expect(pipeline.controller.isConnected()).toBe(false);
      expect(pipeline.upstreamState()).toBe("errored");
      expect(pipeline.frames().filter((f) => f.event === "error")).toHaveLength(1);
      expect(pipeline.frames().filter((f) => ["ping", "message_stop"].includes(f.event))).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
      const afterError = pipeline.text();
      await vi.advanceTimersByTimeAsync(360 * 1000);
      expect(pipeline.text()).toBe(afterError);
      expect(pipeline.onStreamComplete).not.toHaveBeenCalled();
    } finally {
      await pipeline.dispose();
    }
  });

  it("protocol failure remains terminal across late progress/completion and EOF", async () => {
    const pipeline = runPipeline();
    try {
      await pipeline.push(TOOL_ADDED);
      await pipeline.push({ type: "response.failed", response: { status: "failed", error: { message: "synthetic overload", type: "api_error" } } });
      const afterFailure = pipeline.text();
      await pipeline.push(deltaEvent("late"));
      expect(pipeline.text()).toBe(afterFailure);
      await pipeline.push({ type: "response.failed", response: { error: { message: "duplicate failure" } } });
      expect(pipeline.text()).toBe(afterFailure);
      await pipeline.push(completed);
      await pipeline.close();
      // BASE may close a previously open tool block on a late completion.
      // Preserve that policy while keeping failure dominant over success.
      expect(pipeline.frames().filter((f) => f.event === "error")).toHaveLength(1);
      expect(pipeline.frames().find((f) => f.event === "error").data.error.message).toBe("synthetic overload");
      expect(pipeline.frames().filter((f) => ["ping", "message_delta", "message_stop"].includes(f.event))).toHaveLength(0);
      expect(pipeline.onStreamComplete).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(pipeline.timerBaseline);
    } finally {
      await pipeline.dispose();
    }
  });
});

describe("Codex forced-SSE nonstream Claude retry", () => {
  it("gpt-6.1-sol still returns a Message with restored tool IDs/names and usage", async () => {
    const encoder = new TextEncoder();
    const item = {
      type: "function_call", id: "fc_retry", call_id: "call_retry", name: "read",
      arguments: '{"file_path":"/tmp/retry.txt"}',
    };
    const raw = "event: response.output_item.done\ndata: " + JSON.stringify({ output_index: 0, item }) + "\n\n"
      + "event: response.completed\ndata: " + JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_retry", model: "gpt-6.1-sol", status: "completed", output: [item],
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      }) + "\n\n";
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(raw, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex", model: "gpt-6.1-sol",
      body: { model: "gpt-6.1-sol", messages: [] }, stream: false,
      requestStartTime: Date.now(), connectionId: "conn-retry",
      clientRawRequest: { endpoint: "/v1/messages" },
      toolNameMap: new Map([["read", "Read"]]), trackDone: vi.fn(), appendLog: vi.fn(),
    });
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    const message = await result.response.json();
    expect(message.type).toBe("message");
    expect(message.model).toBe("gpt-6.1-sol");
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([{
      type: "tool_use", id: "call_retry", name: "Read", input: { file_path: "/tmp/retry.txt" },
    }]);
    expect(message.usage).toMatchObject({ input_tokens: 10, output_tokens: 20 });
    expect(message).not.toHaveProperty("choices");
    expect(message).not.toHaveProperty("output");
  });
});
