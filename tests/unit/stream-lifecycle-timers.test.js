import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const { pipeWithDisconnect, createStreamController } = await import(
  "../../open-sse/utils/streamHandler.js"
);

function fakeProviderResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        }
        controller.close();
      },
    }),
  };
}

function identityPipe() {
  return new TransformStream();
}

function silentController(options = {}) {
  return createStreamController({
    provider: "test",
    model: "m",
    log: { line: vi.fn(), errorLine: vi.fn() },
    ...options,
  });
}

async function drain(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("pipeWithDisconnect lifecycle timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("upstream EOF clears only raw timer; downstream timer survives until downstream flush", async () => {
    const ctrl = silentController();
    const abortSpy = vi.spyOn(ctrl, "abort");
    const out = pipeWithDisconnect(
      fakeProviderResponse(['data: {"ok":true}\n\n']),
      identityPipe(),
      ctrl,
      null,
      1000,
      5000
    );
    const done = drain(out);
    await vi.advanceTimersByTimeAsync(1500);
    // Upstream EOF arrived immediately, so the short raw timeout must not fire.
    expect(abortSpy).not.toHaveBeenCalled();
    await done;
    // After full downstream completion both timers clear; advancing never aborts.
    await vi.advanceTimersByTimeAsync(20000);
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("closed stream after EOF never errors downstream", async () => {
    const ctrl = silentController();
    const errSpy = vi.fn();
    ctrl.handleError = errSpy;
    const out = pipeWithDisconnect(
      fakeProviderResponse([
        'data: {"a":1}\n\n',
        ": keepalive\n\n",
        "data:\n\n",
      ]),
      identityPipe(),
      ctrl,
      null,
      60000,
      1000
    );
    const done = drain(out);
    await done;
    await vi.advanceTimersByTimeAsync(1500);
    expect(errSpy).not.toHaveBeenCalled();
    expect(ctrl.isConnected()).toBe(false);
  });

  it("comments and empty data do not reset event timer on an open stream", async () => {
    const ctrl = silentController();
    const errSpy = vi.fn();
    ctrl.handleError = errSpy;
    const encoder = new TextEncoder();
    let bodyController;
    const body = new ReadableStream({
      start(c) {
        bodyController = c;
        c.enqueue(encoder.encode('data: {"start":1}\n\n'));
      }
    });

    const out = pipeWithDisconnect(
      { body },
      identityPipe(),
      ctrl,
      null,
      60000,
      1000
    );

    const reader = out.getReader();
    const read1 = await reader.read();
    expect(read1.done).toBe(false);

    // Send comment keepalive at 400ms - must NOT reset client timer
    await vi.advanceTimersByTimeAsync(400);
    bodyController.enqueue(encoder.encode(": keepalive\n\n"));
    const read2 = await reader.read();
    expect(read2.done).toBe(false);

    // Send empty data at 700ms - must NOT reset client timer
    await vi.advanceTimersByTimeAsync(300);
    bodyController.enqueue(encoder.encode("data:\n\n"));
    const read3 = await reader.read();
    expect(read3.done).toBe(false);

    // Send only colon-prefixed payload at 850ms - must NOT reset client timer
    await vi.advanceTimersByTimeAsync(150);
    bodyController.enqueue(encoder.encode("data: :ignored\n\n"));
    const read4 = await reader.read();
    expect(read4.done).toBe(false);

    // At 1000ms from start (150ms later), timer should fire because no real event occurred
    expect(errSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0].message).toBe("client event stall timeout");

    // Clean up
    try { bodyController.close(); } catch {}
  });

  it("delayed legitimate event at t>0 resets timer and extends deadline beyond original", async () => {
    const ctrl = silentController();
    const errSpy = vi.fn();
    ctrl.handleError = errSpy;
    const encoder = new TextEncoder();
    let bodyController;
    const body = new ReadableStream({
      start(c) {
        bodyController = c;
        c.enqueue(encoder.encode('data: {"first":1}\n\n'));
      }
    });

    const out = pipeWithDisconnect(
      { body },
      identityPipe(),
      ctrl,
      null,
      60000,
      1000
    );

    const reader = out.getReader();
    await reader.read();

    // Advance to 600ms (original deadline was 1000ms)
    await vi.advanceTimersByTimeAsync(600);
    expect(errSpy).not.toHaveBeenCalled();

    // Emit second valid event at 600ms - resets deadline to 600 + 1000 = 1600ms
    bodyController.enqueue(encoder.encode('data: {"second":2}\n\n'));
    await reader.read();

    // Advance past initial deadline (1000ms) to 1200ms -> should NOT fire
    await vi.advanceTimersByTimeAsync(600);
    expect(errSpy).not.toHaveBeenCalled();

    // Advance past new deadline (1600ms) to 1700ms -> should fire exactly once
    await vi.advanceTimersByTimeAsync(500);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0].message).toBe("client event stall timeout");

    try { bodyController.close(); } catch {}
  });

  it("handles EVERY CRLF boundary split including CR at end of chunk and resets event timer", async () => {
    const ctrl = silentController();
    const errSpy = vi.fn();
    ctrl.handleError = errSpy;
    const encoder = new TextEncoder();
    let bodyController;
    const body = new ReadableStream({
      start(c) {
        bodyController = c;
      }
    });

    const out = pipeWithDisconnect(
      { body },
      identityPipe(),
      ctrl,
      null,
      60000,
      1000
    );

    const reader = out.getReader();

    // Split 1: chunk ending with \r, followed by \n\r\ndata: ...
    bodyController.enqueue(encoder.encode("data: 1\r"));
    // Advance to 500ms
    await vi.advanceTimersByTimeAsync(500);
    expect(errSpy).not.toHaveBeenCalled();

    // Second chunk arrives at 500ms with \n finishing the first event's line
    // and split in the double delimiter: \r\ndata: 2\r\n\r
    bodyController.enqueue(encoder.encode("\n\r\ndata: 2\r\n\r"));
    await reader.read();
    await reader.read();

    // Advance to 1100ms (past initial 1000ms). Reset at 500ms extends deadline to 1500ms.
    await vi.advanceTimersByTimeAsync(600);
    expect(errSpy).not.toHaveBeenCalled();

    // Third chunk arrives at 1100ms with single \n completing delimiter
    bodyController.enqueue(encoder.encode("\n"));
    await reader.read();

    // Advance to 1700ms (past 1500ms). Reset at 1100ms extends deadline to 2100ms.
    await vi.advanceTimersByTimeAsync(600);
    expect(errSpy).not.toHaveBeenCalled();

    // Advance past 2100ms to 2200ms -> should expire
    await vi.advanceTimersByTimeAsync(500);
    expect(errSpy).toHaveBeenCalledTimes(1);

    try { bodyController.close(); } catch {}
  });

  it("upstream EOF with pending transform flush keeps client timer until downstream flush", async () => {
    const ctrl = silentController();
    const errSpy = vi.fn();
    ctrl.handleError = errSpy;

    // Transform stream that holds chunk until flush()
    let bufferedChunk = null;
    const delayedTransform = new TransformStream({
      transform(chunk) {
        bufferedChunk = chunk;
      },
      flush(controller) {
        if (bufferedChunk) controller.enqueue(bufferedChunk);
      }
    });

    let bodyController;
    const body = new ReadableStream({
      start(c) {
        bodyController = c;
        c.enqueue(new TextEncoder().encode('data: {"delayed":true}\n\n'));
      }
    });

    const out = pipeWithDisconnect(
      { body },
      delayedTransform,
      ctrl,
      null,
      60000,
      1000
    );

    const reader = out.getReader();
    // Upstream sends chunk, delayedTransform holds it without forwarding yet.
    // Close upstream body to trigger upstreamTap flush (upstream EOF)
    bodyController.close();

    // Advance to 500ms - raw timer was cleared by upstream EOF, but client timer must survive!
    await vi.advanceTimersByTimeAsync(500);
    expect(errSpy).not.toHaveBeenCalled();

    // Read downstream - this pulls through delayedTransform which flushes and downstream receives it
    const read = await reader.read();
    expect(read.done).toBe(false);

    // Reading finished downstream stream, now close reader
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("peer-timer winner cleanup: first timer to fire cancels the other, producing single error", async () => {
    const ctrl = silentController();
    const errSpy = vi.fn();
    ctrl.handleError = errSpy;

    // Raw timer 1000ms, client timer 2000ms
    const out = pipeWithDisconnect(
      { body: new ReadableStream({ start() {} }) },
      identityPipe(),
      ctrl,
      null,
      1000,
      2000
    );

    const reader = out.getReader();
    // Advance past raw timer (1000ms)
    await vi.advanceTimersByTimeAsync(1200);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0].message).toBe("stream stall timeout");

    // Advance past client timer (2000ms)
    await vi.advanceTimersByTimeAsync(1500);
    // Must NOT have called handleError a second time
    expect(errSpy).toHaveBeenCalledTimes(1);

    await out.cancel().catch(() => {});
  });

  it("abort settlement even if cancel never resolves", async () => {
    vi.useRealTimers();
    const ctrl = silentController();
    const hangingCancelBody = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"hang":true}\n\n'));
      },
      pull() {
        return new Promise(() => {}); // never resolves
      },
      cancel() {
        return new Promise(() => {}); // never resolves
      }
    });

    let terminalCalled = 0;
    const onAbortTerminal = () => {
      terminalCalled++;
      return new TextEncoder().encode("event: error\ndata: {}\n\n");
    };

    const out = pipeWithDisconnect(
      { body: hangingCancelBody },
      identityPipe(),
      ctrl,
      onAbortTerminal,
      100000,
      null
    );

    const reader = out.getReader();
    const firstRead = await reader.read();
    expect(firstRead.done).toBe(false);

    // Call abort on controller while pull is pending
    ctrl.handleDisconnect("client_closed");
    ctrl.abort();

    // Read should settle promptly with terminal payload, not hang
    const abortRead = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("read hung on abort")), 1000))
    ]);
    expect(abortRead.done).toBe(false);
    expect(new TextDecoder().decode(abortRead.value)).toContain("event: error");
    expect(terminalCalled).toBe(1);

    // Cancel reader - must resolve promptly despite hangingCancelBody
    await Promise.race([
      reader.cancel(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("cancel hung")), 1000))
    ]);

    expect(ctrl.isConnected()).toBe(false);
    vi.useFakeTimers();
  });
});
