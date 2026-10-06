/**
 * OpenAI Responses API → Claude Response Translator (DIRECT route, no OpenAI pivot)
 *
 * Converts streaming SSE events from OpenAI Responses API straight to
 * Anthropic Messages API SSE events.
 * Registered on `openai-responses:claude` so Responses-native upstreams
 * (Codex, OpenCode Zen/Muse) stream straight to Claude Code without the lossy
 * intermediate Chat Completions pivot (no ID collisions, no dropped parallel args).
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { CLAUDE_BLOCK, RESPONSES_ITEM, CLAUDE_STOP } from "../schema/index.js";
import { sanitizeToolArgs } from "../concerns/toolArgs.js";
import { responsesToClaudeUsage } from "../concerns/usage.js";
import { CLAUDE_TOOL_PROGRESS_PING_INTERVAL_MS } from "../../config/runtimeConfig.js";
import { SSE_PING_EVENT } from "../../utils/sseConstants.js";

function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({ type: "content_block_stop", index: state.thinkingBlockIndex });
  state.thinkingBlockStarted = false;
}

function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({ type: "content_block_stop", index: state.textBlockIndex });
  state.textBlockStarted = false;
}

function restoreToolName(state, name) {
  const raw = name || "";
  const map = state?.toolNameMap || state?._toolNameMap;
  return map && typeof map.get === "function" && map.has(raw) ? map.get(raw) : raw;
}

export function responsesToClaudeResponse(chunk, state) {
  if (!chunk) return null;

  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;
  const results = [];

  // Initialize state
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = state.messageId || (typeof data.response?.id === "string" ? data.response.id : `msg_${Date.now()}`);
    state.model = state.model || "assistant";
    state.nextBlockIndex = 0;
    state.toolCalls = new Map(); // blockIndex -> { id, call_id, name, blockIndex, closed }
    state.toolArgBuffers = new Map(); // blockIndex -> string
    state.toolIndexByKey = new Map(); // item_id / call_id / output_index -> blockIndex
    state.textPartsByItem = new Map();
    state.lastToolProgressPingAt = undefined;

    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  let textParts;
  if (eventType === "response.output_text.delta" ||
      ((eventType === "response.output_item.added" || eventType === "response.output_item.done") && data.item?.type === RESPONSES_ITEM.MESSAGE)) {
    const id = data.item?.id || data.item_id;
    const indexKey = data.output_index !== undefined ? `idx_${data.output_index}` : null;
    textParts = (id && state.textPartsByItem.get(id)) ||
      (indexKey && state.textPartsByItem.get(indexKey)) ||
      (!id && !indexKey && state.currentTextParts) || new Map();
    if (id) state.textPartsByItem.set(id, textParts);
    if (indexKey) state.textPartsByItem.set(indexKey, textParts);
    state.currentTextParts = textParts;
  }

  // Thinking delta
  if (eventType === "response.reasoning_summary_text.delta" || eventType === "response.reasoning_text.delta" || eventType === "response.reasoning.delta") {
    const delta = data.delta || "";
    if (delta) {
      stopTextBlock(state, results);
      if (!state.thinkingBlockStarted) {
        state.thinkingBlockIndex = state.nextBlockIndex++;
        state.thinkingBlockStarted = true;
        results.push({
          type: "content_block_start",
          index: state.thinkingBlockIndex,
          content_block: { type: "thinking", thinking: "" },
        });
      }
      results.push({
        type: "content_block_delta",
        index: state.thinkingBlockIndex,
        delta: { type: "thinking_delta", thinking: delta },
      });
    }
    return results.length > 0 ? results : null;
  }

  const emitTextDelta = (delta) => {
    if (typeof delta !== "string" || !delta) return;
    stopThinkingBlock(state, results);
    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" },
      });
    }
    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta },
    });
  };

  // Text delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (typeof delta === "string" && delta) {
      const partIndex = data.content_index ?? 0;
      textParts.set(partIndex, (textParts.get(partIndex) || "") + delta);
      emitTextDelta(delta);
    }
    return results.length > 0 ? results : null;
  }

  // Complete message items may contain text that never arrived as deltas.
  if (eventType === "response.output_item.done" && data.item?.type === RESPONSES_ITEM.MESSAGE) {
    for (const [partIndex, part] of (data.item.content || []).entries()) {
      if (part?.type !== RESPONSES_ITEM.OUTPUT_TEXT || typeof part.text !== "string") continue;
      const emitted = textParts.get(partIndex) || "";
      if (!part.text.startsWith(emitted)) continue;
      emitTextDelta(part.text.slice(emitted.length));
      textParts.set(partIndex, part.text);
    }
    return results.length > 0 ? results : null;
  }

  // Output item added (function call declaration)
  if (eventType === "response.output_item.added") {
    const item = data.item;
    if (item?.type === RESPONSES_ITEM.FUNCTION_CALL || item?.type === "function_call") {
      stopThinkingBlock(state, results);
      stopTextBlock(state, results);

      const blockIndex = state.nextBlockIndex++;
      const rawName = item.name || "";
      const name = restoreToolName(state, rawName);
      const callId = item.call_id || item.id || `call_${Date.now()}_${blockIndex}`;

      const toolInfo = { id: item.id, call_id: callId, name, blockIndex, closed: false };
      state.toolCalls.set(blockIndex, toolInfo);

      // Map all possible key variants to blockIndex
      const registerKey = (k) => {
        if (k !== undefined && k !== null && k !== "") state.toolIndexByKey.set(String(k), blockIndex);
      };
      registerKey(item.id);
      registerKey(item.call_id);
      registerKey(data.item_id);
      registerKey(data.call_id);
      if (item.call_id) registerKey(`fc_${item.call_id}`);
      if (typeof item.id === "string" && item.id.startsWith("fc_")) registerKey(item.id.slice(3));
      if (data.output_index !== undefined) registerKey(`idx_${data.output_index}`);

      state.toolArgBuffers.set(blockIndex, item.arguments || "");

      results.push({
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: callId,
          name,
          input: {},
        },
      });
    }
    return results.length > 0 ? results : null;
  }

  // Function call arguments delta
  if (eventType === "response.function_call_arguments.delta") {
    const delta = data.delta || "";
    const key = data.item_id || data.call_id || (data.output_index !== undefined ? `idx_${data.output_index}` : null);
    let blockIndex = key ? state.toolIndexByKey.get(String(key)) : null;
    if (blockIndex === null || blockIndex === undefined) {
      if (typeof key === "string" && key.startsWith("fc_")) {
        blockIndex = state.toolIndexByKey.get(key.slice(3));
      }
    }
    if (blockIndex !== null && blockIndex !== undefined) {
      const current = state.toolArgBuffers.get(blockIndex) || "";
      state.toolArgBuffers.set(blockIndex, current + delta);
      // ponytail: only active buffered tool-argument progress stays alive;
      // true idle full-heartbeat needs future scoped transport/window proof.
      if (typeof delta === "string" && delta !== "" && !state.finishReasonSent && !state.errorSent) {
        const toolInfo = state.toolCalls.get(blockIndex);
        if (toolInfo && !toolInfo.closed) {
          const now = Date.now();
          const last = state.lastToolProgressPingAt;
          if (last === undefined || now - last >= CLAUDE_TOOL_PROGRESS_PING_INTERVAL_MS) {
            state.lastToolProgressPingAt = now;
            return [{ type: SSE_PING_EVENT }];
          }
        }
      }
    }
    return null;
  }

  // Function call arguments done / output item done
  if (eventType === "response.function_call_arguments.done" || eventType === "response.output_item.done") {
    const item = data.item;
    const key = data.item_id || data.call_id || item?.id || item?.call_id || (data.output_index !== undefined ? `idx_${data.output_index}` : null);
    let blockIndex = key ? state.toolIndexByKey.get(String(key)) : null;
    if ((blockIndex === null || blockIndex === undefined) && typeof key === "string" && key.startsWith("fc_")) {
      blockIndex = state.toolIndexByKey.get(key.slice(3));
    }
    if (blockIndex !== null && blockIndex !== undefined) {
      const toolInfo = state.toolCalls.get(blockIndex);
      if (toolInfo && !toolInfo.closed) {
        toolInfo.closed = true;
        if (item?.name) toolInfo.name = restoreToolName(state, item.name);
        const buffered = state.toolArgBuffers.get(blockIndex) || data.arguments || item?.arguments || "{}";
        const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
        results.push({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: sanitized },
        });
        results.push({
          type: "content_block_stop",
          index: blockIndex,
        });
      }
    }
    return results.length > 0 ? results : null;
  }

  // Response completed / done / incomplete
  if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    const status = data.response?.status || data.status;
    const statusDetails = data.response?.status_details || data.status_details || data.response?.incomplete_details || data.incomplete_details;
    const reason = statusDetails?.reason;
    const isIncomplete = eventType === "response.incomplete" || status === "incomplete";
    const isMaxTokens = isIncomplete && (reason === "max_output_tokens" || reason === "max_tokens" || !reason);

    // Close any unclosed tool calls
    for (const [blockIndex, toolInfo] of state.toolCalls) {
      if (!toolInfo.closed) {
        toolInfo.closed = true;
        if (isIncomplete) {
          const rawBuffered = state.toolArgBuffers.get(blockIndex) || "";
          const buffered = rawBuffered || sanitizeToolArgs(toolInfo.name, "{}");
          results.push({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: buffered },
          });
          results.push({
            type: "content_block_stop",
            index: blockIndex,
          });
        } else {
          const buffered = state.toolArgBuffers.get(blockIndex) || "{}";
          const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
          results.push({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: sanitized },
          });
          results.push({
            type: "content_block_stop",
            index: blockIndex,
          });
        }
      }
    }

    // Extract usage
    const responseUsage = data.response?.usage || data.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const reasoningTokens = responseUsage.output_tokens_details?.reasoning_tokens || responseUsage.completion_tokens_details?.reasoning_tokens || responseUsage.reasoning_tokens || 0;

      state.usage = responsesToClaudeUsage(responseUsage);
      if (reasoningTokens > 0) {
        state.reasoningTokens = reasoningTokens;
      }
    }

    if (!state.finishReasonSent) {
      state.finishReasonSent = true;
      const stopReason = isMaxTokens
        ? CLAUDE_STOP.MAX_TOKENS
        : state.toolCalls.size > 0
          ? CLAUDE_STOP.TOOL_USE
          : CLAUDE_STOP.END_TURN;

      results.push({
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: state.usage || { input_tokens: 0, output_tokens: 0 },
      });
      results.push({ type: "message_stop" });
    }
    return results.length > 0 ? results : null;
  }

  // Error / failure
  if (eventType === "error" || eventType === "response.failed") {
    if (state.errorSent) return null;
    state.errorSent = true;
    state.finishReasonSent = true;
    const error = data.error || data.response?.error || { message: "Upstream error", type: "api_error" };
    return [{
      type: "error",
      error: {
        type: error.type || "api_error",
        message: error.message || "Upstream error",
      }
    }];
  }

  return results.length > 0 ? results : null;
}

register(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, responsesToClaudeResponse);
