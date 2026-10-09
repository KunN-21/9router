/**
 * Translator: OpenAI Chat Completions → OpenAI Responses API (response)
 * Converts streaming chunks from Chat Completions to Responses API events
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { buildChunk } from "../concerns/chunk.js";
import { buildUsage } from "../concerns/usage.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { reasoningDelta, extractReasoningText } from "../concerns/reasoning.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM, OPENAI_FINISH, MODEL_FALLBACK } from "../schema/index.js";

// Upstream Chat Completions usage -> Responses API usage shape.
// Without this, /v1/responses never reports usage: Responses clients (Codex CLI)
// keep their "context used" gauge pinned at 0 and never auto-compact, so a long
// session grows until the upstream context limit rejects it (9router issue #3432).
//
// Note this is stored under state.responsesUsage, NOT state.usage: state.usage is
// owned by the stream layer, which fills it with normalizeUsage()-shaped counts
// (prompt_tokens/prompt_tokens_details) and hands it to finalizeStream() for
// logging and cost accounting. Overwriting it with this shape silently drops
// cached/reasoning tokens from those stats.
function toResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = [usage.input_tokens, usage.prompt_tokens].find(Number.isInteger);
  const outputTokens = [usage.output_tokens, usage.completion_tokens].find(Number.isInteger);
  // Some upstreams attach zeroed placeholders to every chunk. Wait for real counts
  // so response.completed cannot freeze the placeholder before the usage trailer.
  if (inputTokens === undefined || outputTokens === undefined || inputTokens + outputTokens <= 0) {
    return null;
  }
  const responseUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
  const cachedTokens = [usage.input_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens].find(Number.isInteger);
  const reasoningTokens = [usage.output_tokens_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens].find(Number.isInteger);
  if (Number.isInteger(cachedTokens)) responseUsage.input_tokens_details = { cached_tokens: cachedTokens };
  if (Number.isInteger(reasoningTokens)) responseUsage.output_tokens_details = { reasoning_tokens: reasoningTokens };

  return responseUsage;
}

/**
 * Translate OpenAI chunk to Responses API events
 * @returns {Array} Array of events with { event, data } structure
 */
export function openaiToOpenAIResponsesResponse(chunk, state) {
  if (!chunk) {
    return flushEvents(state);
  }

  // Handle OpenAI error payload (e.g. rate limit or server error)
  if (chunk.error) {
    if (state.completedSent || state.failedSent) return [];
    state.failedSent = true;
    const nextSeq = () => ++state.seq;
    return [{
      event: "response.failed",
      data: {
        type: "response.failed",
        sequence_number: nextSeq(),
        response: {
          id: state.responseId,
          object: "response",
          created_at: state.created,
          status: "failed",
          error: {
            message: chunk.error.message || JSON.stringify(chunk.error),
            type: chunk.error.type || "server_error",
            code: chunk.error.code || "upstream_error"
          }
        }
      }
    }];
  }

  // Capture usage before the choices guard: OpenAI may send it in a trailer
  // whose choices array is empty.
  const responseUsage = toResponsesUsage(chunk.usage);
  if (responseUsage) state.responsesUsage = responseUsage;

  if (!chunk.choices?.length) {
    return state.completionPending && state.responsesUsage ? flushEvents(state) : [];
  }
  
  const events = [];
  const nextSeq = () => ++state.seq;
  
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  const choice = chunk.choices[0];
  const idx = choice.index || 0;
  const delta = choice.delta || {};

  // Emit initial events
  if (!state.started) {
    state.started = true;
    state.responseId = chunk.id ? `resp_${chunk.id}` : state.responseId;
    
    emit("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        background: false,
        error: null,
        output: []
      }
    });

    emit("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress"
      }
    });
  }

  // Handle reasoning across vendor shapes (reasoning_content / reasoning / reasoning_details)
  const reasoningText = extractReasoningText(delta);
  if (reasoningText) {
    startReasoning(state, emit, idx);
    emitReasoningDelta(state, emit, reasoningText);
  }

  // Handle text content
  if (delta.content) {
    let content = delta.content;

    if (content.includes("<think>")) {
      state.inThinking = true;
      content = content.replace("<think>", "");
      startReasoning(state, emit, idx);
    }

    if (content.includes("</think>")) {
      const parts = content.split("</think>");
      const thinkPart = parts[0];
      const textPart = parts.slice(1).join("</think>");
      if (thinkPart) emitReasoningDelta(state, emit, thinkPart);
      closeReasoning(state, emit);
      state.inThinking = false;
      content = textPart;
    }

    if (state.inThinking && content) {
      emitReasoningDelta(state, emit, content);
      return events;
    }

    if (content) {
      // The answer starts, so thinking is over. Upstreams that send reasoning via
      // reasoning_content never emit "</think>", so close it here rather than at finish.
      closeReasoning(state, emit);
      emitTextContent(state, emit, idx, content);
    }
  }

  // Handle tool_calls (empty array is truthy; require a real call)
  if (delta.tool_calls && delta.tool_calls.length) {
    closeReasoning(state, emit);
    closeMessage(state, emit, idx);
    for (const tc of delta.tool_calls) {
      emitToolCall(state, emit, tc);
    }
  }

  // Handle finish_reason
  if (choice.finish_reason) {
    for (const i in state.msgItemAdded) closeMessage(state, emit, i);
    closeReasoning(state, emit);
    for (const i in state.funcCallIds) closeToolCall(state, emit, i);
    // Upstreams report usage either on the finish chunk itself or on a trailing chunk
    // whose `choices` array is empty (OpenAI does the latter). Emitting
    // response.completed here would freeze the payload before that trailing chunk is
    // parsed, so when usage is not known yet we leave completion to flushEvents(),
    // which runs once the upstream stream ends and by then has seen every chunk.
    //
    // That only holds on the direct openai:openai-responses route. When this converter
    // runs as the second hop of a pivot (Claude/Gemini/Kiro upstream), translateResponse()
    // drops the terminal null chunk before reaching us — the first hop returns null for
    // it, leaving nothing to iterate — so flushEvents() is never called and deferring
    // would swallow the terminal event entirely. Keep the old behaviour there.
    const flushReachesUs = state.targetFormat === FORMATS.OPENAI;
    if (state.responsesUsage || !flushReachesUs) sendCompleted(state, emit);
    else state.completionPending = true;
  }

  return events;
}

// Helper functions
function startReasoning(state, emit, idx) {
  if (!state.reasoningId) {
    state.reasoningId = `rs_${state.responseId}_${idx}`;
    state.nextOutputIndex ??= 0;
    state.reasoningIndex = state.nextOutputIndex++;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.reasoningIndex,
      item: { id: state.reasoningId, type: RESPONSES_ITEM.REASONING, summary: [] }
    });

    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: "" }
    });
    state.reasoningPartAdded = true;
  }
}

function emitReasoningDelta(state, emit, text) {
  if (!text) return;
  state.reasoningBuf += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: text
  });
}

function closeReasoning(state, emit) {
  if (state.reasoningId && !state.reasoningDone) {
    state.reasoningDone = true;
    
    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      text: state.reasoningBuf
    });

    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }
    });

    const item = {
      id: state.reasoningId,
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }]
    };

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item
    });

    recordCompletedOutputItem(state, state.reasoningIndex, item);
  }
}

function emitTextContent(state, emit, idx, content) {
  state.msgOutputIndices ??= {};
  if (state.msgOutputIndices[idx] === undefined) {
    state.nextOutputIndex ??= 0;
    state.msgOutputIndices[idx] = state.nextOutputIndex++;
  }
  const outIdx = state.msgOutputIndices[idx];

  if (!state.msgItemAdded[idx]) {
    state.msgItemAdded[idx] = true;
    const msgId = `msg_${state.responseId}_${idx}`;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outIdx,
      item: { id: msgId, type: RESPONSES_ITEM.MESSAGE, content: [], role: ROLE.ASSISTANT }
    });
  }

  if (!state.msgContentAdded[idx]) {
    state.msgContentAdded[idx] = true;
    
    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${state.responseId}_${idx}`,
      output_index: outIdx,
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: "" }
    });
  }

  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `msg_${state.responseId}_${idx}`,
    output_index: outIdx,
    content_index: 0,
    delta: content,
    logprobs: []
  });

  if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
  state.msgTextBuf[idx] += content;
}

function closeMessage(state, emit, idx) {
  if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
    state.msgItemDone[idx] = true;
    const outIdx = state.msgOutputIndices?.[idx] ?? parseInt(idx);
    const fullText = state.msgTextBuf[idx] || "";
    const msgId = `msg_${state.responseId}_${idx}`;

    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: outIdx,
      content_index: 0,
      text: fullText,
      logprobs: []
    });

    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: msgId,
      output_index: outIdx,
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }
    });

    const item = {
      id: msgId,
      type: RESPONSES_ITEM.MESSAGE,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }],
      role: ROLE.ASSISTANT
    };

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outIdx,
      item
    });

    recordCompletedOutputItem(state, outIdx, item);
  }
}

function isCustomTool(state, name) {
  return !!name && state.customToolNames?.has(name);
}

function extractCustomToolInput(argumentsText) {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* incomplete or raw freeform input */ }
  return argumentsText;
}

function emitToolCall(state, emit, tc) {
  const tcIdx = tc.index ?? 0;
  const newCallId = tc.id;
  const funcName = tc.function?.name;

  if (funcName) state.funcNames[tcIdx] = funcName;
  if (newCallId) state.funcCallIds[tcIdx] = newCallId;

  // Some compatible providers split the call id and function name across
  // chunks. Wait for both before deciding whether this is a custom tool;
  // otherwise an `exec` call can be irreversibly announced as function_call.
  const callId = state.funcCallIds[tcIdx];
  if (!state.funcItemAdded[tcIdx] && callId && state.funcNames[tcIdx]) {
    state.funcItemAdded[tcIdx] = true;
    state.toolOutputIndices ??= {};
    if (state.toolOutputIndices[tcIdx] === undefined) {
      state.nextOutputIndex ??= 0;
      state.toolOutputIndices[tcIdx] = state.nextOutputIndex++;
    }
    const outIdx = state.toolOutputIndices[tcIdx];
    const custom = isCustomTool(state, state.funcNames[tcIdx]);

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outIdx,
      item: {
        id: `${custom ? "ctc" : "fc"}_${callId}`,
        type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
        ...(custom ? { input: "" } : { arguments: "" }),
        call_id: callId,
        name: state.funcNames[tcIdx] || ""
      }
    });
  }

  if (!state.funcArgsBuf[tcIdx]) state.funcArgsBuf[tcIdx] = "";

  if (tc.function?.arguments) {
    const refCallId = state.funcCallIds[tcIdx] || newCallId;
    if (state.funcItemAdded[tcIdx] && refCallId && !isCustomTool(state, state.funcNames[tcIdx])) {
      const outIdx = state.toolOutputIndices?.[tcIdx] ?? tcIdx;
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${refCallId}`,
        output_index: outIdx,
        delta: tc.function.arguments
      });
    }
    // Custom input is emitted once at close, after the Chat JSON wrapper can be
    // parsed and unwrapped. Streaming the raw JSON fragments would expose
    // {"input":"..."} instead of the freeform program Codex expects.
    state.funcArgsBuf[tcIdx] += tc.function.arguments;
  }
}

function closeToolCall(state, emit, idx) {
  const callId = state.funcCallIds[idx];
  if (callId && !state.funcItemDone[idx]) {
    state.toolOutputIndices ??= {};
    if (state.toolOutputIndices[idx] === undefined) {
      state.nextOutputIndex ??= 0;
      state.toolOutputIndices[idx] = state.nextOutputIndex++;
    }
    const outIdx = state.toolOutputIndices[idx];
    const args = state.funcArgsBuf[idx] || "{}";
    const custom = isCustomTool(state, state.funcNames[idx]);

    if (custom) {
      const input = extractCustomToolInput(args);
      emit("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        item_id: `ctc_${callId}`,
        output_index: outIdx,
        delta: input
      });
      emit("response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done",
        item_id: `ctc_${callId}`,
        output_index: outIdx,
        input
      });
    } else {
      emit("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: `fc_${callId}`,
        output_index: outIdx,
        arguments: args
      });
    }

    const item = {
      id: `${custom ? "ctc" : "fc"}_${callId}`,
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      ...(custom ? { input: extractCustomToolInput(args) } : { arguments: args }),
      call_id: callId,
      name: state.funcNames[idx] || ""
    };

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outIdx,
      item
    });

    recordCompletedOutputItem(state, outIdx, item);

    state.funcItemDone[idx] = true;
    state.funcArgsDone[idx] = true;
  }
}

// response.completed carries the finished Response object, so response.output has
// to repeat the items already delivered in response.output_item.done. Clients that
// build their final result from the terminal event (GitHub Copilot CLI, the OpenAI
// SDK "final response" helpers) otherwise treat the turn as empty even though the
// text was streamed - see issue #4307.
//
// Keyed by output_index so a repeated close overwrites rather than duplicating the
// item, and ordered by output_index so response.output matches the order the items
// were emitted in. Lazily created because stream.js can hand us a state it built
// itself rather than one from initState().
function recordCompletedOutputItem(state, outputIndex, item) {
  state.completedOutputItems ??= new Map();
  const index = Number.isInteger(outputIndex) ? outputIndex : Number.parseInt(outputIndex, 10) || 0;
  state.completedOutputItems.set(index, item);
}

function collectCompletedOutputItems(state) {
  const recorded = state.completedOutputItems;
  if (!(recorded instanceof Map) || recorded.size === 0) return [];
  return [...recorded.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, item]) => item);
}

function sendCompleted(state, emit) {
  if (!state.completedSent) {
    state.completedSent = true;
    emit("response.completed", {
      type: "response.completed",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "completed",
        background: false,
        error: null,
        output: collectCompletedOutputItems(state),
        ...(state.responsesUsage ? { usage: state.responsesUsage } : {})
      }
    });
  }
}

function flushEvents(state) {
  if (state.completedSent) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  for (const i in state.msgItemAdded) closeMessage(state, emit, i);
  closeReasoning(state, emit);
  for (const i in state.funcCallIds) closeToolCall(state, emit, i);
  sendCompleted(state, emit);
  
  return events;
}

// currentToolCallId is intentionally sticky for the current turn so flush/completion
  // can still finalize as tool_calls even if the tool call was emitted before stream end.
function computeFinishReason(state) {
   return state.toolCallIndex > 0 || state.currentToolCallId
    ? OPENAI_FINISH.TOOL_CALLS
    : OPENAI_FINISH.STOP;
}

// Helper to record alias between output_index and item id
function recordTextItemKey(state, data, item) {
  state.respItemKeyMap ??= new Map();
  const id = item?.id || data?.item_id;
  const outIdx = data?.output_index !== undefined ? data.output_index : item?.output_index;
  if (id && outIdx !== undefined) {
    state.respItemKeyMap.set(`idx_${outIdx}`, String(id));
    state.respItemKeyMap.set(String(id), `idx_${outIdx}`);
  }
}

function resolveTextItemKey(state, data, item = null) {
  state.respItemKeyMap ??= new Map();
  const id = item?.id || data?.item_id;
  if (id) {
    recordTextItemKey(state, data, item);
    return String(id);
  }
  const outIdx = data?.output_index !== undefined ? data.output_index : item?.output_index;
  if (outIdx !== undefined) {
    const idxKey = `idx_${outIdx}`;
    if (state.respItemKeyMap.has(idxKey)) {
      return state.respItemKeyMap.get(idxKey);
    }
    return idxKey;
  }
  if (state.currentOutputItemId) return state.currentOutputItemId;
  return "default";
}

// Helper to emit un-emitted text from done or completed events without duplication
function emitRemainingText(state, key, partIndex, text) {
  if (typeof text !== "string" || text.length === 0) return null;
  state.respTextEmitted ??= new Map();
  const partIdx = partIndex ?? 0;
  const partKey = `${key}:${partIdx}`;

  let already = state.respTextEmitted.get(partKey);
  if (!already && state.respItemKeyMap?.has(String(key))) {
    const aliasKey = state.respItemKeyMap.get(String(key));
    already = state.respTextEmitted.get(`${aliasKey}:${partIdx}`);
  }
  if (!already && partIdx === 0) {
    already = state.respTextEmitted.get(String(key));
    if (!already && state.respItemKeyMap?.has(String(key))) {
      const aliasKey = state.respItemKeyMap.get(String(key));
      already = state.respTextEmitted.get(String(aliasKey));
    }
  }
  already ||= "";

  let remaining = "";
  if (!already) {
    remaining = text;
  } else if (text.startsWith(already)) {
    remaining = text.slice(already.length);
  } else if (already.includes(text)) {
    remaining = "";
  } else {
    remaining = "";
  }

  if (remaining.length > 0) {
    const fullText = already + remaining;
    state.respTextEmitted.set(partKey, fullText);
    if (state.respItemKeyMap?.has(String(key))) {
      const aliasKey = state.respItemKeyMap.get(String(key));
      state.respTextEmitted.set(`${aliasKey}:${partIdx}`, fullText);
    }
    if (partIdx === 0) {
      state.respTextEmitted.set(String(key), fullText);
      if (state.respItemKeyMap?.has(String(key))) {
        const aliasKey = state.respItemKeyMap.get(String(key));
        state.respTextEmitted.set(String(aliasKey), fullText);
      }
    }
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { content: remaining }
    );
  }
  return null;
}

/**
 * Translate OpenAI Responses API chunk to OpenAI Chat Completions format
 * This is for when Codex returns data and we need to send it to an OpenAI-compatible client
 */
export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    // Flush: send final chunk with finish_reason
    if (state.finishReasonSent || !state.started) return null;

    const finishReason = computeFinishReason(state);

    state.finishReasonSent = true;
    state.finishReason = finishReason;

    const finalChunk = buildChunk(
      { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
      {},
      finishReason
    );

    if (state.usage && typeof state.usage === "object") {
      finalChunk.usage = state.usage;
    }

    return finalChunk;
  }

  // Handle different event types from Responses API
  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;

  // Initialize state
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.toolCallIndex = 0;
    state.currentToolCallId = null;
    // item_id → chat tool_calls index. Deltas carry item_id; keying on it (not
    // stream position) keeps parallel calls separate when upstream emits all
    // output_item.added events before any done/delta. Lazily created so callers
    // that build their own state object (stream.js) need no changes.
    state.respToolChatIndex ??= new Map();
    // Indices that already received argument deltas (guards done-with-args).
    state.respToolArgsEmitted ??= new Set();
    state.respTextEmitted ??= new Map();
    state.respItemKeyMap ??= new Map();
    state.currentOutputItemId = null;
  }

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;

    state.respTextEmitted ??= new Map();
    const key = resolveTextItemKey(state, data);
    const partIdx = data.content_index ?? 0;
    const partKey = `${key}:${partIdx}`;
    const prev = state.respTextEmitted.get(partKey) || "";
    const updated = prev + delta;
    state.respTextEmitted.set(partKey, updated);
    if (state.respItemKeyMap?.has(String(key))) {
      const aliasKey = state.respItemKeyMap.get(String(key));
      state.respTextEmitted.set(`${aliasKey}:${partIdx}`, updated);
    }
    if (partIdx === 0) {
      state.respTextEmitted.set(String(key), updated);
      if (state.respItemKeyMap?.has(String(key))) {
        const aliasKey = state.respItemKeyMap.get(String(key));
        state.respTextEmitted.set(String(aliasKey), updated);
      }
    }

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { content: delta }
    );
  }

  // Text content done: recover text if no delta or partial delta
  if (eventType === "response.output_text.done") {
    const key = resolveTextItemKey(state, data);
    return emitRemainingText(state, key, data.content_index, data.text);
  }

  function recordToolChatIndex(state, data, item, idx) {
  state.respToolChatIndex ??= new Map();
  const registerKey = (k) => {
    if (k !== undefined && k !== null && k !== "") {
      state.respToolChatIndex.set(String(k), idx);
    }
  };
  registerKey(item?.id);
  registerKey(data?.item_id);
  registerKey(item?.call_id);
  registerKey(data?.call_id);
  if (item?.call_id) registerKey(`fc_${item.call_id}`);
  if (typeof item?.id === "string" && item.id.startsWith("fc_")) registerKey(item.id.slice(3));
  if (typeof data?.item_id === "string" && data.item_id.startsWith("fc_")) registerKey(data.item_id.slice(3));
  if (data?.output_index !== undefined) registerKey(`idx_${data.output_index}`);
}

function resolveToolChatIndex(state, data, item = null) {
  if (!state.respToolChatIndex) return undefined;
  const candidates = [
    item?.id,
    data?.item_id,
    item?.call_id,
    data?.call_id,
    item?.call_id ? `fc_${item.call_id}` : null,
    typeof item?.id === "string" && item.id.startsWith("fc_") ? item.id.slice(3) : null,
    typeof data?.item_id === "string" && data.item_id.startsWith("fc_") ? data.item_id.slice(3) : null,
    typeof data?.item_id === "string" && !data.item_id.startsWith("fc_") ? `fc_${data.item_id}` : null,
    data?.output_index !== undefined ? `idx_${data.output_index}` : null,
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== "" && state.respToolChatIndex.has(String(c))) {
      return state.respToolChatIndex.get(String(c));
    }
  }
  return undefined;
}

  if (eventType === "response.output_item.added") {
    if (data.item?.id) state.currentOutputItemId = data.item.id;
    recordTextItemKey(state, data, data.item);
  }

// Function call started (standard function_call or custom_tool_call).
  // Index is assigned here (not on done): attributing deltas by stream position
  // merges parallel calls into index 0 whenever upstream emits all addeds
  // before dones — the client then concatenates N JSON payloads into one
  // tool input and fails validation. The server item id is the correlator.
  if (eventType === "response.output_item.added" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call")) {
    const item = data.item;
    state.currentToolCallId = item.call_id || fallbackToolCallId();
    let idx = resolveToolChatIndex(state, data, item);
    if (idx === undefined) {
      idx = state.toolCallIndex++;
      recordToolChatIndex(state, data, item, idx);
    }

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      {
        tool_calls: [{
          index: idx,
          id: state.currentToolCallId,
          type: OPENAI_BLOCK.FUNCTION,
          function: { name: item.name || "", arguments: "" }
        }]
      }
    );
  }

  // Function call arguments delta (standard or custom_tool_call variant).
  // Routed by item_id so interleaved parallel fragments stay on their own call.
  if (eventType === "response.function_call_arguments.delta" || eventType === "response.custom_tool_call_input.delta") {
    const argsDelta = data.delta || "";
    if (!argsDelta) return null;

    const known = resolveToolChatIndex(state, data);
    const idx = known ?? Math.max(0, (state.toolCallIndex || 1) - 1);
    state.respToolArgsEmitted ??= new Set();
    state.respToolArgsEmitted.add(idx);
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { tool_calls: [{ index: idx, function: { arguments: argsDelta } }] }
    );
  }

  // Function call done (arguments.done or output_item.done variant).
  // Index was assigned at added-time; nothing to advance. Some upstreams send
  // complete arguments only here (no deltas) — emit them once in that case.
  const isArgsDone = eventType === "response.function_call_arguments.done" || eventType === "response.custom_tool_call_input.done";
  const isItemDone = eventType === "response.output_item.done" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call");

  if (isArgsDone || isItemDone) {
    const item = data.item;
    const idx = resolveToolChatIndex(state, data, item) ?? Math.max(0, (state.toolCallIndex || 1) - 1);
    state.respToolArgsEmitted ??= new Set();
    if (!state.respToolArgsEmitted.has(idx)) {
      state.respToolArgsEmitted.add(idx);
      const rawArgs = item?.arguments ?? item?.input ?? data.arguments ?? data.input;
      const emitArgs = typeof rawArgs === "string" && rawArgs.length > 0 ? rawArgs : "{}";
      return buildChunk(
        { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
        { tool_calls: [{ index: idx, function: { arguments: emitArgs } }] }
      );
    }
    return null;
  }

  // Message output item done: recover text if no deltas were emitted or partial delta
  if (eventType === "response.output_item.done" && data.item?.type === "message") {
    const item = data.item;
    const key = resolveTextItemKey(state, data, item);
    const chunks = [];
    if (Array.isArray(item.content)) {
      item.content.forEach((part, idx) => {
        if (part?.type === "output_text" && part.text) {
          const chunk = emitRemainingText(state, key, idx, part.text);
          if (chunk) chunks.push(chunk);
        }
      });
    } else if (typeof item.text === "string" && item.text) {
      const chunk = emitRemainingText(state, key, 0, item.text);
      if (chunk) chunks.push(chunk);
    }
    if (chunks.length === 1) return chunks[0];
    if (chunks.length > 1) return chunks;
    return null;
  }

  // Response completed / done / incomplete
  if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
    // If status is failed or cancelled, treat as error, not success
    const status = data.response?.status || data.status;
    if (status === "failed" || status === "cancelled") {
      if (state.finishReasonSent) return null;
      const rawError = data.response?.error || data.error || { message: `Upstream response ${status}`, type: "stream_error" };
      state.error = rawError;
      state.finishReasonSent = true;
      return {
        error: {
          message: rawError.message || JSON.stringify(rawError),
          type: rawError.type || "server_error",
          code: rawError.code || `response_${status}`
        }
      };
    }

    // Extract usage from response.completed / response.done / response.incomplete event
    const responseUsage = data.response?.usage || data.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const inputTokens = responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
      const outputTokens = responseUsage.output_tokens || responseUsage.completion_tokens || 0;
      const totalTokens = responseUsage.total_tokens || (inputTokens + outputTokens);
      // OpenAI Responses API: input_tokens already includes cached_tokens
      // Cache info is in input_tokens_details.cached_tokens
      const cacheReadTokens = responseUsage.input_tokens_details?.cached_tokens || responseUsage.cache_read_input_tokens || 0;
      const cacheCreationTokens = responseUsage.input_tokens_details?.cache_creation_tokens || responseUsage.cache_creation_input_tokens || 0;
      const reasoningTokens = responseUsage.output_tokens_details?.reasoning_tokens || responseUsage.completion_tokens_details?.reasoning_tokens || responseUsage.reasoning_tokens || 0;

      state.usage = buildUsage({
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        cachedTokens: cacheReadTokens,
        cacheCreationTokens,
        reasoningTokens,
      });
    }

    if (!state.finishReasonSent) {
      // Check if there is any un-emitted text in completed output items
      const output = data.response?.output || data.output;
      const pendingChunks = [];
      if (Array.isArray(output)) {
        output.forEach((item, itemIdx) => {
          if (item?.type === "message") {
            const key = resolveTextItemKey(state, { output_index: itemIdx }, item);
            if (Array.isArray(item.content)) {
              item.content.forEach((part, partIdx) => {
                if (part?.type === "output_text" && part.text) {
                  const chunk = emitRemainingText(state, key, partIdx, part.text);
                  if (chunk) pendingChunks.push(chunk);
                }
              });
            } else if (typeof item.text === "string" && item.text) {
              const chunk = emitRemainingText(state, key, 0, item.text);
              if (chunk) pendingChunks.push(chunk);
            }
          }
        });
      }

      const isIncomplete = eventType === "response.incomplete" || status === "incomplete";
      const statusDetails = data.response?.status_details || data.status_details || data.response?.incomplete_details || data.incomplete_details;
      const reason = statusDetails?.reason;
      const isMaxTokens = isIncomplete && (reason === "max_output_tokens" || reason === "max_tokens" || !reason);

      // Truncation wins over tool presence — mirrors streaming translator (T7).
      const finishReason = isMaxTokens
        ? OPENAI_FINISH.LENGTH
        : state.toolCallIndex > 0 || state.currentToolCallId
        ? OPENAI_FINISH.TOOL_CALLS
        : computeFinishReason(state);

      state.finishReasonSent = true;
      state.finishReason = finishReason; // Mark for usage injection in stream.js

      const finalChunk = buildChunk(
        { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
        {},
        finishReason
      );

      // Include usage in final chunk if available
      if (state.usage && typeof state.usage === "object") {
        finalChunk.usage = state.usage;
      }

      if (pendingChunks.length > 0) {
        return [...pendingChunks, finalChunk];
      }
      return finalChunk;
    }
    return null;
  }

  // Error events from Responses API (e.g. model_not_found)
  if (eventType === "error" || eventType === "response.failed") {
    // Avoid emitting duplicate errors (error + response.failed arrive back-to-back)
    if (state.finishReasonSent) return null;

    const error = data.error || data.response?.error;
    if (error) {
      state.error = error;
      state.finishReasonSent = true;

      // Surface the error as a real OpenAI wire error object so stream.js
      // detects item.error and does NOT format as success text/STOP.
      return {
        error: {
          message: error.message || JSON.stringify(error),
          type: error.type || "server_error",
          code: error.code || "upstream_error"
        }
      };
    }
    return null;
  }

  // Reasoning summary delta → emit as reasoning_content for client thinking display
  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      reasoningDelta(delta)
    );
  }

  // Ignore other events
  return null;
}

// Register both directions
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, openaiToOpenAIResponsesResponse);
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, openaiResponsesToOpenAIResponse);
