import { describe, expect, it, vi } from "vitest";

import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";

// Minimal stream controller stub
function makeController() {
  let connected = true;
  const abort = new AbortController();
  return {
    signal: abort.signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { connected = false; abort.abort(); },
  };
}

function makeUpstream() {
  return { getWriter: () => ({ abort: () => Promise.resolve() }) };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function readAll(stream, timeoutMs = 5000) {
  const reader = stream.getReader();
  try {
    let text = "";
    let pings = 0;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error("timed out waiting for stream");
      const { value, done } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      text += s;
      if (s.includes(": ping")) pings++;
    }
    text += dec.decode();
    return { text, pings };
  } finally {
    reader.releaseLock();
  }
}

describe("downstream keepalive", () => {
  it("preserves every real chunk when a read settles behind a queued keepalive", async () => {
    vi.useFakeTimers();
    let input;
    let reader;
    const upstream = new ReadableStream({ start(c) { input = c; } });
    const out = createDisconnectAwareStream(
      { readable: upstream, writable: makeUpstream() },
      makeController(),
      null,
      15
    );
    try {
      // Không đọc downstream: ping lấp hàng đợi, nhưng read upstream vẫn đang chờ.
      await vi.advanceTimersByTimeAsync(15);
      input.enqueue(enc.encode("data: first\n\n"));
      input.enqueue(enc.encode("data: second\n\n"));
      input.close();
      await vi.advanceTimersByTimeAsync(0);

      reader = out.getReader();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
      expect(text).toContain(": ping\n\n");
      expect(text.replaceAll(": ping\n\n", "")).toBe("data: first\n\ndata: second\n\n");
    } finally {
      if (reader) {
        await reader.cancel();
        reader.releaseLock();
      } else {
        await out.cancel();
      }
      vi.useRealTimers();
    }
  });

  it("emits SSE comment pings while upstream is silent, then the real chunk", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(enc.encode("data: hello\n\n"));
          controller.close();
        }, 80);
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: makeUpstream() },
      makeController(),
      null,
      15
    );

    const { text, pings } = await readAll(out);
    expect(pings).toBeGreaterThan(0);
    expect(text).toContain("data: hello");
  });

  it("sends no ping when the stream completes before the interval", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode("data: hi\n\n"));
        controller.close();
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: makeUpstream() },
      makeController(),
      null,
      10_000
    );

    const { text, pings } = await readAll(out);
    expect(text).toBe("data: hi\n\n");
    expect(pings).toBe(0);
  });

  it("sends no ping after the stream closed", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode("data: hi\n\n"));
        controller.close();
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: makeUpstream() },
      makeController(),
      null,
      10
    );

    const { text, pings } = await readAll(out);
    expect(text).toBe("data: hi\n\n");
    expect(pings).toBe(0);
    // Interval must be torn down with the stream: wait past two intervals,
    // the reader stays done and no ping can arrive late.
    await new Promise((r) => setTimeout(r, 40));
    const reader = out.getReader();
    const next = await reader.read();
    expect(next.done).toBe(true);
    expect(pings).toBe(0);
  });
});
