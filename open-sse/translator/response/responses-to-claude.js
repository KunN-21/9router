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
import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { sanitizeToolArgs } from "../concerns/toolArgs.js";

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

  // Thinking delta
  if (eventType === "response.reasoning_summary_text.delta" || eventType === "response.reasoning.delta") {
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

  // Text delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (delta) {
      stopThinkingBlock(state, results);
      if (!state.textBlockStarted) {
        state.textBlockIndex = state.nextBlockIndex++;
        state.textBlockStarted = true;
        state.textBlockClosed = false;
        results.push({
          type: "content_block_start",
          index: state.textBlockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      results.push({
        type: "content_block_delta",
        index: state.textBlockIndex,
        delta: { type: "text_delta", text: delta },
      });
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

  // Response completed / done
  if (eventType === "response.completed" || eventType === "response.done") {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    // Close any unclosed tool calls
    for (const [blockIndex, toolInfo] of state.toolCalls) {
      if (!toolInfo.closed) {
        toolInfo.closed = true;
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

    // Extract usage
    const responseUsage = data.response?.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const inputTokens = responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
      const outputTokens = responseUsage.output_tokens || responseUsage.completion_tokens || 0;
      const cacheRead = responseUsage.input_tokens_details?.cached_tokens || responseUsage.cache_read_input_tokens || 0;
      state.usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
      };
    }

    if (!state.finishReasonSent) {
      state.finishReasonSent = true;
      const stopReason = state.toolCalls.size > 0 ? "tool_use" : "end_turn";
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
    if (!state.finishReasonSent) {
      state.finishReasonSent = true;
      const error = data.error || data.response?.error;
      const errText = `[Error] ${error?.message || JSON.stringify(error || "Unknown error")}`;
      stopThinkingBlock(state, results);
      if (!state.textBlockStarted) {
        state.textBlockIndex = state.nextBlockIndex++;
        results.push({
          type: "content_block_start",
          index: state.textBlockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      results.push({
        type: "content_block_delta",
        index: state.textBlockIndex,
        delta: { type: "text_delta", text: errText },
      });
      results.push({ type: "content_block_stop", index: state.textBlockIndex });
      results.push({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      results.push({ type: "message_stop" });
    }
    return results.length > 0 ? results : null;
  }

  return results.length > 0 ? results : null;
}

register(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, responsesToClaudeResponse);
