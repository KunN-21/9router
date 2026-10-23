/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse, clientStatusForBreakerOpen } from "../utils/error.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { STREAM_FIRST_CHUNK_TIMEOUT_MS, HTTP_STATUS } from "../config/runtimeConfig.js";
import { ERROR_TYPES } from "../config/errorConfig.js";
import { parseModel } from "./model.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import { inspectSSELine, isNoRetryFinish } from "./emptyFailover.js";
import {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.js";

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Content types whose bodies the empty-stream guard is allowed to touch.
// combo.js is shared with tts/search/image/fetch, whose 200s are audio, images
// or plain JSON — reading those would consume a body the caller still needs.
const SSE_CONTENT_TYPE = "text/event-stream";

// Byte budget for the empty-stream peek. Bounds how much of a chatty
// non-content stream is buffered for replay before the guard gives up and
// passes the stream through. 256 KiB is far above any real preamble.
const PEEK_MAX_BYTES = 256 * 1024;

// Empty-stream peek bound. Post-header content wait uses the first-content
// constant directly: the connect timer is cleared when headers arrive, so it
// never fires against the body wait.
// No new setting introduced. Streams that already carry content resolve on
// the first content frame, not on this bound.
function peekTimeoutMs() {
  return STREAM_FIRST_CHUNK_TIMEOUT_MS;
}

// Map error code or type to a standard HTTP status code
function statusFromErrorCodeOrType(code, type, message = "") {
  const num = Number(code);
  if (Number.isFinite(num) && num >= 400 && num <= 599) return num;

  const codeStr = String(code || "").toLowerCase();
  const typeStr = String(type || "").toLowerCase();
  const msgStr = String(message || "").toLowerCase();

  if (codeStr.includes("rate_limit") || codeStr.includes("quota") ||
      typeStr.includes("rate_limit") || msgStr.includes("rate limit") || msgStr.includes("quota")) {
    return 429;
  }
  if (codeStr.includes("invalid_request") || typeStr.includes("invalid_request") ||
      codeStr.includes("invalid_param") || codeStr.includes("context_length")) {
    return 400;
  }
  if (codeStr.includes("auth") || typeStr.includes("auth") || codeStr.includes("api_key")) {
    return 401;
  }
  if (codeStr.includes("permission") || typeStr.includes("permission") || codeStr.includes("forbidden")) {
    return 403;
  }
  if (codeStr.includes("not_found") || typeStr.includes("not_found")) {
    return 404;
  }
  if (codeStr.includes("overloaded") || codeStr.includes("capacity") || msgStr.includes("capacity") || msgStr.includes("overloaded")) {
    return 503;
  }
  return 500;
}

// Extract error details from a parsed SSE frame or event
function extractFrameError(parsed, lastEvent = null) {
  if (!parsed || typeof parsed !== "object") return null;

  // 1. Explicit error property
  if (parsed.error) {
    const err = parsed.error;
    if (typeof err === "object") {
      const message = err.message || JSON.stringify(err);
      const type = err.type || (typeof err.status === "string" ? err.status : "server_error");
      const code = err.code ?? (typeof err.status === "number" ? err.status : undefined);
      const status = typeof err.status === "number" ? err.status
        : (typeof err.code === "number" ? err.code
        : statusFromErrorCodeOrType(code, type, message));
      return { message, type, code, status };
    }
    if (typeof err === "string" && err.length > 0) {
      return { message: err, type: "server_error", code: "upstream_error", status: 500 };
    }
  }

  // 2. Claude error event: { type: "error", error: { ... } }
  if (parsed.type === "error" && parsed.error) {
    const err = parsed.error;
    const message = err.message || JSON.stringify(err);
    const type = err.type || "server_error";
    const status = statusFromErrorCodeOrType(err.code, type, message);
    return { message, type, code: err.code, status };
  }

  // 3. OpenAI Responses API failure: response.failed or failed status
  const isFailedEvent = lastEvent === "response.failed" || parsed.type === "response.failed" || parsed.event === "response.failed";
  const isFailedStatus = parsed.response?.status === "failed" || parsed.status === "failed";
  if (isFailedEvent || isFailedStatus) {
    const err = parsed.response?.error || parsed.error || { message: "Upstream response failed", type: "server_error" };
    const message = err.message || JSON.stringify(err);
    const type = err.type || "server_error";
    const code = err.code || "response_failed";
    const status = typeof err.status === "number" ? err.status
      : (typeof code === "number" ? code
      : statusFromErrorCodeOrType(code, type, message));
    return { message, type, code, status };
  }

  // 4. event: error with generic payload
  if (lastEvent === "error") {
    const message = parsed.message || (typeof parsed === "string" ? parsed : JSON.stringify(parsed));
    return { message, type: parsed.type || "server_error", code: parsed.code, status: 500 };
  }

  return null;
}

function extractFrameErrorFromLine(line, lastEvent = null) {
  if (!line || !line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload);
    return extractFrameError(parsed, lastEvent);
  } catch {
    if (lastEvent === "error" || lastEvent === "response.failed") {
      return { message: payload || `Upstream stream ${lastEvent}`, type: "server_error", code: lastEvent, status: 500 };
    }
    return null;
  }
}

// Does an SSE data frame carry output the client can actually render or act on?
//
// Deliberately stricter than "is this frame well-formed": role announcements,
// finish_reason, message envelopes and zero-token usage frames are all things a
// provider emits *around* an answer. A stream made only of those is precisely
// the empty stream #3463 is about, so none of them count as content on their own.
//
// Reasoning DOES count here, on purpose: a slow reasoning model that has been
// thinking for 90s is producing real work, and cutting it off mid-thought loses
// the turn (see the combo tests for slow reasoning streams).
function frameCarriesContent(line) {
  if (!line.startsWith("data:")) return false;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return false;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }

  // An error frame is never success content.
  if (extractFrameError(parsed)) return false;

  // A usage frame counts only if it reports generated output; a frame carrying
  // prompt tokens and completion_tokens: 0 is an accounting record, not an answer.
  if (hasOutputTokens(parsed.usage) || hasOutputTokens(parsed.response?.usage)) return true;

  // OpenAI chat: text or a tool call. Reasoning is NOT content here — see
  // frameCarriesReasoning and the mid-thought commit in the peek's tail.
  const delta = parsed.choices?.[0]?.delta;
  if (nonEmptyString(delta?.content)) return true;
  if (delta?.tool_calls?.length || delta?.function_call) return true;

  // Claude: only the delta events carry payload. message_start/content_block_start
  // are envelopes; a tool_use block start is the exception, since the tool name
  // arrives there and the arguments follow as input_json_delta.
  if (parsed.type === "content_block_delta") {
    const d = parsed.delta;
    if (nonEmptyString(d?.text) || nonEmptyString(d?.partial_json)) return true;
  }
  if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") return true;

  // OpenAI Responses API: output_text/function-call argument deltas, done text, item done, or completed output.
  // Complete payloads also count: message item done and completed output.
  if (typeof parsed.type === "string" && parsed.type.endsWith(".delta") && nonEmptyString(parsed.delta)) {
    if (!parsed.type.startsWith("response.reasoning")) return true;
  }
  if (parsed.type === "response.output_text.done" && nonEmptyString(parsed.text)) return true;
  if (parsed.type === "response.content_part.done") {
    const part = parsed.part || parsed.content_part;
    if (nonEmptyString(part?.text)) return true;
  }
  if (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") {
    // A tool-call item is announced on `added` (name + call_id); either event
    // proves the model acted.
    if (parsed.item?.type === "function_call" || parsed.item?.type === "custom_tool_call") {
      if (parsed.item.name || parsed.item.call_id || parsed.item.arguments) return true;
    }
  }
  if (parsed.type === "response.output_item.done" && parsed.item?.type === "message") {
    const parts = parsed.item.content;
    if (Array.isArray(parts) && parts.some((p) => nonEmptyString(p?.text))) return true;
    if (nonEmptyString(parsed.item.text)) return true;
  }
  if (parsed.type === "response.completed" || parsed.type === "response.done") {
    const output = parsed.response?.output || parsed.output;
    if (Array.isArray(output) && output.some((item) => {
      if (item?.type === "message") {
        const parts = item.content;
        return (Array.isArray(parts) && parts.some((p) => nonEmptyString(p?.text))) || nonEmptyString(item.text);
      }
      if (item?.type === "function_call" || item?.type === "custom_tool_call") {
        return item.name || item.call_id || item.arguments;
      }
      return false;
    })) {
      return true;
    }
  }

  // Gemini: a candidate with a part that actually holds something.
  const parts = parsed.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.some((p) => nonEmptyString(p?.text) || p?.functionCall || p?.inlineData)) return true;

  // Ollama NDJSON.
  if (nonEmptyString(parsed.message?.content) || nonEmptyString(parsed.response)) return true;
  if (parsed.message?.tool_calls?.length) return true;

  return false;
}

function nonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// Reasoning is progress, not an answer: a slow reasoning model that has been
// thinking for 90s is doing real work, and cutting the turn off mid-thought loses
// it. But a turn that FINISHED having produced only reasoning is still empty, so
// this only feeds the "still thinking when the peek gave up" commit below.
function frameCarriesReasoning(line) {
  if (!line.startsWith("data:")) return false;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return false;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  if (extractFrameError(parsed)) return false;

  const delta = parsed.choices?.[0]?.delta;
  if (nonEmptyString(delta?.reasoning_content) || nonEmptyString(delta?.reasoning)) return true;
  if (parsed.type === "content_block_delta" && nonEmptyString(parsed.delta?.thinking)) return true;

  // Gemini thought parts.
  const parts = parsed.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.some((p) => p?.thought === true && nonEmptyString(p?.text))) return true;

  if (typeof parsed.type === "string" && parsed.type.startsWith("response.reasoning")) {
    if (nonEmptyString(parsed.delta) || nonEmptyString(parsed.text)) return true;
  }
  if (parsed.type === "response.output_item.done" && parsed.item?.type === "reasoning") {
    const summary = parsed.item.summary;
    return (Array.isArray(summary) && summary.some((p) => nonEmptyString(p?.text))) || nonEmptyString(parsed.item.text);
  }
  return false;
}

// Terminal markers across every client format: OpenAI chat finish_reason, Claude
// stop_reason, Responses completed/incomplete/failed, Claude message_stop.
const TERMINAL_MARKERS = ["finish_reason", "stop_reason", "incomplete", "completed", "failed", "message_stop"];

function looksTerminal(line) {
  return TERMINAL_MARKERS.some((marker) => line.includes(marker));
}

// Finish reason carried by one SSE data frame, normalized to the OpenAI vocabulary
// so isNoRetryFinish applies to every client format. Only frames that can carry a
// terminal are classified — the peek is on the request hot path.
function frameFinishReason(line) {
  if (!looksTerminal(line)) return null;
  return inspectSSELine(line)?.finishReason || null;
}

// Usage is proof of an answer only when it reports generated tokens. Mirrors the
// completion/output-token check rather than accepting any usage object, so a
// prompt-tokens-only record is not mistaken for output.
function hasOutputTokens(usage) {
  if (!usage || typeof usage !== "object") return false;
  const n = Number(
    usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0
  );
  return Number.isFinite(n) && n > 0;
}

/**
 * Read a streaming provider response until the first frame that carries content.
 *
 * A provider can return HTTP 200, open an SSE stream, emit only comments or
 * keepalives, and close cleanly. Deciding success from status alone hands that
 * unusable stream to the client and skips the remaining combo models (#3463).
 *
 * Returns { hasContent, body, timedOut, finishReason }. `body` replays every byte
 * already pulled off the socket and then continues from the live reader, so
 * nothing is dropped — the same re-assembly qoder.js uses for its own first-frame
 * peek. It is returned for an empty stream too, so a legitimately-empty finish
 * (content_filter) can be handed to the client as-is instead of being replaced by
 * a synthesized error. Non-SSE responses are reported as content without the
 * body being touched at all.
 *
 * The wait is bounded by peekTimeoutMs() (the shorter of the existing
 * FETCH_CONNECT_TIMEOUT_MS / STREAM_FIRST_CHUNK_TIMEOUT_MS): an upstream that
 * streams keepalives indefinitely is reported as having no content, so the combo
 * moves on instead of blocking here forever. Caller abort cancels the peek,
 * prevents subsequent fallback requests, and cancels the reader; every timer
 * and listener is cleaned up on settle.
 */
async function peekStreamForContent(response, { timeoutMs = peekTimeoutMs(), signal = null } = {}) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes(SSE_CONTENT_TYPE) || !response.body) {
    return { hasContent: true, body: null, timedOut: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  // Raw chunks are what gets replayed. Decoded text is used only for scanning:
  // re-encoding decoded text would rewrite any byte upstream sent that is not
  // valid UTF-8 into U+FFFD and corrupt the client's stream.
  const rawChunks = [];
  let rawBytes = 0;
  let pending = "";
  let currentEvent = null;
  let streamError = null;
  let hasContent = false;
  let sawReasoning = false;
  let finishReason = null;
  let upstreamDone = false;
  let timedOut = false;
  let settled = false;
  let timer = null;

  let abortResolve = null;
  const abortPromise = signal
    ? new Promise((resolve) => {
      abortResolve = resolve;
    })
    : null;
  const onAbort = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    reader.cancel(signal?.reason).catch(() => {});
    abortResolve?.("aborted");
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const cleanupAbort = signal ? () => signal.removeEventListener("abort", onAbort) : null;

  try {
    if (signal?.aborted) return { hasContent: false, body: null, timedOut: false, aborted: true };

    const readLoop = (async () => {
      try {
        for (;;) {
          if (settled) return "aborted";
          let readResult;
          try {
            readResult = abortPromise
              ? await Promise.race([reader.read(), abortPromise.then(() => ({ aborted: true }))])
              : await reader.read();
          } catch {
            // Treat a read failure as no content so the combo can try the next model.
            if (!settled) { settled = true; hasContent = false; }
            return "error";
          }
          if (settled) return "aborted";
          if (readResult?.aborted || signal?.aborted) { settled = true; return "aborted"; }
          const { done, value } = readResult;
          if (done) {
            upstreamDone = true;
            // A frame may sit in the tail without a trailing newline.
            pending += decoder.decode();
            const tail = pending.trim();
            if (tail) {
              const frameError = extractFrameErrorFromLine(tail, currentEvent);
              if (frameError) {
                streamError = frameError;
              } else if (frameCarriesContent(tail)) {
                hasContent = true;
              }
              finishReason = frameFinishReason(tail) || finishReason;
            }
            settled = true;
            return "done";
          }

          rawChunks.push(value);
          rawBytes += value.byteLength;
          pending += decoder.decode(value, { stream: true });

          // Only scan complete lines; a JSON frame split across chunks must not be
          // judged on its first half.
          let newline;
          while ((newline = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (!line) {
              currentEvent = null;
            }
            const frameError = extractFrameErrorFromLine(line, currentEvent);
            if (frameError) {
              streamError = frameError;
              break;
            }
            if (frameCarriesContent(line)) { hasContent = true; break; }
            finishReason = frameFinishReason(line) || finishReason;
          }
          if (streamError) { settled = true; return "error_frame"; }
          if (hasContent) { settled = true; return "content"; }

          // A provider can stream non-content frames at line rate. Without a byte
          // budget the buffer would grow for the whole timeout window, so stop
          // buffering and hand the stream over rather than risk the heap. Deciding
          // in the client's favour: a chatty stream is passed through, not failed.
          if (rawBytes >= PEEK_MAX_BYTES) {
            hasContent = true;
            settled = true;
            return "budget";
          }
        }
      } catch {
        // Treat a read failure as no content so the combo can try the next model.
        if (!settled) { settled = true; hasContent = false; }
        return "error";
      }
    })();

    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        settled = true;
        reader.cancel().catch(() => {});
        resolve("timeout");
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });
    const outcome = await Promise.race([readLoop, timeoutPromise]);

    if (outcome === "aborted" || signal?.aborted) {
      await reader.cancel(signal?.reason).catch(() => {});
      return { hasContent: false, body: null, timedOut: false, aborted: true };
    }
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    cleanupAbort?.();
  }

  if (streamError) {
    await reader.cancel().catch(() => {});
    return { hasContent: false, body: null, timedOut: false, error: streamError };
  }

  // Replay the buffered bytes, then continue from the live reader.
  const replayBody = () => new ReadableStream({
    start(controller) {
      for (const chunk of rawChunks) controller.enqueue(chunk);
      rawChunks.length = 0;
      if (upstreamDone) controller.close();
    },
    async pull(controller) {
      if (upstreamDone) return;
      try {
        const { done, value } = await reader.read();
        if (done) { upstreamDone = true; controller.close(); return; }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    }
  });

  if (!hasContent) {
    // Empty stream. Keep the bytes: a no-retry finish (content filter) must be
    // handed to the client exactly as the provider sent it.
    return { hasContent: false, body: replayBody(), timedOut, error: null, finishReason };
  }

  return { hasContent: true, body: replayBody(), timedOut: false, finishReason };
}

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  return models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime === "application/pdf") required.add("pdf");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput");
    if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput");
    if (t === "file" || t === "document" || t === "input_file") {
      // Infer modality from embedded mime when available; fall back to pdf for generic files.
      let fmime = null;
      if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`;
      else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1];
      if (fmime) addByMime(fmime);
      else required.add("pdf");
    }
    // gemini parts: inlineData/fileData carry a mime
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs
    if (typeof m.content === "string") {
      if (m.content.includes("data:image/")) required.add("vision");
      else if (m.content.includes("data:audio/")) required.add("audioInput");
      else if (m.content.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: temporarily disabled in auto-switch (feature not wired yet).

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) {
    comboRotationState.delete(comboName);
    clearStickyComboSession(comboName);
  } else {
    comboRotationState.clear();
    clearStickyComboSession();
  }
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Detect whether a 2xx JSON response contains zero usable content
 * (e.g. empty assistant message with in_progress/incomplete)
 * so combo fallback can continue to the next model.
 */
export function isZeroContentResponse(data) {
  if (!data || typeof data !== "object") return false;

  // OpenAI chat format
  if (Array.isArray(data.choices)) {
    if (data.choices.length === 0) return true;
    const choice = data.choices[0];
    if (!choice) return true;

    const msg = choice.message || choice.delta;
    const content = msg?.content;
    const hasContent = typeof content === "string" ? content.trim().length > 0 : (Array.isArray(content) && content.length > 0);
    const hasToolCalls = (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) || Boolean(msg?.function_call);
    const hasReasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content.trim().length > 0 : false;

    const finish = choice.finish_reason;
    const isNormalFinish = finish === "stop" || finish === "length" || finish === "tool_calls" || finish === "function_call";

    if (!hasContent && !hasToolCalls && !hasReasoning && (!isNormalFinish || finish === "in_progress" || finish === "incomplete")) {
      return true;
    }
  }

  // Anthropic messages format
  if (Array.isArray(data.content)) {
    const hasContent = data.content.some((c) => (c.type === "text" && c.text?.trim().length > 0) || c.type === "tool_use");
    const stopReason = data.stop_reason;
    if (!hasContent && (!stopReason || stopReason === "in_progress" || stopReason === "incomplete")) {
      return true;
    }
  }

  return false;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback", "round-robin", or "smart"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {boolean} [options.autoSwitch=true] - Capability auto-switching
 * @param {string|null} [options.sessionId=null] - Client session identifier for prompt cache retention
 * @param {string} [options.smartPolicy="smart"] - Policy: "smart" (adaptive ≥80%), "strict" (lock 1st model), "per-turn", or "custom"
 * @param {boolean} [options.sessionSticky=true] - Keep chosen model across session requests to retain prompt cache
 * @param {number} [options.confidenceThreshold=0.8] - Minimum confidence required for model switch (0-1)
 * @param {Function|null} [options.resolveSmartChoice=null] - Smart router resolver callback: (body, models) => Promise<{ choice, probabilities, confidence } | null>
 * @returns {Promise<Response>}
 */
export async function handleComboChat({
  body,
  models,
  handleSingleModel,
  log,
  comboName,
  comboStrategy,
  comboStickyLimit = 1,
  autoSwitch = true,
  signal = null,
  sessionId = null,
  smartPolicy = "smart",
  sessionSticky = true,
  confidenceThreshold = 0.8,
  resolveSmartChoice = null,
}) {
  let rotatedModels = models;
  let activeStickyModel = null;

  if (comboStrategy === "smart") {
    const policy = (typeof smartPolicy === "string" ? smartPolicy : "smart").toLowerCase();
    const isPerTurn = policy === "per-turn" || sessionSticky === false;
    const isStrict = policy === "strict";

    let switchThreshold = 0.8;
    if (policy === "custom") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    } else if (policy === "smart-switch-70") switchThreshold = 0.7;
    else if (policy === "smart-switch-90") switchThreshold = 0.9;
    else if (policy.startsWith("smart-switch") || policy === "smart") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    }

    if (!isPerTurn && sessionId) {
      activeStickyModel = getStickyComboModel(comboName, sessionId, models);
    }

    if (activeStickyModel) {
      if (isStrict) {
        // Strict Lock: re-use sticky model without invoking System One (0ms, 0 extra tokens)
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
        log.info("COMBO", `smart-router [strict] locked session "${sessionId}" → ${activeStickyModel}`);
      } else if (typeof resolveSmartChoice === "function") {
        // Smart Switch (Adaptive): check if the user's task drastically shifted
        try {
          const smartResult = await resolveSmartChoice(body, models);
          const newChoice = smartResult?.choice;
          const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

          if (newChoice && newChoice !== activeStickyModel && models.includes(newChoice) && conf !== null && conf >= switchThreshold) {
            // Task changed with high confidence: switch model and update session
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router [smart-switch] task changed → switched from ${activeStickyModel} to ${newChoice} (confidence: ${conf} >= ${switchThreshold})`);
            if (sessionId) {
              setStickyComboModel(comboName, sessionId, newChoice);
              activeStickyModel = newChoice;
            }
          } else {
            // Stay on current model to preserve warm prompt cache
            rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
            log.info("COMBO", `smart-router [smart-switch] retained prompt cache model "${activeStickyModel}"`);
          }
        } catch (err) {
          // Fail open to active sticky model
          rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
          log.warn("COMBO", `smart-router error, retained model "${activeStickyModel}"`, { error: err?.message || String(err) });
        }
      } else {
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
      }
    } else if (typeof resolveSmartChoice === "function") {
      // Turn 1 or per-turn: evaluate System One to select initial model
      try {
        const smartResult = await resolveSmartChoice(body, models);
        const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

        if (smartResult?.choice && models.includes(smartResult.choice)) {
          if (switchThreshold > 0 && conf !== null && conf < switchThreshold) {
            log.info("COMBO", `smart-router confidence (${conf}) below threshold (${switchThreshold}), fallback to order: [${models.join(", ")}]`);
          } else {
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router selected ${smartResult.choice} (confidence: ${conf ?? "N/A"})`);
            if (!isPerTurn && sessionId) {
              setStickyComboModel(comboName, sessionId, smartResult.choice);
              activeStickyModel = smartResult.choice;
            }
          }
        } else {
          log.info("COMBO", `smart-router no decision, fallback to order: [${models.join(", ")}]`);
        }
      } catch (err) {
        log.warn("COMBO", `smart-router error, fallback to order: [${models.join(", ")}]`, { error: err?.message || String(err) });
      }
    }
  } else {
    // Apply rotation strategy if enabled
    rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
  }

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastError = null;
  let lastErrorType = null;
  let lastErrorCode = null;
  let earliestRetryAfter = null;
  let lastStatus = null;
  let lastNoContentTimeout = false;
  let requestScopedResult = null;

  for (let i = 0; i < rotatedModels.length; i++) {
    // Synthetic-timeout state belongs to the current attempt only: clear it up
    // front so a prior timeout cannot leak type/code into a later throw,
    // typeless JSON error, or abort. lastStatus keeps its existing rules.
    lastNoContentTimeout = false;
    lastErrorType = null;
    lastErrorCode = null;
    if (signal?.aborted) {
      lastError = signal?.reason?.message || "Request aborted";
      if (!lastStatus) lastStatus = 499;
      break;
    }
    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      const result = await handleSingleModel(body, modelStr, { signal, skipSsePeek: true });
      if (signal?.aborted) {
        await result?.body?.cancel?.(signal?.reason).catch(() => {});
        lastError = signal?.reason?.message || "Request aborted";
        if (!lastStatus) lastStatus = 499;
        break;
      }

      // Success (2xx) — but a 200 is not proof of a usable answer. A provider can
      // open an SSE stream, send nothing but keepalives and close cleanly; that
      // must fall through to the next model rather than be handed to the client.
      if (result.ok) {
        const { hasContent, body: replayBody, timedOut, aborted, error: streamError, finishReason } = await peekStreamForContent(result, { signal });
        if (aborted || signal?.aborted) {
          await replayBody?.cancel?.(signal?.reason).catch(() => {});
          lastError = signal?.reason?.message || "Request aborted";
          if (!lastStatus) lastStatus = 499;
          break;
        }
        if (hasContent) {
          if (!replayBody) {
            // Non-SSE body (non-streaming JSON, audio, an image). A zero-content JSON
            // answer on a non-final seat is still not an answer — the next member may
            // serve the request. clone() keeps the caller's body readable either way.
            const isLastModel = i === rotatedModels.length - 1;
            const contentType = result.headers?.get?.("content-type") || "";
            if (!isLastModel && contentType.includes("application/json")) {
              try {
                const peekBody = await result.clone().json();
                if (isZeroContentResponse(peekBody)) {
                  log.warn("COMBO", `Model ${modelStr} returned HTTP 200 with zero usable content, falling back to next model`);
                  if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
                    clearStickyComboSession(comboName, sessionId);
                  }
                  lastError = "Zero usable content";
                  lastStatus = 200;
                  continue;
                }
              } catch {
                // Ignore JSON parse errors
              }
            }
            log.info("COMBO", `Model ${modelStr} succeeded`);
            return result;
          }
          log.info("COMBO", `Model ${modelStr} succeeded${timedOut ? " (peek deadline; committed)" : ""}`);
          return new Response(replayBody, {
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
          });
        }

        if (streamError) {
          const errStatus = streamError.status || 500;
          const errMsg = streamError.message || "Upstream stream error";
          const { shouldFallback, cooldownMs } = checkFallbackError(errStatus, errMsg);

          lastError = errMsg;
          lastErrorType = streamError.type || null;
          lastErrorCode = streamError.code || null;
          lastStatus = errStatus;

          if (!shouldFallback) {
            log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: errStatus, error: errMsg });
            return new Response(
              JSON.stringify({ error: { message: errMsg, ...(streamError.type ? { type: streamError.type } : {}), ...(streamError.code ? { code: streamError.code } : {}) } }),
              { status: errStatus, headers: { "Content-Type": "application/json" } }
            );
          }

          if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
              (errStatus === 503 || errStatus === 502 || errStatus === 504)) {
            log.info("COMBO", `Model ${modelStr} transient ${errStatus}, waiting ${cooldownMs}ms before next`);
            await new Promise(r => setTimeout(r, cooldownMs));
          }

          log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: errStatus, error: errMsg });
          continue;
        }

        // Empty generation. Fall through to the next candidate, except for a
        // legitimately empty class (content filter) which recurs on every member —
        // hand that stream back as-is.
        const reasonLabel = finishReason || "no-content";
        if (isNoRetryFinish(finishReason)) {
          log.warn("COMBO", `Model ${modelStr} returned empty (${reasonLabel}) — no-retry class, returning as-is`);
          return new Response(replayBody, {
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
          });
        }

        if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
          clearStickyComboSession(comboName, sessionId);
        }
        // Drain/close the discarded stream in the background so its usage logging still runs.
        replayBody?.cancel?.().catch(() => {});

        lastNoContentTimeout = timedOut === true && !finishReason;
        lastError = lastNoContentTimeout ? "provider timed out waiting for stream content" : `empty generation (${reasonLabel})`;
        lastStatus = lastNoContentTimeout ? HTTP_STATUS.GATEWAY_TIMEOUT : HTTP_STATUS.SERVICE_UNAVAILABLE;
        lastErrorType = lastNoContentTimeout ? ERROR_TYPES[HTTP_STATUS.GATEWAY_TIMEOUT].type : null;
        lastErrorCode = lastNoContentTimeout ? ERROR_TYPES[HTTP_STATUS.GATEWAY_TIMEOUT].code : null;
        if (lastNoContentTimeout) {
          log.warn("COMBO", `Model ${modelStr} timed out waiting for stream content, trying next`);
        } else {
          log.warn("COMBO", `Model ${modelStr} returned an empty stream, trying next`);
        }
        continue;
      }

      // If the model that failed was the session-sticky model, clear it so next turns re-evaluate
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
        if (errorBody?.error?.type) lastErrorType = errorBody.error.type;
        if (errorBody?.error?.code) lastErrorCode = errorBody.error.code;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const { provider } = parseModel(modelStr);
      const { shouldFallback, cooldownMs, requestScoped } = checkFallbackError(result.status, errorText, 0, provider);

      if (!shouldFallback && !requestScoped) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // A request-scoped 4xx (validation failure, unsupported parameter, context
      // overflow) says this member cannot serve THIS request — not that the
      // credential is unhealthy. Members run on different providers with
      // different validation, so the next member may well serve it. Advance
      // without a cooldown, and without waiting: there is nothing to recover.
      // checkFallbackError() reports no account fallback here on purpose (a
      // request-scoped fault must not evict a healthy account from rotation).
      if (requestScoped) {
        log.warn("COMBO", `Model ${modelStr} rejected the request (${result.status}), trying next`, { status: result.status });
        lastError = errorText || String(result.status);
        if (!lastStatus) lastStatus = result.status;
        if (!requestScopedResult) requestScopedResult = result;
        continue;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // At least one member rejected the request itself. Hand back that member's own
  // response — status and body — rather than the synthesized envelope below: the
  // synthesized one reaches the client as a 200 carrying an error object, which
  // reads as an empty success, and it buries the member that named the real cause.
  // This is also what the caller saw before combos advanced on these errors.
  if (requestScopedResult) {
    log.warn("COMBO", `No model served the request; returning the first request-scoped failure (${requestScopedResult.status})`);
    return requestScopedResult;
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  // Same one-status correction as the single-model path in chat.js: a non-model 404
  // here is a cooldown the router set itself, not a missing model. Every other class
  // is left exactly as it was. Note lastStatus is the FIRST member's status while
  // lastError is the LAST member's text, so this pair can disagree — pre-existing,
  // and the reason this only narrows a 404 rather than trusting the text further.
  // Exception: the synthetic no-content branch above keeps the LATEST member's
  // status/type/code so a timeout is not reported with a stale earlier class.
  const status = allDisabled ? 503 : clientStatusForBreakerOpen(lastStatus || 503, lastError);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${status} | ${msg} (${retryHuman})`);
    const base = unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
    // unavailableResponse chỉ trả message: giữ nguyên header/suffix của nó,
    // bổ sung type/code chỉ khi attempt cuối là timeout synthetic (boolean
    // tường minh, không so message text).
    // Mọi đường khác (EOF, 429 thuần, structured error, upstream trùng message)
    // trả base nguyên.
    if (!lastNoContentTimeout) return base;
    return new Response(
      JSON.stringify({ error: { message: `${msg} (${retryHuman})`, ...(lastErrorType ? { type: lastErrorType } : {}), ...(lastErrorCode ? { code: lastErrorCode } : {}) } }),
      { status, headers: base.headers }
    );
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg, ...(lastErrorType ? { type: lastErrorType } : {}), ...(lastErrorCode ? { code: lastErrorCode } : {}) } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning }) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  // Fusion runs panel models non-streaming; drop stream_options too, or providers
  // like DeepSeek reject it with "stream_options should be set along with stream = true".
  // See issue #3024.
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const calls = panel.map((m) => withTimeout(handleSingleModel(panelBody, m, true), cfg.panelHardTimeoutMs));
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}

export {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.js";
