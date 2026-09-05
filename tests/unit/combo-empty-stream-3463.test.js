import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { FETCH_CONNECT_TIMEOUT_MS, STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

const encoder = new TextEncoder();
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

// Build a provider Response whose body emits the given raw SSE chunks then closes
// cleanly. Status is 200 throughout: the whole point of #3463 is that the HTTP
// layer reports success while the payload carries nothing usable.
function sseResponse(chunks, { contentType = "text/event-stream" } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Run a two-model fallback combo, recording which models were actually attempted.
// `consume: false` leaves the body unread so a test can assert on bodyUsed.
async function runCombo(responders, { models = ["p1/first", "p2/second"], consume = true, signal = null } = {}) {
  const attempted = [];
  const seenSignals = [];
  const response = await handleComboChat({
    body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
    models,
    handleSingleModel: async (_body, modelStr, opts) => {
      attempted.push(modelStr);
      seenSignals.push(opts?.signal ?? null);
      return responders[modelStr]();
    },
    log: silentLog,
    comboName: "combo",
    comboStrategy: "fallback",
    signal,
  });
  return { attempted, seenSignals, response, text: consume ? await response.text() : null };
}

describe("combo failover on empty-but-successful streams (#3463)", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("falls over when the first model returns HTTP 200 with zero meaningful frames", async () => {
    const { attempted, text } = await runCombo({
      "p1/first": () => sseResponse([": keepalive\n\n"]),
      "p2/second": () => sseResponse(['data: {"choices":[{"delta":{"content":"real answer"}}]}\n\n']),
    });

    expect(attempted).toEqual(["p1/first", "p2/second"]);
    expect(text).toContain("real answer");
  });

  it("falls over when the stream closes without sending a single byte", async () => {
    const { attempted, text } = await runCombo({
      "p1/first": () => sseResponse([]),
      "p2/second": () => sseResponse(['data: {"choices":[{"delta":{"content":"second model"}}]}\n\n']),
    });

    expect(attempted).toEqual(["p1/first", "p2/second"]);
    expect(text).toContain("second model");
  });

  it("reports 503 when every combo model returns an empty stream", async () => {
    const { attempted, response } = await runCombo({
      "p1/first": () => sseResponse([": ping\n\n"]),
      "p2/second": () => sseResponse([]),
    });

    expect(attempted).toEqual(["p1/first", "p2/second"]);
    expect(response.status).toBe(503);
  });

  it("returns the first model untouched when it does send content", async () => {
    const { attempted, text } = await runCombo({
      "p1/first": () => sseResponse(['data: {"choices":[{"delta":{"content":"first wins"}}]}\n\n']),
      "p2/second": () => sseResponse(['data: {"choices":[{"delta":{"content":"must not run"}}]}\n\n']),
    });

    expect(attempted).toEqual(["p1/first"]);
    expect(text).toContain("first wins");
    expect(text).not.toContain("must not run");
  });

  it("replays every byte, including frames that precede the first meaningful one", async () => {
    const { text } = await runCombo({
      "p1/first": () => sseResponse([
        ": warmup\n\n",
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"body text"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      "p2/second": () => sseResponse([]),
    });

    expect(text).toContain(": warmup");
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain("body text");
    expect(text).toContain("[DONE]");
  });

  it("replays upstream bytes verbatim when the preamble is not valid UTF-8", async () => {
    const invalidPreamble = new Uint8Array([0x3a, 0x20, 0xff, 0xfe, 0x0a, 0x0a]);
    const contentFrame = encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    const raw = new Uint8Array([...invalidPreamble, ...contentFrame]);

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(invalidPreamble);
        controller.enqueue(contentFrame);
        controller.close();
      },
    });

    const response = await handleComboChat({
      body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["p1/first", "p2/second"],
      handleSingleModel: async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      log: silentLog,
      comboName: "combo",
      comboStrategy: "fallback",
    });

    const received = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(raw));
  });

  it("fails over on a usage-only terminal frame with zero output tokens", async () => {
    const { attempted, text } = await runCombo({
      "p1/first": () => sseResponse([
        'data: {"usage":{"prompt_tokens":12,"completion_tokens":0}}\n\n',
        "data: [DONE]\n\n",
      ]),
      "p2/second": () => sseResponse(['data: {"choices":[{"delta":{"content":"rescued"}}]}\n\n']),
    });

    expect(attempted).toEqual(["p1/first", "p2/second"]);
    expect(text).toContain("rescued");
  });

  it("accepts a usage frame reporting output tokens as content", async () => {
    const { attempted } = await runCombo({
      "p1/first": () => sseResponse(['data: {"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n']),
      "p2/second": () => sseResponse(['data: {"choices":[{"delta":{"content":"must not run"}}]}\n\n']),
    });

    expect(attempted).toEqual(["p1/first"]);
  });

  it("passes the stream through once the peek byte budget is exhausted", async () => {
    const filler = `: ${"x".repeat(8 * 1024)}\n\n`;
    const chunks = Array.from({ length: 48 }, () => filler);

    const { attempted, text } = await runCombo({
      "p1/first": () => sseResponse(chunks),
      "p2/second": () => sseResponse(['data: {"choices":[{"delta":{"content":"must not run"}}]}\n\n']),
    });

    expect(attempted).toEqual(["p1/first"]);
    expect(text.length).toBe(filler.length * chunks.length);
    expect(text).not.toContain("must not run");
  });

  it("leaves non-SSE responses alone so tts/search/image combos are unaffected", async () => {
    const { attempted, text } = await runCombo({
      "p1/first": () => jsonResponse({}),
      "p2/second": () => jsonResponse({ should: "not run" }),
    });

    expect(attempted).toEqual(["p1/first"]);
    expect(text).toBe("{}");
  });

  it("does not consume a non-stream JSON completion body", async () => {
    const { attempted, response } = await runCombo({
      "p1/first": () => jsonResponse({ choices: [{ message: { content: "json answer" } }] }),
      "p2/second": () => jsonResponse({ should: "not run" }),
    }, { consume: false });

    expect(attempted).toEqual(["p1/first"]);
    expect(response.bodyUsed).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "json answer" } }],
    });
  });
});

describe("combo empty-stream guard honors caller abort (#3463)", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("never starts a model when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const response = await handleComboChat({
      body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["p1/first", "p2/second"],
      handleSingleModel: async () => { calls++; return sseResponse([]); },
      log: silentLog,
      comboName: "combo",
      comboStrategy: "fallback",
      signal: controller.signal,
    });

    expect(calls).toBe(0);
    expect(response.status).toBe(499);
  });

  it("aborts a hanging peek, cancels the reader, and never tries the next model", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let keepAliveTimer = null;
    const hanging = new Response(
      new ReadableStream({
        start(c) {
          keepAliveTimer = setInterval(() => {
            try { c.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
          }, 10);
        },
        cancel() { cancelled = true; clearInterval(keepAliveTimer); },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );

    const attempted = [];
    const response = await handleComboChat({
      body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["p1/hang", "p2/second"],
      handleSingleModel: async (_body, modelStr) => {
        attempted.push(modelStr);
        if (modelStr === "p1/hang") {
          setTimeout(() => controller.abort(), 50);
          return hanging;
        }
        return sseResponse(['data: {"choices":[{"delta":{"content":"must not run"}}]}\n\n']);
      },
      log: silentLog,
      comboName: "combo",
      comboStrategy: "fallback",
      signal: controller.signal,
    });
    clearInterval(keepAliveTimer);

    expect(attempted).toEqual(["p1/hang"]);
    expect(response.status).toBe(499);
    expect(cancelled).toBe(true);
  });

  it("forwards the caller signal to each model attempt", async () => {
    const controller = new AbortController();
    const { seenSignals } = await runCombo(
      { "p1/first": () => sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']) },
      { models: ["p1/first"], signal: controller.signal },
    );

    expect(seenSignals).toEqual([controller.signal]);
  });
});

describe("combo empty-stream guard is time-bounded (#3463)", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("uses a default bound at or below 60s (shorter of existing timeouts, no new setting)", () => {
    expect(Math.min(FETCH_CONNECT_TIMEOUT_MS, STREAM_FIRST_CHUNK_TIMEOUT_MS)).toBeLessThanOrEqual(60 * 1000);
  });

  it("gives up on a keepalive-only stream instead of blocking forever", async () => {
    vi.resetModules();
    process.env.STREAM_FIRST_CHUNK_TIMEOUT_MS = "150";
    process.env.FETCH_CONNECT_TIMEOUT_MS = "150";
    try {
      const { handleComboChat: freshCombo } = await import("../../open-sse/services/combo.js");

      let keepAliveTimer = null;
      const neverEnding = new Response(
        new ReadableStream({
          start(controller) {
            keepAliveTimer = setInterval(() => {
              try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
            }, 10);
          },
          cancel() { clearInterval(keepAliveTimer); },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );

      const attempted = [];
      const started = Date.now();
      const response = await freshCombo({
        body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["p1/hang", "p2/second"],
        handleSingleModel: async (_body, modelStr) => {
          attempted.push(modelStr);
          if (modelStr === "p1/hang") return neverEnding;
          return sseResponse(['data: {"choices":[{"delta":{"content":"rescued"}}]}\n\n']);
        },
        log: silentLog,
        comboName: "combo",
        comboStrategy: "fallback",
      });
      const elapsed = Date.now() - started;
      clearInterval(keepAliveTimer);

      expect(attempted).toEqual(["p1/hang", "p2/second"]);
      expect(await response.text()).toContain("rescued");
      expect(elapsed).toBeLessThan(3000);
    } finally {
      delete process.env.STREAM_FIRST_CHUNK_TIMEOUT_MS;
      delete process.env.FETCH_CONNECT_TIMEOUT_MS;
      vi.resetModules();
    }
  });
});

describe("production chat caller threads the request signal into combo (#3463)", () => {
  it("src/sse/handlers/chat.js passes request.signal to every handleComboChat call", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../../src/sse/handlers/chat.js"), "utf8");
    const calls = src.split("handleComboChat({").length - 1;
    expect(calls).toBeGreaterThan(0);
    const wired = (src.match(/handleComboChat\(\{[^}]*?signal:\s*request\?\.signal[^}]*?\}\)/gs) || []).length;
    expect(wired).toBe(calls);
  });
});
