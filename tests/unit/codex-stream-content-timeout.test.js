import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/executors/antigravity.js", () => ({ AntigravityExecutor: class {} }));
vi.mock("../../open-sse/services/thoughtSignatureStore.js", () => ({
  storeGeminiThoughtSignature: vi.fn(),
  getGeminiThoughtSignature: vi.fn(async () => null),
  getGeminiThoughtSignatureSync: vi.fn(() => null),
  signatureFamily: vi.fn(() => null),
}));

const { responsesToClaudeResponse } = await import("../../open-sse/translator/response/responses-to-claude.js");
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { createStreamController, pipeWithDisconnect } = await import("../../open-sse/utils/streamHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { buildStreamErrorBytes } = await import("../../open-sse/utils/streamHelpers.js");
const { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS, CLAUDE_STREAM_STALL_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js");

const encoder = new TextEncoder();

function createControllableWebStream({ status = 200, headers = { "Content-Type": "text/event-stream" } } = {}) {
  let controller;
  let cancelled = false;
  let closed = false;
  let errored = false;
  let cancelReason = null;
  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel(reason) { cancelled = true; cancelReason = reason; },
  });
  return {
    response: new Response(stream, { status, headers: new Headers(headers) }),
    enqueue(chunk) {
      if (typeof chunk === "string") controller.enqueue(encoder.encode(chunk));
      else controller.enqueue(chunk);
    },
    close() {
      if (closed || cancelled || errored) return;
      closed = true;
      controller.close();
    },
    error(err) {
      errored = true;
      controller.error(err);
    },
    isCancelled: () => cancelled,
    isClosed: () => closed,
    isErrored: () => errored,
    getCancelReason: () => cancelReason,
  };
}

function pipeResponsesToClaude(upstreamResponse, {
  model = "gpt-6.1-sol",
  reqTag = "req_int",
  reqLogger = null,
  onError = vi.fn(),
  onDisconnect = vi.fn(),
  customTransform = null,
  customController = null, pipeWithDisconnectFn = pipeWithDisconnect,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
  clientStallTimeoutMs = CLAUDE_STREAM_STALL_TIMEOUT_MS,
} = {}) {
  const logger = reqLogger || { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() };
  const transform = customTransform || createSSETransformStreamWithLogger(
    FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex", logger, null, model, "conn-int", null, vi.fn()
  );
  const controller = customController || createStreamController({
    provider: "codex", model, reqTag, log: { line: vi.fn(), errorLine: vi.fn() }, onError, onDisconnect,
  });
  const downstream = pipeWithDisconnectFn(
    upstreamResponse, transform, controller,
    (message) => buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, message, FORMATS.CLAUDE),
    stallTimeoutMs,
    clientStallTimeoutMs
  );
  return {
    response: new Response(downstream, {
      status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers: upstreamResponse.headers,
    }),
    controller, transform,
  };
}

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

async function disposeFixture(fixture, peek) {
  if (peek?.replacementBody && !peek.replacementBody.locked) await peek.replacementBody.cancel();
  else if (!fixture.response.body.locked) await fixture.response.body.cancel();
}

const thinkingOf = (events) => events
  .filter((x) => x.delta?.type === "thinking_delta")
  .map((x) => x.delta.thinking)
  .join("");

function run(events) {
  const state = {};
  return events.flatMap((event) => responsesToClaudeResponse(event, state) || []);
}

describe("codex stream content timeout: complete reasoning (Task 1)", () => {
  it("emits thinking_delta from output_item.done reasoning summary", () => {
    const state = {};
    const output = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_fixture", type: "reasoning", summary: [{ type: "summary_text", text: "Suy nghĩ thật" }] } }, state);
    expect(thinkingOf(output.filter(Boolean))).toBe("Suy nghĩ thật");
  });

  it("emits thinking from reasoning_summary_text.done", () => {
    const state = {};
    const output = responsesToClaudeResponse({ type: "response.reasoning_summary_text.done",
      item_id: "rs_1", output_index: 0, summary_index: 0, text: "done thought" }, state);
    expect(thinkingOf(output.filter(Boolean))).toBe("done thought");
  });

  it("emits thinking from reasoning_text.done", () => {
    const state = {};
    const output = responsesToClaudeResponse({ type: "response.reasoning_text.done",
      item_id: "rs_1", output_index: 0, content_index: 0, text: "reason text" }, state);
    expect(thinkingOf(output.filter(Boolean))).toBe("reason text");
  });

  it("concatenates multi-part summary and falls back to item.text", () => {
    const state = {};
    const multi = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_multi", type: "reasoning",
        summary: [{ type: "summary_text", text: "partA" }, { type: "summary_text", text: "partB" }] } }, state);
    expect(thinkingOf(multi.filter(Boolean))).toBe("partApartB");
    const fallback = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 1,
      item: { id: "rs_fallback", type: "reasoning", text: "text fallback" } }, {});
    expect(thinkingOf(fallback.filter(Boolean))).toBe("text fallback");
  });

  it("emits nothing for encrypted-only, malformed, non-string, null payloads", () => {
    const enc = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_enc", type: "reasoning", encrypted_content: "e30=" } }, {});
    expect(thinkingOf((enc || []).filter(Boolean))).toBe("");
    const bad = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_bad", type: "reasoning", summary: [{ type: "summary_text", text: 42 }] } }, {});
    expect(thinkingOf((bad || []).filter(Boolean))).toBe("");
    const nul = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_nul", type: "reasoning", summary: null } }, {});
    expect(thinkingOf((nul || []).filter(Boolean))).toBe("");
  });

  it("does not throw on malformed summary containers", () => {
    for (const summary of [{}, "bad", 42]) {
      let output;
      expect(() => {
        output = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
          item: { id: "rs_mal", type: "reasoning", summary } }, {});
      }).not.toThrow();
      expect(thinkingOf((output || []).filter(Boolean))).toBe("");
    }
  });

  it("dedupes done suffix after delta and repeats", () => {
    const state = {};
    const first = responsesToClaudeResponse(
      { type: "response.reasoning_summary_text.delta", item_id: "rs_d", output_index: 0, summary_index: 0, delta: "Suy" }, state);
    expect(thinkingOf(first.filter(Boolean))).toBe("Suy");
    const done = responsesToClaudeResponse({ type: "response.reasoning_summary_text.done",
      item_id: "rs_d", output_index: 0, summary_index: 0, text: "Suy nghĩ thật" }, state);
    expect(thinkingOf(done.filter(Boolean))).toBe(" nghĩ thật");
    const repeat = responsesToClaudeResponse({ type: "response.reasoning_summary_text.done",
      item_id: "rs_d", output_index: 0, summary_index: 0, text: "Suy nghĩ thật" }, state);
    expect(thinkingOf((repeat || []).filter(Boolean))).toBe("");
    const repeatItem = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_d", type: "reasoning", summary: [{ type: "summary_text", text: "Suy nghĩ thật" }] } }, state);
    expect(thinkingOf((repeatItem || []).filter(Boolean))).toBe("");
  });

  it("keeps two separate identical items", () => {
    const out = run([
      { type: "response.output_item.done", output_index: 0,
        item: { id: "rs_a", type: "reasoning", summary: [{ type: "summary_text", text: "same" }] } },
      { type: "response.output_item.done", output_index: 1,
        item: { id: "rs_b", type: "reasoning", summary: [{ type: "summary_text", text: "same" }] } },
    ]);
    expect(thinkingOf(out)).toBe("samesame");
  });

  it("shares buffer between output-index alias and item ID", () => {
    const state = {};
    const d = responsesToClaudeResponse(
      { type: "response.reasoning_summary_text.delta", output_index: 3, summary_index: 0, delta: "Suy" }, state);
    expect(thinkingOf(d.filter(Boolean))).toBe("Suy");
    const done = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 3,
      item: { id: "rs_alias", type: "reasoning", summary: [{ type: "summary_text", text: "Suy nghĩ thật" }] } }, state);
    expect(thinkingOf(done.filter(Boolean))).toBe(" nghĩ thật");
  });

  it("keeps summary and text channels and parts separate", () => {
    const state = {};
    const s = responsesToClaudeResponse(
      { type: "response.reasoning_summary_text.delta", item_id: "rs_c", output_index: 0, summary_index: 0, delta: "sum0" }, state);
    const t = responsesToClaudeResponse(
      { type: "response.reasoning_text.delta", item_id: "rs_c", output_index: 0, content_index: 0, delta: "sum0" }, state);
    expect(thinkingOf(s.filter(Boolean))).toBe("sum0");
    expect(thinkingOf(t.filter(Boolean))).toBe("sum0");
    const s1 = responsesToClaudeResponse(
      { type: "response.reasoning_summary_text.delta", item_id: "rs_c", output_index: 0, summary_index: 1, delta: "p1" }, state);
    expect(thinkingOf(s1.filter(Boolean))).toBe("p1");
  });

  it("emits no content after finish or error", () => {
    const state = {};
    run([{ type: "response.completed", response: { status: "completed" } }]);
    void state;
    const st2 = {};
    responsesToClaudeResponse({ type: "response.completed", response: { status: "completed" } }, st2);
    const late = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_late", type: "reasoning", summary: [{ type: "summary_text", text: "late" }] } }, st2);
    expect(thinkingOf((late || []).filter(Boolean))).toBe("");
    const st3 = {};
    responsesToClaudeResponse({ type: "response.failed", response: { error: { message: "boom" } } }, st3);
    const lateErr = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_late2", type: "reasoning", summary: [{ type: "summary_text", text: "late" }] } }, st3);
    expect(thinkingOf((lateErr || []).filter(Boolean))).toBe("");
  });

  it("emits nothing for contradictory-prefix complete and keeps buffer", () => {
    const state = {};
    const first = responsesToClaudeResponse(
      { type: "response.reasoning_summary_text.delta", item_id: "rs_x", output_index: 0, summary_index: 0, delta: "Suy" }, state);
    expect(thinkingOf(first.filter(Boolean))).toBe("Suy");
    const bad = responsesToClaudeResponse({ type: "response.reasoning_summary_text.done",
      item_id: "rs_x", output_index: 0, summary_index: 0, text: "khác hoàn toàn" }, state);
    expect(thinkingOf((bad || []).filter(Boolean))).toBe("");
    const good = responsesToClaudeResponse({ type: "response.reasoning_summary_text.done",
      item_id: "rs_x", output_index: 0, summary_index: 0, text: "Suy nghĩ thật" }, state);
    expect(thinkingOf((good || []).filter(Boolean))).toBe(" nghĩ thật");
  });

  it("emits no text delta or message item.done after finish or error", () => {
    const st = {};
    responsesToClaudeResponse({ type: "response.completed", response: { status: "completed" } }, st);
    const lateDelta = responsesToClaudeResponse(
      { type: "response.output_text.delta", content_index: 0, delta: "late" }, st);
    expect(lateDelta ?? []).toEqual([]);
    const lateItem = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "msg_late", type: "message", content: [{ type: "output_text", text: "late" }] } }, st);
    expect(lateItem ?? []).toEqual([]);
    const stE = {};
    responsesToClaudeResponse({ type: "response.failed", response: { error: { message: "boom" } } }, stE);
    const lateErr = responsesToClaudeResponse(
      { type: "response.output_text.delta", content_index: 0, delta: "late" }, stE);
    expect(lateErr ?? []).toEqual([]);
    const lateErrItem = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "msg_late2", type: "message", content: [{ type: "output_text", text: "late" }] } }, stE);
    expect(lateErrItem ?? []).toEqual([]);
  });

  it("dedupes item.text fallback against summary delta channel", () => {
    const state = {};
    const first = responsesToClaudeResponse(
      { type: "response.reasoning_summary_text.delta", item_id: "rs_s", output_index: 0, summary_index: 0, delta: "Suy" }, state);
    expect(thinkingOf(first.filter(Boolean))).toBe("Suy");
    const done = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_s", type: "reasoning", text: "Suy nghĩ thật" } }, state);
    expect(thinkingOf((done || []).filter(Boolean))).toBe(" nghĩ thật");
    const repeat = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_s", type: "reasoning", text: "Suy nghĩ thật" } }, state);
    expect(thinkingOf((repeat || []).filter(Boolean))).toBe("");
  });

  it("dedupes item.text fallback against generic reasoning delta channel", () => {
    const state = {};
    const first = responsesToClaudeResponse(
      { type: "response.reasoning.delta", item_id: "rs_g", output_index: 0, delta: "Suy" }, state);
    expect(thinkingOf(first.filter(Boolean))).toBe("Suy");
    const done = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_g", type: "reasoning", text: "Suy nghĩ thật" } }, state);
    expect(thinkingOf((done || []).filter(Boolean))).toBe(" nghĩ thật");
  });

  it("prefers valid summary over item.text even when summary already emitted", () => {
    const state = {};
    const first = responsesToClaudeResponse(
      { type: "response.reasoning_summary_text.delta", item_id: "rs_p", output_index: 0, summary_index: 0, delta: "hello" }, state);
    expect(thinkingOf(first.filter(Boolean))).toBe("hello");
    const done = responsesToClaudeResponse({ type: "response.output_item.done", output_index: 0,
      item: { id: "rs_p", type: "reasoning", summary: [{ type: "summary_text", text: "hello" }], text: "hello extra" } }, state);
    expect(thinkingOf((done || []).filter(Boolean))).toBe("");
  });

  it("closes thinking before text, tool, terminal", () => {
    const out = run([
      { type: "response.reasoning_summary_text.delta", item_id: "rs_t", output_index: 0, summary_index: 0, delta: "think" },
      { type: "response.output_text.delta", content_index: 0, delta: "hello" },
    ]);
    const stops = out.filter((x) => x.type === "content_block_stop");
    expect(stops.length).toBeGreaterThanOrEqual(1);
    expect(thinkingOf(out)).toBe("think");
    expect(out.filter((x) => x.delta?.type === "text_delta").map((x) => x.delta.text).join("")).toBe("hello");
  });
});

describe("codex stream content timeout: payload-aware peek and deadline (Task 2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("replays a complete reasoning done payload without matching", async () => {
    const text = 'data: {"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]}}\n\n';
    const fixture = openResponse(text);
    let peek;
    try {
      const pending = new CodexExecutor()._peekSseTransientError(fixture.response, { timeoutMs: 70 });
      await vi.advanceTimersByTimeAsync(100);
      peek = await pending;
      expect(peek.matched).toBeNull();
      fixture.input.close();
      expect(await new Response(peek.replacementBody).text()).toBe(text);
    } finally {
      await disposeFixture(fixture, peek);
    }
  });

  it.each([
    ["reasoning text done", '{"type":"response.reasoning_text.done","item_id":"rs_1","content_index":0,"text":"thought"}'],
    ["reasoning summary done", '{"type":"response.reasoning_summary_text.done","item_id":"rs_1","summary_index":0,"text":"thought"}'],
    ["message item done", '{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"hello"}]}}'],
    ["output_text done", '{"type":"response.output_text.done","item_id":"msg_1","content_index":0,"text":"hello"}'],
  ])("treats complete %s as content", async (_name, payload) => {
    const text = `data: ${payload}\n\n`;
    const fixture = openResponse(text);
    let peek;
    try {
      const pending = new CodexExecutor()._peekSseTransientError(fixture.response, { timeoutMs: 70 });
      await vi.advanceTimersByTimeAsync(100);
      peek = await pending;
      expect(peek.matched).toBeNull();
      fixture.input.close();
      expect(await new Response(peek.replacementBody).text()).toBe(text);
    } finally {
      await disposeFixture(fixture, peek);
    }
  });

  it.each([
    ["event-only", 'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0}\n\n'],
    ["empty payload", 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}\n\n'],
    ["malformed json", "data: {not json\n\n"],
    ["encrypted-only", 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","encrypted_content":"e30="}}\n\n'],
  ])("rejects %s as content", async (_name, text) => {
    // Stream stays open: unrecognized frames must not resolve as content,
    // so the peek runs into its deadline instead of succeeding early.
    const fixture = openResponse(text);
    let peek;
    try {
      const pending = new CodexExecutor()._peekSseTransientError(fixture.response, { timeoutMs: 70 });
      await vi.advanceTimersByTimeAsync(100);
      peek = await pending;
      expect(peek.matched ?? peek.timedOut ?? false).toBeTruthy();
      expect(peek.replacementBody).toBeNull();
    } finally {
      await disposeFixture(fixture, peek);
    }
  });

  it("prefers structured capacity over complete content on the same line", async () => {
    const text = 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]},"error":{"message":"Selected model is at capacity. Please try a different model."}}\n\n';
    const fixture = openResponse(text);
    let peek;
    try {
      peek = await new CodexExecutor()._peekSseTransientError(fixture.response, { timeoutMs: 70 });
      expect(peek.matched).not.toBeNull();
      expect(peek.accountFallback).toBe(true);
    } finally {
      await disposeFixture(fixture, peek);
    }
  });

  it("replays split SSE and spaced JSON exactly", async () => {
    const text = 'data: {"type": "response.output_item.done", "item": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "suy nghĩ 🧠"}]}}\n\n';
    const allBytes = encoder.encode(text);
    // Split into multiple byte chunks across UTF-8 multi-byte boundary and mid-JSON
    const splitPoint1 = 20; // mid '{"type": "res...'
    const splitPoint2 = text.indexOf("suy nghĩ") + 7; // mid UTF-8 multi-byte character sequence
    const chunk1 = allBytes.subarray(0, splitPoint1);
    const chunk2 = allBytes.subarray(splitPoint1, splitPoint2);
    const chunk3 = allBytes.subarray(splitPoint2);

    let controller;
    let cancelled = false;
    const stream = new ReadableStream({
      start(c) { controller = c; },
      cancel() { cancelled = true; },
    });
    const response = new Response(stream, { headers: { "Content-Type": "text/event-stream" } });

    let peek;
    try {
      const pending = new CodexExecutor()._peekSseTransientError(response, { timeoutMs: 70 });
      controller.enqueue(chunk1);
      controller.enqueue(chunk2);
      controller.enqueue(chunk3);
      controller.close();
      await vi.advanceTimersByTimeAsync(100);
      peek = await pending;
      expect(peek.matched).toBeNull();
      expect(cancelled).toBe(false);

      // Verify exact byte replay from replacementBody
      const replayedBytes = new Uint8Array(await new Response(peek.replacementBody).arrayBuffer());
      expect(replayedBytes).toEqual(allBytes);
      expect(new TextDecoder().decode(replayedBytes)).toBe(text);
    } finally {
      if (peek?.replacementBody && !peek.replacementBody.locked) {
        await peek.replacementBody.cancel().catch(() => {});
      }
    }
  });

  it("succeeds after connect deadline but before first-content deadline on both peeks", async () => {
    vi.stubEnv("FETCH_CONNECT_TIMEOUT_MS", "30");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "100");
    try {
      vi.resetModules();
      const { handleComboChat: freshCombo } = await import("../../open-sse/services/combo.js");
      const { CodexExecutor: FreshCodex } = await import("../../open-sse/executors/codex.js");
      const { createStreamController: freshCreateController } = await import("../../open-sse/utils/streamHandler.js");
      const { createSSETransformStreamWithLogger: freshCreateTransform } = await import("../../open-sse/utils/stream.js");
      const { STREAM_STALL_TIMEOUT_MS: freshStall, CLAUDE_STREAM_STALL_TIMEOUT_MS: freshClientStall } = await import("../../open-sse/config/runtimeConfig.js");
      const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

      const doneChunk = 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]}}\n\n';
      const completedChunk = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';

      // 1. Single-model delayed deadline: start real _peekSseTransientError with default timeout (reads STREAM_FIRST_CHUNK_TIMEOUT_MS = 100)
      const fixture = openResponse("");
      let peekSettled = false;
      const codexPromise = new FreshCodex()._peekSseTransientError(fixture.response);
      codexPromise.then(() => { peekSettled = true; }, () => { peekSettled = true; });

      // Advance 40ms (> 30ms connect timeout): assert not resolved and not cancelled
      await vi.advanceTimersByTimeAsync(40); expect(peekSettled).toBe(false);
      expect(fixture.isCancelled()).toBe(false);

      // Done reasoning at 50ms, completed + EOF
      await vi.advanceTimersByTimeAsync(10); fixture.input.enqueue(encoder.encode(doneChunk));
      fixture.input.enqueue(encoder.encode(completedChunk));
      fixture.input.close();

      await vi.advanceTimersByTimeAsync(20);
      const codexPeek = await codexPromise;
      expect(codexPeek.matched).toBeNull();

      // Real transform/wrapper/client: pipe replacementBody to Claude format
      const wrapped = pipeResponsesToClaude(
        new Response(codexPeek.replacementBody, { headers: { "Content-Type": "text/event-stream" } }),
        {
          model: "gpt-6.1-sol",
          customTransform: freshCreateTransform(
            FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex",
            { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() },
            null, "gpt-6.1-sol", "conn-single-delayed", null, vi.fn()
          ),
          customController: freshCreateController({
            provider: "codex", model: "gpt-6.1-sol", reqTag: "req_single_delayed",
            log: { line: vi.fn(), errorLine: vi.fn() }, onError: vi.fn(), onDisconnect: vi.fn()
          }),
          stallTimeoutMs: freshStall,
          clientStallTimeoutMs: freshClientStall,
        }
      );
      const clientText = await wrapped.response.text();
      const thinkingCount = (clientText.match(/thinking_delta/g) || []).length;
      expect(thinkingCount).toBe(1);
      expect(clientText).toContain("thought");
      expect(clientText).toContain("message_stop");
      expect(clientText).not.toContain("stream_error");

      // 2. Combo test: assert settled=false at 40ms, still raw ingestion
      let comboRawStream = null;
      let comboSettled = false; const pendingCombo = freshCombo({
        body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["codex/p1"],
        handleSingleModel: async () => {
          comboRawStream = createControllableWebStream();
          return comboRawStream.response;
        },
        log: silentLog,
        comboName: "combo-deadline",
        comboStrategy: "fallback",
      });
      pendingCombo.then(() => { comboSettled = true; }, () => { comboSettled = true; });

      // Advance 40ms (> 30ms connect timeout): assert settled=false, raw ingestion stream not cancelled
      await vi.advanceTimersByTimeAsync(40);
      expect(comboSettled).toBe(false);
      expect(comboRawStream.isCancelled()).toBe(false);

      // Done reasoning at 50ms, completed + EOF
      await vi.advanceTimersByTimeAsync(10);
      comboRawStream.enqueue(doneChunk);
      comboRawStream.enqueue(completedChunk);
      comboRawStream.close();

      await vi.advanceTimersByTimeAsync(20);
      const comboResponse = await pendingCombo;
      expect(comboResponse.status).toBe(200);
      const comboText = await comboResponse.text();
      expect(comboText).toContain("thought");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("codex stream content timeout: safe transport diagnostics (Task 3)", () => {
  it("logs safe cause code and name without secrets", () => {
    const errorLine = vi.fn();
    const onError = vi.fn();
    const ctrl = createStreamController({ log: { errorLine }, onError, reqTag: "req_mock", provider: "codex", model: "gpt-6.1-sol" });
    const err = new TypeError("terminated", { cause: { name: "SocketError", code: "UND_ERR_SOCKET", message: "SECRET_SENTINEL", socket: { remoteAddress: "PRIVATE_SENTINEL" } } });
    ctrl.handleError(err);
    expect(errorLine.mock.calls[0][2]).toContain("UND_ERR_SOCKET");
    expect(errorLine.mock.calls[0][0]).toBe("req_mock");
    expect(JSON.stringify(errorLine.mock.calls)).not.toMatch(/SECRET_SENTINEL|PRIVATE_SENTINEL/);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("handles absent cause with no metadata", () => {
    const errorLine = vi.fn();
    const onError = vi.fn();
    const ctrl = createStreamController({ log: { errorLine }, onError, reqTag: "req_mock", provider: "codex", model: "gpt-6.1-sol" });
    ctrl.handleError(new TypeError("terminated"));
    expect(errorLine).toHaveBeenCalled();
    expect(JSON.stringify(errorLine.mock.calls)).not.toMatch(/undefined|NaN/);
    expect(onError).toHaveBeenCalled();
  });

  it("falls back to top-level code and truncates long identifiers", () => {
    const errorLine = vi.fn();
    const ctrl = createStreamController({ log: { errorLine }, reqTag: "req_mock", provider: "codex", model: "gpt-6.1-sol" });
    const longCode = `UND_ERR_SOCKET_${"X".repeat(100)}`;
    ctrl.handleError(Object.assign(new TypeError("terminated"), { code: longCode }));
    const logged = String(errorLine.mock.calls[0][2]);
    expect(logged.length).toBeLessThan(2000);
    expect(logged).toContain("UND_ERR_SOCKET_");
    expect(logged).not.toContain("X".repeat(100));
  });

  it("ignores multiline, non-string, and cyclic cause metadata", () => {
    const errorLine = vi.fn();
    const ctrl = createStreamController({ log: { errorLine }, reqTag: "req_mock", provider: "codex", model: "gpt-6.1-sol" });
    const cyclic = { name: "SocketError" };
    cyclic.self = cyclic;
    ctrl.handleError(new TypeError("terminated", { cause: { name: "Socket\nError", code: 42, extra: cyclic } }));
    expect(JSON.stringify(errorLine.mock.calls)).not.toMatch(/\n.*Error|SECRET/);
    expect(errorLine).toHaveBeenCalled();
  });

  it("keeps AbortError as ABORTED and handles once", () => {
    const line = vi.fn();
    const errorLine = vi.fn();
    const onError = vi.fn();
    const ctrl = createStreamController({ log: { line, errorLine }, onError, reqTag: "req_mock", provider: "codex", model: "gpt-6.1-sol" });
    const abort = new DOMException("aborted", "AbortError");
    ctrl.handleError(abort);
    ctrl.handleError(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
    expect(line.mock.calls[0][2]).toContain("ABORTED");
    expect(errorLine).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("codex stream content timeout: integrated gate (Task 4)", () => {
  let timerBaseline = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    timerBaseline = vi.getTimerCount();
  });
  afterEach(async () => {
    // Grace period for any disconnect delayed abort (e.g. 500ms abortTimeout in createStreamController)
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(timerBaseline);
    vi.useRealTimers();
  });

  it("done-only reasoning delivered at 50ms with connect30/content100 succeeds without fallback, thinking exactly once, message_stop, no error, and timer cleanup", async () => {
    vi.stubEnv("FETCH_CONNECT_TIMEOUT_MS", "30");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "100");
    try {
      vi.resetModules();
      const { handleComboChat: freshCombo } = await import("../../open-sse/services/combo.js");
      const { createStreamController: freshCreateController } = await import("../../open-sse/utils/streamHandler.js");
      const { createSSETransformStreamWithLogger: freshCreateTransform } = await import("../../open-sse/utils/stream.js");
      const { STREAM_STALL_TIMEOUT_MS: freshStall, CLAUDE_STREAM_STALL_TIMEOUT_MS: freshClientStall } = await import("../../open-sse/config/runtimeConfig.js");
      timerBaseline = vi.getTimerCount();
      const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
      const attempted = [];
      let rawStream = null;
      let comboSettled = false;

      const pending = freshCombo({
        body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["codex/gpt-6.1-sol", "codex/fallback-model"],
        handleSingleModel: async (body, modelStr, opts) => {
          attempted.push(modelStr);
          expect(opts?.skipSsePeek).toBe(true);
          rawStream = createControllableWebStream();
          const wrapped = pipeResponsesToClaude(rawStream.response, {
            model: "gpt-6.1-sol",
            customTransform: freshCreateTransform(
              FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex",
              { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() },
              null, "gpt-6.1-sol", "conn-t4-1", null, vi.fn()
            ),
            customController: freshCreateController({
              provider: "codex", model: "gpt-6.1-sol", reqTag: "req_t4_1", onDisconnect: () => { console.log("REQ_T4_1 DISCONNECT"); },
              log: { line: vi.fn(), errorLine: vi.fn() }, onError: vi.fn(), onDisconnect: vi.fn()
            }),
            stallTimeoutMs: freshStall,
            clientStallTimeoutMs: freshClientStall,
          });
          return wrapped.response;
        },
        log: silentLog,
        comboName: "combo-done-only",
        comboStrategy: "fallback",
      });
      pending.then(() => { comboSettled = true; }, () => { comboSettled = true; });

      // Connect deadline 30ms passed; at 40ms still pending without timing out
      await vi.advanceTimersByTimeAsync(40);
      expect(comboSettled).toBe(false);
      expect(attempted).toEqual(["codex/gpt-6.1-sol"]);
      expect(rawStream.isCancelled()).toBe(false);

      // At 50ms: send done-only reasoning item + response.completed + EOF
      await vi.advanceTimersByTimeAsync(10);
      const doneChunk = 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_int","type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]}}\n\n';
      const completedChunk = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
      rawStream.enqueue(doneChunk);
      rawStream.enqueue(completedChunk);
      rawStream.close();

      await vi.advanceTimersByTimeAsync(20);
      const comboResponse = await pending;

      expect(comboResponse.status).toBe(200);
      expect(attempted).toEqual(["codex/gpt-6.1-sol"]);

      const text = await comboResponse.text();
      const thinkingCount = (text.match(/thinking_delta/g) || []).length;
      expect(thinkingCount).toBe(1);
      expect(text).toContain("thought");
      expect(text).toContain("message_stop");
      expect(text).not.toContain("stream_error");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("empty/comment stream actual wrapper cancels and falls back at combo deadline100 without pings counting as output", async () => {
    vi.stubEnv("FETCH_CONNECT_TIMEOUT_MS", "30");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "100");
    try {
      vi.resetModules();
      const { handleComboChat: freshCombo } = await import("../../open-sse/services/combo.js");
      const { createStreamController: freshCreateController } = await import("../../open-sse/utils/streamHandler.js");
      const { createSSETransformStreamWithLogger: freshCreateTransform } = await import("../../open-sse/utils/stream.js");
      const { STREAM_STALL_TIMEOUT_MS: freshStall, CLAUDE_STREAM_STALL_TIMEOUT_MS: freshClientStall } = await import("../../open-sse/config/runtimeConfig.js");
      timerBaseline = vi.getTimerCount();
      const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
      const attempted = [];
      let rawStream1 = null;
      let pingInterval = null;
      let rescueStream = null;

      try {
        const pending = freshCombo({
          body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
          models: ["codex/ping-only", "codex/rescue"],
          handleSingleModel: async (body, modelStr) => {
            attempted.push(modelStr);
            if (modelStr === "codex/ping-only") {
              rawStream1 = createControllableWebStream();
              pingInterval = setInterval(() => {
                if (rawStream1.isCancelled() || rawStream1.isClosed()) {
                  clearInterval(pingInterval);
                  pingInterval = null;
                  return;
                }
                rawStream1.enqueue(": ping\n\n");
              }, 15);
              const wrapped = pipeResponsesToClaude(rawStream1.response, {
                model: "ping-only",
                customTransform: freshCreateTransform(
                  FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex",
                  { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() },
                  null, "ping-only", "conn-ping", null, vi.fn()
                ),
                customController: freshCreateController({
                  provider: "codex", model: "ping-only", reqTag: "req_ping",
                  log: { line: vi.fn(), errorLine: vi.fn() }, onError: vi.fn(), onDisconnect: vi.fn()
                }),
                stallTimeoutMs: freshStall,
                clientStallTimeoutMs: freshClientStall,
              });
              return wrapped.response;
            }
            rescueStream = createControllableWebStream();
            const wrapped = pipeResponsesToClaude(rescueStream.response, {
              model: "rescue",
              customTransform: freshCreateTransform(
                FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex",
                { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() },
                null, "rescue", "conn-rescue", null, vi.fn()
              ),
              customController: freshCreateController({
                provider: "codex", model: "rescue", reqTag: "req_rescue",
                log: { line: vi.fn(), errorLine: vi.fn() }, onError: vi.fn(), onDisconnect: vi.fn()
              }),
              stallTimeoutMs: freshStall,
              clientStallTimeoutMs: freshClientStall,
            });
            rescueStream.enqueue('data: {"type":"response.output_text.delta","delta":"rescued"}\n\n');
            rescueStream.enqueue('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
            rescueStream.close();
            return wrapped.response;
          },
          log: silentLog,
          comboName: "combo-ping-fallback",
          comboStrategy: "fallback",
        });

        await vi.advanceTimersByTimeAsync(120);
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }

        const comboResponse = await pending;
        expect(attempted).toEqual(["codex/ping-only", "codex/rescue"]);
        expect(rawStream1.isCancelled()).toBe(true);

        const text = await comboResponse.text();
        expect(text).toContain("rescued");
      } finally {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      }
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("single path: real Codex peek then real transform/wrapper delivers complete reasoning without error", async () => {
    const doneChunk = 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_pk","type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]}}\n\n';
    const completedChunk = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
    const fixture = openResponse(doneChunk);
    let peek;
    try {
      const pending = new CodexExecutor()._peekSseTransientError(fixture.response, { timeoutMs: 70 });
      await vi.advanceTimersByTimeAsync(100);
      peek = await pending;
      expect(peek.matched).toBeNull();
      fixture.input.enqueue(encoder.encode(completedChunk));
      fixture.input.close();

      const replayedResponse = new Response(peek.replacementBody, { headers: { "Content-Type": "text/event-stream" } });
      const wrapped = pipeResponsesToClaude(replayedResponse, { model: "gpt-6.1-sol" });
      const text = await wrapped.response.text();

      expect(text).toContain("thought");
      expect((text.match(/thinking_delta/g) || []).length).toBe(1);
      expect(text).toContain("message_stop");
      expect(text).not.toContain("stream_error");
    } finally {
      await disposeFixture(fixture, peek);
    }
  });

  it("socket failure before content yields structured error without being misclassified as no-content timeout", async () => {
    vi.stubEnv("FETCH_CONNECT_TIMEOUT_MS", "30");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "100");
    try {
      vi.resetModules();
      const { handleComboChat: freshCombo } = await import("../../open-sse/services/combo.js");
      const { createStreamController: freshCreateController } = await import("../../open-sse/utils/streamHandler.js");
      const { createSSETransformStreamWithLogger: freshCreateTransform } = await import("../../open-sse/utils/stream.js");
      const { STREAM_STALL_TIMEOUT_MS: freshStall, CLAUDE_STREAM_STALL_TIMEOUT_MS: freshClientStall } = await import("../../open-sse/config/runtimeConfig.js");
      timerBaseline = vi.getTimerCount();
      const errorLine = vi.fn();
      const comboWarnings = [];
      const testLog = {
        info: vi.fn(),
        warn: vi.fn((tag, msg, extra) => comboWarnings.push({ tag, msg, extra })),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const attempted = [];
      let rawStream = null;
      let rescueStream = null;

      const pending = freshCombo({
        body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["codex/socket-fail", "codex/fallback-model"],
        handleSingleModel: async (body, modelStr) => {
          attempted.push(modelStr);
          if (modelStr === "codex/socket-fail") {
            rawStream = createControllableWebStream();
            const logger = { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() };
            const transform = freshCreateTransform(
              FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex", logger, null, "socket-fail", "conn-sf", null, vi.fn()
            );
            const controller = freshCreateController({
              provider: "codex", model: "socket-fail", reqTag: "req_sf", log: { line: vi.fn(), errorLine }, onError: vi.fn(), onDisconnect: vi.fn()
            });
            const downstream = pipeWithDisconnect(
              rawStream.response, transform, controller,
              (msg) => buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, msg, FORMATS.CLAUDE),
              freshStall,
              freshClientStall
            );
            return new Response(downstream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
          }
          rescueStream = createControllableWebStream();
          const wrapped = pipeResponsesToClaude(rescueStream.response, {
            model: "rescue",
            customTransform: freshCreateTransform(
              FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex",
              { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() },
              null, "rescue", "conn-sf-rescue", null, vi.fn()
            ),
            customController: freshCreateController({
              provider: "codex", model: "rescue", reqTag: "req_rescue",
              log: { line: vi.fn(), errorLine: vi.fn() }, onError: vi.fn(), onDisconnect: vi.fn()
            }),
            stallTimeoutMs: freshStall,
            clientStallTimeoutMs: freshClientStall,
          });
          rescueStream.enqueue('data: {"type":"response.output_text.delta","delta":"rescued-after-socket"}\n\n');
          rescueStream.enqueue('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
          rescueStream.close();
          return wrapped.response;
        },
        log: testLog,
        comboName: "combo-socket-fail",
        comboStrategy: "fallback",
      });

      await vi.advanceTimersByTimeAsync(20);
      rawStream.error(new TypeError("terminated", { cause: { name: "SocketError", code: "UND_ERR_SOCKET" } }));

      await vi.advanceTimersByTimeAsync(30);
      const comboResponse = await pending;

      // 1. Controller logged safe diagnostics
      expect(errorLine).toHaveBeenCalled();
      expect(String(errorLine.mock.calls[0][2])).toContain("UND_ERR_SOCKET");
      expect(errorLine.mock.calls[0][0]).toBe("req_sf");

      // 2. Classification proven: warnings must NOT contain "timed out waiting for stream content"
      const warningTexts = comboWarnings.map((w) => `${w.tag} ${w.msg} ${JSON.stringify(w.extra || {})}`).join(" | ");
      expect(warningTexts).not.toContain("timed out waiting for stream content");

      // 3. Structured upstream-connection-lost error / fallback status
      const failureWarning = comboWarnings.find((w) => w.msg?.includes("failed, trying next"));
      expect(failureWarning).toBeDefined();
      expect(failureWarning.extra?.status).toBe(500);
      expect(failureWarning.extra?.error).toBe("upstream connection lost");

      // 4. Fallback was executed and no false terminal
      expect(attempted).toEqual(["codex/socket-fail", "codex/fallback-model"]);
      expect(comboResponse.status).toBe(200);
      const text = await comboResponse.text();
      expect(text).toContain("rescued-after-socket");
      expect(text).not.toContain("stream_error");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("error after text content is accepted does not attempt next model and delivers error to client", async () => {
    try {
      vi.resetModules();
      const { handleComboChat: freshCombo } = await import("../../open-sse/services/combo.js");
      const { createStreamController: freshCreateController } = await import("../../open-sse/utils/streamHandler.js");
      const { createSSETransformStreamWithLogger: freshCreateTransform } = await import("../../open-sse/utils/stream.js");
      const { STREAM_STALL_TIMEOUT_MS: freshStall, CLAUDE_STREAM_STALL_TIMEOUT_MS: freshClientStall } = await import("../../open-sse/config/runtimeConfig.js");
      timerBaseline = vi.getTimerCount();
      const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
      const attempted = [];
      let rawStream = null;

      const pending = freshCombo({
        body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["codex/accepted-then-error", "codex/never-attempted"],
        handleSingleModel: async (body, modelStr) => {
          attempted.push(modelStr);
          rawStream = createControllableWebStream();
          const wrapped = pipeResponsesToClaude(rawStream.response, {
            model: modelStr,
            customTransform: freshCreateTransform(
              FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex",
              { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() },
              null, modelStr, "conn-acc-err", null, vi.fn()
            ),
            customController: freshCreateController({
              provider: "codex", model: modelStr, reqTag: "req_acc_err",
              log: { line: vi.fn(), errorLine: vi.fn() }, onError: vi.fn(), onDisconnect: vi.fn()
            }),
            stallTimeoutMs: freshStall,
            clientStallTimeoutMs: freshClientStall,
          });
          return wrapped.response;
        },
        log: silentLog,
        comboName: "combo-accepted-error",
        comboStrategy: "fallback",
      });

      rawStream.enqueue('data: {"type":"response.output_text.delta","delta":"accepted text"}\n\n');
      await vi.advanceTimersByTimeAsync(10);

      const comboResponse = await pending;
      expect(comboResponse.status).toBe(200);
      expect(attempted).toEqual(["codex/accepted-then-error"]);

      rawStream.enqueue('data: {"type":"response.failed","response":{"status":"failed","error":{"message":"late failure"}}}\n\n');
      rawStream.close();
      await vi.advanceTimersByTimeAsync(20);

      const text = await comboResponse.text();
      // Parse real SSE frames: event: error must be present, no message_stop
      const frames = text.split("\n\n").filter((f) => f.trim().length > 0);
      const parsedEvents = frames.map((frame) => {
        const ev = {};
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) ev.event = line.slice(6).trim();
          if (line.startsWith("data:")) {
            try { ev.data = JSON.parse(line.slice(5).trim()); } catch { ev.data = line.slice(5).trim(); }
          }
        }
        return ev;
      });

      const errorEvent = parsedEvents.find((e) => e.event === "error" || e.data?.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.data?.error?.message).toBe("late failure");
      // No successful terminal event
      expect(parsedEvents.some((e) => e.event === "message_stop" || e.data?.type === "message_stop")).toBe(false);
      // No next attempt
      expect(attempted).toEqual(["codex/accepted-then-error"]);
    } finally {
      vi.resetModules();
    }
  });

  it("caller abort cancels current stream and makes no next attempt", async () => {
    try {
      vi.resetModules();
      const { handleComboChat: freshCombo } = await import("../../open-sse/services/combo.js");
      const { createStreamController: freshCreateController } = await import("../../open-sse/utils/streamHandler.js");
      const { createSSETransformStreamWithLogger: freshCreateTransform } = await import("../../open-sse/utils/stream.js");
      const { STREAM_STALL_TIMEOUT_MS: freshStall, CLAUDE_STREAM_STALL_TIMEOUT_MS: freshClientStall } = await import("../../open-sse/config/runtimeConfig.js");
      timerBaseline = vi.getTimerCount();
      const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
      const attempted = [];
      let rawStream = null;
      const abortController = new AbortController();

      const pending = freshCombo({
        body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["codex/abort-m1", "codex/abort-m2"],
        handleSingleModel: async (body, modelStr) => {
          attempted.push(modelStr);
          rawStream = createControllableWebStream();
          const wrapped = pipeResponsesToClaude(rawStream.response, {
            model: modelStr,
            customTransform: freshCreateTransform(
              FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "codex",
              { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() },
              null, modelStr, "conn-abort", null, vi.fn()
            ),
            customController: freshCreateController({
              provider: "codex", model: modelStr, reqTag: "req_abort",
              log: { line: vi.fn(), errorLine: vi.fn() }, onError: vi.fn(), onDisconnect: vi.fn()
            }),
            stallTimeoutMs: freshStall,
            clientStallTimeoutMs: freshClientStall,
          });
          return wrapped.response;
        },
        log: silentLog,
        comboName: "combo-abort",
        comboStrategy: "fallback",
        signal: abortController.signal,
      });

      await vi.advanceTimersByTimeAsync(20);
      expect(attempted).toEqual(["codex/abort-m1"]);

      abortController.abort();
      await vi.advanceTimersByTimeAsync(10);

      const comboResponse = await pending;
      expect(comboResponse.status).toBe(499);
      expect(rawStream.isCancelled()).toBe(true);
      expect(attempted).toEqual(["codex/abort-m1"]);
    } finally {
      vi.resetModules();
    }
  });

  it("structured capacity and SocketError differ from no-content timeout", async () => {
    const capacity = 'event: error\ndata: {"error":{"message":"Selected model is at capacity. Please try a different model."}}\n\n';
    const capFixture = openResponse(capacity);
    let capPeek;
    try {
      capPeek = await new CodexExecutor()._peekSseTransientError(capFixture.response, { timeoutMs: 70 });
      expect(capPeek.accountFallback).toBe(true);
    } finally {
      await disposeFixture(capFixture, capPeek);
    }
    const errorLine = vi.fn();
    const ctrl = createStreamController({
      log: { errorLine }, reqTag: "req_mock", provider: "codex", model: "gpt-6.1-sol", onError: vi.fn(), onDisconnect: vi.fn()
    });
    ctrl.handleError(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
    expect(String(errorLine.mock.calls[0][2])).toContain("UND_ERR_SOCKET");
  });
});
