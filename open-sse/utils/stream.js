import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

function isClientGemini(sourceFormat, provider) {
  if (sourceFormat) {
    return sourceFormat === FORMATS.GEMINI ||
           sourceFormat === FORMATS.ANTIGRAVITY ||
           sourceFormat === FORMATS.VERTEX ||
           sourceFormat === FORMATS.GEMINI_CLI;
  }
  return provider === "antigravity" || provider === "gemini" || provider === "vertex";
}

// Upper bound on the deferred response.completed wait: a chat->responses stream
// that saw finish_reason without usage must not hold the client's terminal event
// forever when the upstream stalls with no usage trailer and no [DONE].
const PENDING_COMPLETION_FLUSH_MS = 3000;

function detectUpstreamTerminal(parsed, format, eventName) {
  if (!parsed) return null;

  // Ollama NDJSON: done: true is the terminal chunk
  if (format === FORMATS.OLLAMA) {
    if (parsed.error) return "error";
    if (parsed.done === true) return "success";
  }

  // Error payloads across formats
  if (parsed.error) return "error";
  if (eventName === "error" || parsed.type === "error") return "error";

  // Claude: message_stop
  if (eventName === "message_stop" || parsed.type === "message_stop") {
    return "success";
  }

  // OpenAI Responses
  if (format === FORMATS.OPENAI_RESPONSES || isOpenAIResponsesTerminalEvent(eventName, parsed)) {
    const type = getOpenAIResponsesEventName(eventName, parsed);
    if (type === "response.failed" || type === "error" || parsed.response?.status === "failed") {
      return "error";
    }
    if (type === "response.completed" || type === "response.done" || type === "response.incomplete" || parsed.response?.status === "completed" || parsed.response?.status === "incomplete") {
      return "success";
    }
  }

  // Gemini / Antigravity (unwrap response envelope if present)
  const resp = parsed.response || parsed;
  if (resp.error) return "error";
  const geminiCandidate = resp.candidates?.[0];
  if (geminiCandidate?.finishReason) {
    return "success";
  }

  // OpenAI / Chat completions
  const choice = parsed.choices?.[0];
  if (choice?.finish_reason) {
    if (choice.finish_reason === "error") return "error";
    return "success";
  }

  return null;
}

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    credentials = null
  } = options;

  let buffer = "";
  let usage = null;
  let completionFlushTimer = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), model, sessionId: credentials?._clientSessionId || null,
        // Which upstream format this stream came from. A response translator can be
        // reached either directly (target === its registered source) or as the second
        // hop of a pivot, and on the terminal null chunk the pivot drops it — so a
        // translator that defers closing events until flush needs to know which case
        // it is in. Absent/undefined means "unknown", i.e. do not defer.
        targetFormat }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let downstreamErrorSent = false;
  let upstreamSuccessSeen = false;
  let upstreamErrorSeen = false;
  let finalized = false;
  let lastEmitted = null;

  // DONE/error guards: error is sticky and terminal; [DONE] may be emitted at
  // most once, and only for OpenAI-compatible Chat clients; nothing may be
  // emitted after [DONE].
  const clearCompletionTimer = () => {
    if (completionFlushTimer) {
      clearTimeout(completionFlushTimer);
      completionFlushTimer = null;
    }
  };

  // ponytail: clientKind resolved once per stream; passthrough without explicit
  // formats falls back to provider inference (isClientGemini). Upgrade when
  // callers pass targetFormat explicitly.
  const resolveClientKind = () => sourceFormat === FORMATS.OPENAI_RESPONSES
    ? "responses"
    : sourceFormat === FORMATS.CLAUDE ? "claude"
    : isClientGemini(sourceFormat, provider) ? "gemini"
    : "chat";
  const clientKind = resolveClientKind();
  const emitDone = (controller) => {
    clearCompletionTimer();
    if (streamDoneSent || resolveClientKind() !== "chat") return;
    ensureBlankSeparator(controller);
    const doneOutput = "data: [DONE]\n\n";
    try {
      reqLogger?.appendConvertedChunk?.(doneOutput);
      controller.enqueue(sharedEncoder.encode(doneOutput));
      lastEmitted = doneOutput;
      streamDoneSent = true;
    } catch {
      streamDoneSent = true;
    }
  };
  const emitError = (controller, format, payload) => {
    clearCompletionTimer();
    if (downstreamErrorSent) return;
    const errOutput = formatSSE(payload, format);
    try {
      reqLogger?.appendConvertedChunk?.(errOutput);
      controller.enqueue(sharedEncoder.encode(errOutput));
    } catch { /* stream already closed */ }
    downstreamErrorSent = true;
    upstreamErrorSeen = true;
    upstreamSuccessSeen = false;
    if (resolveClientKind() === "chat") emitDone(controller);
  };
  const emitPassthrough = (controller, output) => {
    if (streamDoneSent) return;
    try {
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      lastEmitted = output;
    } catch {
      upstreamErrorSeen = true;
      upstreamSuccessSeen = false;
      clearCompletionTimer();
    }
  };
  const emitTranslate = (controller, output) => {
    if (streamDoneSent) return;
    try {
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      lastEmitted = output;
      sseEmittedCount++;
    } catch {
      upstreamErrorSeen = true;
      upstreamSuccessSeen = false;
      clearCompletionTimer();
    }
  };
  // Terminal frames must start on a blank separator: a data tail without its
  // trailing newline leaves the last frame ending in single "\n".
  const ensureBlankSeparator = (controller) => {
    if (streamDoneSent) return;
    if (lastEmitted && !lastEmitted.endsWith("\n\n")) {
      const sep = "\n";
      try {
        reqLogger?.appendConvertedChunk?.(sep);
        controller.enqueue(sharedEncoder.encode(sep));
        lastEmitted += sep;
      } catch {
        clearCompletionTimer();
      }
    }
  };

  // Usage/logging tail, callable from transform() as well as flush(): a client that
  // closes right after the terminal event cancels the reader, and flush() never runs.
  const finalizeStream = () => {
    clearCompletionTimer();
    if (finalized) return;
    finalized = true;

    if (upstreamErrorSeen || !upstreamSuccessSeen) {
      return;
    }

    const isPassthrough = mode === STREAM_MODE.PASSTHROUGH;
    let finalUsage = isPassthrough ? usage : state?.usage;

    if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
      finalUsage = estimateUsage(body, totalContentLength, isPassthrough ? FORMATS.OPENAI : sourceFormat);
      if (isPassthrough) usage = finalUsage; else state.usage = finalUsage;
    }

    if (hasValidUsage(finalUsage)) {
      logUsage(isPassthrough ? provider : (state?.provider || targetFormat), finalUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
    }

    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, finalUsage, ttftAt);
    }
  };

  // Emit the deferred response.completed now — at [DONE], or when the watchdog
  // below gives up on a usage trailer that never arrives.
  const flushPendingCompletion = (controller) => {
    try {
      const completed = translateResponse(targetFormat, sourceFormat, null, state);
      for (const item of completed || []) {
        if (item === null || item === undefined) continue;
        const output = formatSSE(item, sourceFormat);
        reqLogger?.appendConvertedChunk?.(output);
        controller.enqueue(sharedEncoder.encode(output));
        sseEmittedCount++;
      }
      upstreamSuccessSeen = true;
      finalizeStream();
    } catch (err) {
      upstreamErrorSeen = true;
      upstreamSuccessSeen = false;
      clearCompletionTimer();
      dbg("SSE", `flushPendingCompletion error: ${err.message || err}`);
    }
  };

  const processLine = (line, controller) => {
    const trimmed = line.trim();
    if (!trimmed) {
      // Blank line ends the SSE frame — event state is frame-local.
      currentOpenAIResponsesEvent = null;
      if (mode === STREAM_MODE.PASSTHROUGH) {
        const output = "\n";
        emitPassthrough(controller, output);
      }
      return;
    }

    if (isDebugEnabled) {
      sseLineCount++;
      if (trimmed.startsWith("event:")) {
        const evt = trimmed.slice(6).trim();
        eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
      }
    }

    // Capture Responses API event name to preserve framing in same-format passthrough
    if (trimmed.startsWith("event:")) {
      currentOpenAIResponsesEvent = trimmed.slice(6).trim();
      if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES) {
        return;
      }
    }

    // Passthrough mode: normalize and forward
    if (mode === STREAM_MODE.PASSTHROUGH) {
      if (streamDoneSent) return;
      let output;
      let injectedUsage = false;
      let responsesTerminal = false;

      const isDoneSentinel = trimmed === "data: [DONE]" || (trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]");
      if (isDoneSentinel) {
        clearCompletionTimer();
        const clientKind = resolveClientKind();
        const isUpstreamClaudeOrGemini = targetFormat === FORMATS.CLAUDE || isClientGemini(targetFormat, provider);
        if (isUpstreamClaudeOrGemini || clientKind === "claude" || clientKind === "gemini") {
          // Native Claude/Gemini have no [DONE] sentinel — stray [DONE] is not a terminal and not success.
          return;
        }
        if (!upstreamErrorSeen) {
          upstreamSuccessSeen = true;
        }
        if (!upstreamErrorSeen) {
          if (clientKind === "responses") {
            if (!openAIResponsesTerminalSeen && !downstreamErrorSent) {
              const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
              reqLogger?.appendConvertedChunk?.(failedOutput);
              controller.enqueue(sharedEncoder.encode(failedOutput));
              openAIResponsesTerminalSeen = true;
              downstreamErrorSent = true;
              upstreamErrorSeen = true;
              upstreamSuccessSeen = false;
              sseEmittedCount++;
            }
            if (!streamDoneSent) {
              const doneOutput = "data: [DONE]\n\n";
              emitPassthrough(controller, doneOutput);
              streamDoneSent = true;
            }
          } else if (!streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            emitPassthrough(controller, doneOutput);
            streamDoneSent = true;
          }
        }
        return;
      }

      if (trimmed.startsWith("data:")) {
        try {
          const parsed = JSON.parse(trimmed.slice(5).trim());

          const termStatus = detectUpstreamTerminal(parsed, targetFormat, currentOpenAIResponsesEvent);
          if (termStatus === "error") {
            clearCompletionTimer();
            upstreamErrorSeen = true;
            upstreamSuccessSeen = false;
          } else if (termStatus === "success" && !upstreamErrorSeen) {
            upstreamSuccessSeen = true;
          }

          const idFixed = fixInvalidId(parsed);

          let fieldsInjected = false;
          if (parsed.choices !== undefined) {
            if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
            if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
          }

          if (parsed.prompt_filter_results !== undefined) {
            delete parsed.prompt_filter_results;
            fieldsInjected = true;
          }
          if (parsed?.choices) {
            for (const choice of parsed.choices) {
              if (choice.content_filter_results !== undefined) {
                delete choice.content_filter_results;
                fieldsInjected = true;
              }
            }
          }

          if (parsed?.choices) {
            for (const choice of parsed.choices) {
              if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                delete choice.delta.tool_calls;
                fieldsInjected = true;
              }
            }
          }

          if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
            return;
          }

          const delta = parsed.choices?.[0]?.delta;
          const content = delta?.content;
          const reasoning = delta?.reasoning_content;
          if (content && typeof content === "string") {
            totalContentLength += content.length;
            accumulatedContent += content;
          }
          if (reasoning && typeof reasoning === "string") {
            totalContentLength += reasoning.length;
            accumulatedThinking += reasoning;
          }

          const extracted = extractUsage(parsed);
          if (extracted) {
            usage = mergeUsage(usage, extracted);
          }

          responsesTerminal = isOpenAIResponsesTerminalEvent(currentOpenAIResponsesEvent, parsed);
          if (responsesTerminal) {
            openAIResponsesTerminalSeen = true;
            const respEventName = getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed);
            if (respEventName === "response.failed" || respEventName === "error" || parsed.response?.status === "failed" || termStatus === "error") {
              downstreamErrorSent = true;
            }
          }

          const isFinishChunk = parsed.choices?.[0]?.finish_reason;
          if (isFinishChunk && !hasValidUsage(parsed.usage)) {
            const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
            parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
            output = `data: ${JSON.stringify(parsed)}\n`;
            usage = estimated;
            injectedUsage = true;
          } else if (isFinishChunk && usage) {
            const buffered = addBufferToUsage(usage);
            parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
            output = `data: ${JSON.stringify(parsed)}\n`;
            injectedUsage = true;
          } else if (idFixed || fieldsInjected) {
            output = `data: ${JSON.stringify(parsed)}\n`;
            injectedUsage = true;
          }
        } catch {
          return;
        }
      }

      if (!injectedUsage) {
        if (line.startsWith("data:") && !line.startsWith("data: ")) {
          output = "data: " + line.slice(5) + "\n";
        } else {
          output = line + "\n";
        }
      }

      emitPassthrough(controller, output);
      if (responsesTerminal && upstreamSuccessSeen) finalizeStream();
      return;
    }

    // Translate mode
    const parsed = parseSSELine(trimmed, targetFormat);
    if (!parsed) return;

    const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
    const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
    const openAIResponsesEventName = isOpenAIResponsesStream
      ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
      : null;

    if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
      openAIResponsesTerminalSeen = true;
    }

    const termStatus = detectUpstreamTerminal(parsed, targetFormat, openAIResponsesEventName || currentOpenAIResponsesEvent);
    if (termStatus === "error") {
      clearCompletionTimer();
      upstreamErrorSeen = true;
      upstreamSuccessSeen = false;
    } else if (termStatus === "success" && !upstreamErrorSeen) {
      upstreamSuccessSeen = true;
    }

    // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
    // For other formats: done=true is the [DONE] sentinel, skip
    if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
      clearCompletionTimer();
      const isTargetClaudeOrGemini = targetFormat === FORMATS.CLAUDE || isClientGemini(targetFormat, provider);
      if (isTargetClaudeOrGemini) {
        // Upstream Claude/Gemini with [DONE] is a stray sentinel, NOT success terminal.
        return;
      }

      // A direct Chat-to-Responses translation can defer response.completed
      // while waiting for a usage trailer. [DONE] ends that opportunity even
      // if the upstream keeps the HTTP connection open, so finish now.
      if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
          state?.completionPending && !state?.completedSent) {
        flushPendingCompletion(controller);
      }

      if (isOpenAIResponsesStream && !openAIResponsesTerminalSeen) {
        upstreamErrorSeen = true;
        upstreamSuccessSeen = false;
        if (keepsOpenAIResponsesFormat) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          emitTranslate(controller, failedOutput);
          openAIResponsesTerminalSeen = true;
          downstreamErrorSent = true;
        } else if (sourceFormat === FORMATS.OPENAI) {
          // Upstream Responses stream ended without terminal; emit Chat error before DONE
          emitError(controller, FORMATS.OPENAI, { error: { message: "Stream ended unexpectedly without terminal event", type: "stream_error", code: "stream_incomplete" } });
        }
      } else if (!upstreamErrorSeen) {
        upstreamSuccessSeen = true;
      }

      if (sourceFormat === FORMATS.OPENAI_RESPONSES && !streamDoneSent) {
        const doneOutput = "data: [DONE]\n\n";
        emitTranslate(controller, doneOutput);
        streamDoneSent = true;
      } else if (sourceFormat === FORMATS.OPENAI && !streamDoneSent) {
        const doneOutput = "data: [DONE]\n\n";
        emitTranslate(controller, doneOutput);
        streamDoneSent = true;
      }
      return;
    }

    // Claude format - content
    if (parsed.delta?.text) {
      totalContentLength += parsed.delta.text.length;
      accumulatedContent += parsed.delta.text;
    }
    // Claude format - thinking
    if (parsed.delta?.thinking) {
      totalContentLength += parsed.delta.thinking.length;
      accumulatedThinking += parsed.delta.thinking;
    }

    // OpenAI format - content
    if (parsed.choices?.[0]?.delta?.content) {
      totalContentLength += parsed.choices[0].delta.content.length;
      accumulatedContent += parsed.choices[0].delta.content;
    }
    // OpenAI format - reasoning
    if (parsed.choices?.[0]?.delta?.reasoning_content) {
      totalContentLength += parsed.choices[0].delta.reasoning_content.length;
      accumulatedThinking += parsed.choices[0].delta.reasoning_content;
    }

    // Gemini format
    if (parsed.candidates?.[0]?.content?.parts) {
      for (const part of parsed.candidates[0].content.parts) {
        if (part.text && typeof part.text === "string") {
          totalContentLength += part.text.length;
          if (part.thought === true) {
            accumulatedThinking += part.text;
          } else {
            accumulatedContent += part.text;
          }
        }
      }
    }

    // Extract usage
    const extracted = extractUsage(parsed);
    if (extracted) state.usage = mergeUsage(state.usage, extracted);

    // Responses same-format passthrough: re-emit with original event framing
    if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
      if (openAIResponsesEventName === "response.failed" || openAIResponsesEventName === "error") {
        downstreamErrorSent = true;
        upstreamErrorSeen = true;
        upstreamSuccessSeen = false;
      }
      const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
      emitTranslate(controller, output);
      currentOpenAIResponsesEvent = null;
      if (openAIResponsesTerminalSeen && upstreamSuccessSeen) finalizeStream();
      return;
    }

    currentOpenAIResponsesEvent = null;

    // Translate: targetFormat -> openai -> sourceFormat
    const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

    // Log OpenAI intermediate chunks (if available)
    if (translated?._openaiIntermediate) {
      for (const item of translated._openaiIntermediate) {
        const openaiOutput = formatSSE(item, FORMATS.OPENAI);
        reqLogger?.appendOpenAIChunk?.(openaiOutput);
      }
    }

    if (translated?.length > 0) {
      for (const item of translated) {
        if (item === null || item === undefined) continue;
        if (!hasValuableContent(item, sourceFormat)) continue;

        const isResponsesFailed = item.event === "response.failed" || item.data?.type === "response.failed";
        if (item.type === "error" || item.error || isResponsesFailed) {
          downstreamErrorSent = true;
          upstreamErrorSeen = true;
          upstreamSuccessSeen = false;
          if (isResponsesFailed) openAIResponsesTerminalSeen = true;
        }

        // Inject estimated usage if finish chunk has no valid usage
        const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
        if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
          const estimated = estimateUsage(body, totalContentLength, sourceFormat);
          item.usage = filterUsageForFormat(estimated, sourceFormat);
          state.usage = estimated;
        } else if (state.finishReason && isFinishChunk && state.usage) {
          const buffered = addBufferToUsage(state.usage);
          item.usage = filterUsageForFormat(buffered, sourceFormat);
        }

        const output = formatSSE(item, sourceFormat);
        emitTranslate(controller, output);
        if ((item.type === "error" || item.error || isResponsesFailed) && clientKind === "chat") {
          emitDone(controller);
        }
      }
    }

    if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
        (state?.completedSent || state?.failedSent || !state?.completionPending)) {
      clearCompletionTimer();
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        processLine(line, controller);
      }

      // The completion deferral can outlive the upstream: a broken chat upstream
      // may stall after finish_reason with no usage trailer and no [DONE], holding
      // the connection open. Bound the wait so the client still gets a terminal event.
      if (state?.completedSent || state?.failedSent || !state?.completionPending || upstreamErrorSeen || downstreamErrorSent) {
        clearCompletionTimer();
      } else if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
          state?.completionPending && !state?.completedSent && !completionFlushTimer) {
        completionFlushTimer = setTimeout(() => {
          completionFlushTimer = null;
          if (state?.completedSent || state?.failedSent || downstreamErrorSent || upstreamErrorSeen) return;
          try {
            flushPendingCompletion(controller);
          } catch (err) {
            upstreamErrorSeen = true;
            upstreamSuccessSeen = false;
            clearCompletionTimer();
            dbg("SSE", `watchdog completion error: ${err.message || err}`);
          }
        }, PENDING_COMPLETION_FLUSH_MS);
      }
    },

    flush(controller) {
      clearCompletionTimer();
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        const hadBuffer = Boolean(buffer.trim());
        const hadTrailingNewline = buffer.endsWith("\n");

        if (hadBuffer) {
          const remainingLines = buffer.split(/\r?\n/);
          buffer = "";
          for (const line of remainingLines) {
            processLine(line, controller);
          }
          if (mode === STREAM_MODE.PASSTHROUGH && !hadTrailingNewline) {
            controller.enqueue(sharedEncoder.encode("\n"));
          }
        }

        if (mode === STREAM_MODE.PASSTHROUGH) {
          const clientGemini = isClientGemini(sourceFormat, provider);
          const clientKind = resolveClientKind();
          if (upstreamSuccessSeen && !upstreamErrorSeen) {
            if (!streamDoneSent && !clientGemini && clientKind === "chat") {
              ensureBlankSeparator(controller);
              const doneOutput = "data: [DONE]\n\n";
              emitPassthrough(controller, doneOutput);
              streamDoneSent = true;
            }
            finalizeStream();
          } else {
            // Incomplete or error passthrough stream
            if (clientKind === "responses") {
              if (!downstreamErrorSent && !openAIResponsesTerminalSeen) {
                const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
                emitPassthrough(controller, failedOutput);
                openAIResponsesTerminalSeen = true;
                downstreamErrorSent = true;
              }
              if (!streamDoneSent) {
                const doneOutput = "data: [DONE]\n\n";
                emitPassthrough(controller, doneOutput);
                streamDoneSent = true;
              }
            } else if (clientKind === "claude") {
              if (!downstreamErrorSent && !upstreamErrorSeen) {
                emitError(controller, FORMATS.CLAUDE, { type: "error", error: { type: "stream_error", message: "Stream ended unexpectedly without terminal event" } });
              }
            } else if (clientKind === "gemini") {
              // Client Gemini: no [DONE], no fake finishReason, no fake success
            } else {
              if (!downstreamErrorSent && !upstreamErrorSeen) {
                emitError(controller, FORMATS.OPENAI, { error: { message: "Stream ended unexpectedly without terminal event", type: "stream_error", code: "stream_incomplete" } });
              }
              if (!streamDoneSent) {
                emitDone(controller);
              }
            }
          }
          return;
        }

        // Translate mode finalization
        if (upstreamSuccessSeen && !upstreamErrorSeen) {
          const flushed = translateResponse(targetFormat, sourceFormat, null, state);
          if (flushed?._openaiIntermediate) {
            for (const item of flushed._openaiIntermediate) {
              const openaiOutput = formatSSE(item, FORMATS.OPENAI);
              reqLogger?.appendOpenAIChunk?.(openaiOutput);
            }
          }
          if (flushed?.length > 0) {
            for (const item of flushed) {
              if (item === null || item === undefined) continue;
              const output = formatSSE(item, sourceFormat);
              emitTranslate(controller, output);
            }
          }

          if (sourceFormat === FORMATS.OPENAI_RESPONSES && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            emitTranslate(controller, doneOutput);
            streamDoneSent = true;
          } else if (sourceFormat === FORMATS.OPENAI && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            emitTranslate(controller, doneOutput);
            streamDoneSent = true;
          }

          finalizeStream();
        } else {
          // Upstream did not reach success terminal OR saw an error
          if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
            if (!downstreamErrorSent && !openAIResponsesTerminalSeen) {
              const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
              emitTranslate(controller, failedOutput);
              openAIResponsesTerminalSeen = true;
              downstreamErrorSent = true;
            }
            if (!streamDoneSent) {
              const doneOutput = "data: [DONE]\n\n";
              emitTranslate(controller, doneOutput);
              streamDoneSent = true;
            }
          } else if (sourceFormat === FORMATS.CLAUDE) {
            if (!downstreamErrorSent) {
              emitError(controller, FORMATS.CLAUDE, { type: "error", error: { type: "stream_error", message: "Stream ended unexpectedly without terminal event" } });
            }
          } else if (isClientGemini(sourceFormat, provider)) {
            // Client Gemini: no [DONE], no fake finishReason, no fake success
          } else {
            // Default / OpenAI-compatible client
            if (!downstreamErrorSent) {
              emitError(controller, FORMATS.OPENAI, { error: { message: "Stream ended unexpectedly without terminal event", type: "stream_error", code: "stream_incomplete" } });
            }
            if (!streamDoneSent) {
              emitDone(controller);
            }
          }
        }
      } catch (error) {
        console.log("Error in flush:", error);
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, credentials = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    credentials
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  const passthroughArgs = provider !== null && typeof provider === "object"
    ? { ...provider, mode: STREAM_MODE.PASSTHROUGH }
    : {
        mode: STREAM_MODE.PASSTHROUGH,
        provider,
        reqLogger,
        model,
        connectionId,
        body,
        onStreamComplete,
        apiKey,
      };
  return createSSEStream(passthroughArgs);
}
