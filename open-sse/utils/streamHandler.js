// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS, STREAM_KEEPALIVE_INTERVAL_MS } from "../config/runtimeConfig.js";
import { SSE_KEEPALIVE_COMMENT } from "./sseConstants.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Shared keep-alive bytes (constant SSE comment, safe to reuse across streams).
const keepaliveBytes = new TextEncoder().encode(SSE_KEEPALIVE_COMMENT);

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model, reqTag = "" } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      // Debug-only: Responses API has no [DONE] sentinel, so codex/droid close the
      // socket on every completed request. "📊 done" is the authoritative outcome line.
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally (no line here — "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 *
 * @param {function} [onAbortTerminal] - Receives a human-readable abort
 * message and returns terminal SSE bytes to emit downstream.
 * @param {number} [keepAliveIntervalMs] - Emit an SSE comment downstream when the
 * transform output is silent this long. Wire bytes only; never resets upstream stall.
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null, keepAliveIntervalMs = STREAM_KEEPALIVE_INTERVAL_MS) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  const keepAliveMs = Number(keepAliveIntervalMs);
  let terminalEmitted = false;

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch { /* best-effort terminal */ }
  };

  let abortListener = null;
  const abortPromise = new Promise((resolve) => {
    if (streamController.signal?.aborted) {
      resolve({ aborted: true });
      return;
    }
    abortListener = () => resolve({ aborted: true });
    if (typeof streamController.signal?.addEventListener === "function") {
      streamController.signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  // One pull at a time: a new pull only starts after the previous Promise.race
  // settles, so a single outer timer slot is safe (no overwrite leak). The
  // finally below always clears it, including on upstream error/abort paths.
  let keepAliveTimer = null;
  const clearKeepAliveTimer = () => {
    if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
  };

  const cleanup = () => {
    if (abortListener && typeof streamController.signal?.removeEventListener === "function") {
      streamController.signal.removeEventListener("abort", abortListener);
      abortListener = null;
    }
    clearKeepAliveTimer();
  };

  // Single outstanding transform read shared across pulls. A keep-alive timeout
  // may win the race while the read is still pending — the same promise is then
  // re-awaited on the next pull so the chunk is never dropped.
  let pendingRead = null;
  const getPendingRead = () => {
    if (!pendingRead) {
      pendingRead = reader.read();
    }
    return pendingRead;
  };
  const dropPendingRead = () => {
    if (pendingRead) {
      pendingRead.catch(() => {});
      pendingRead = null;
    }
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected() || streamController.signal?.aborted) {
        cleanup();
        dropPendingRead();
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});
        emitTerminal(controller);
        try { controller.close(); } catch {}
        return;
      }

      try {
        let readResult;
        try {
          if (Number.isFinite(keepAliveMs) && keepAliveMs > 0) {
            const keepAlivePromise = new Promise((resolve) => {
              keepAliveTimer = setTimeout(() => resolve({ keepAlive: true }), keepAliveMs);
              if (keepAliveTimer.unref) keepAliveTimer.unref();
            });
            readResult = await Promise.race([getPendingRead(), abortPromise, keepAlivePromise]);
          } else {
            readResult = await Promise.race([getPendingRead(), abortPromise]);
          }
        } finally {
          clearKeepAliveTimer();
        }

        if (readResult?.keepAlive) {
          // Transform output silent for one interval: wire bytes only. Upstream
          // stall timing is untouched (measured on raw upstream bytes elsewhere).
          if (!streamController.isConnected() || streamController.signal?.aborted) {
            cleanup();
            dropPendingRead();
            reader.cancel().catch(() => {});
            writer.abort().catch(() => {});
            emitTerminal(controller);
            try { controller.close(); } catch {}
            return;
          }
          try { controller.enqueue(keepaliveBytes); } catch { /* downstream closed */ }
          return;
        }

        if (readResult?.aborted || !streamController.isConnected()) {
          cleanup();
          dropPendingRead();
          reader.cancel().catch(() => {});
          writer.abort().catch(() => {});
          emitTerminal(controller);
          try { controller.close(); } catch {}
          return;
        }

        const { done, value } = readResult;

        if (done) {
          cleanup();
          dropPendingRead();
          streamController.handleComplete();
          controller.close();
          return;
        }
        controller.enqueue(value);
        dropPendingRead();
      } catch (error) {
        cleanup();
        dropPendingRead();
        const wasConnected = streamController.isConnected();
        // Controller already closed = downstream ended; not an upstream error, skip noisy log.
        const msg0 = error?.message || "";
        const isControllerClosed = msg0.includes("already closed") || msg0.includes("Invalid state");
        if (!isControllerClosed) streamController.handleError(error);
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});

        // Treat network resets / socket hang up / abort as graceful close
        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isNetworkClose =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        // Graceful close on network/abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
        try {
          if (!wasConnected || isNetworkClose || onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) { /* already closed or cancelled */ }
      }
    },

    cancel(reason) {
      cleanup();
      dropPendingRead();
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel().catch(() => {});
      writer.abort().catch(() => {});
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(
  providerResponse,
  transformStream,
  streamController,
  onAbortTerminal = null,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
  clientStallTimeoutMs = null
) {
  let stallTimer = null;
  let clientStallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  let abortMessage = "upstream connection lost";
  const t0 = Date.now();
  const tag = "STREAM";

  const clearStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    if (clientStallTimer) { clearTimeout(clientStallTimer); clientStallTimer = null; }
  };

  const armStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (clientStallTimer) { clearTimeout(clientStallTimer); clientStallTimer = null; }
      if (abortMessage === "upstream connection lost") abortMessage = "stream stall timeout";
      dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      streamController.handleError?.(new Error("stream stall timeout"));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  const armClientStall = () => {
    if (!clientStallTimeoutMs) return;
    if (clientStallTimer) { clearTimeout(clientStallTimer); clientStallTimer = null; }
    clientStallTimer = setTimeout(() => {
      clientStallTimer = null;
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      if (abortMessage === "upstream connection lost") abortMessage = "client event stall timeout";
      dbg(tag, `CLIENT EVENT STALL TIMEOUT ${clientStallTimeoutMs}ms`);
      streamController.handleError?.(new Error("client event stall timeout"));
      if (typeof streamController.abort === "function") {
        streamController.abort();
      } else if (typeof streamController.handleDisconnect === "function") {
        streamController.handleDisconnect("client event stall timeout");
      }
    }, clientStallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => { dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleComplete(); },
    handleError: (e) => { dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleError(e); },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleDisconnect(r); },
    abort: () => { clearStall(); streamController.abort(); }
  };

  armStall();
  armClientStall();
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms | clientTimeout=${clientStallTimeoutMs || "none"}`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() {
      // Upstream EOF only ends raw bytes; downstream timer survives until downstream flush.
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`);
    }
  });

  const decoder = new TextDecoder();
  let downstreamBuffer = "";
  const downstreamTap = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (!clientStallTimeoutMs) return;
      const text = decoder.decode(chunk, { stream: true });
      downstreamBuffer += text;
      let textToNormalize = downstreamBuffer;
      let trailingCR = "";
      if (textToNormalize.endsWith("\r")) {
        trailingCR = "\r";
        textToNormalize = textToNormalize.slice(0, -1);
      }
      const normalized = textToNormalize.replace(/\r\n/g, "\n");
      // Complete SSE event ends with a double newline and must contain data: line (not just comments/keepalive)
      if (normalized.includes("\n\n")) {
        const parts = normalized.split("\n\n");
        downstreamBuffer = (parts.pop() || "") + trailingCR;
        for (const frame of parts) {
          const lines = frame.split("\n");
          const hasData = lines.some(l => l.trim().startsWith("data:"));
          if (lines.some(l => l.trim().startsWith("event:")) && !hasData) continue;
          if (hasData) {
            const dataLines = lines.filter(l => l.trim().startsWith("data:"));
            const hasPayload = dataLines.some(l => {
              const payload = l.slice(l.indexOf("data:") + 5).trim();
              if (!payload) return false;
              if (payload === "[DONE]") return true;
              if (payload.startsWith(":")) return false;
              return true;
            });
            const hasEventField = lines.some(l => l.trim().startsWith("event:"));
            if (hasPayload || hasEventField) armClientStall();
          }
        }
      } else {
        downstreamBuffer = normalized + trailingCR;
      }
    },
    flush() {
      clearStall();
    }
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream)
    .pipeThrough(downstreamTap);

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    onAbortTerminal ? () => onAbortTerminal(abortMessage) : null
  );
}

