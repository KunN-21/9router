/**
 * Gemini → Claude Response Translator (DIRECT route, no OpenAI pivot)
 *
 * Converts streaming Gemini response chunks directly to Anthropic Messages API
 * SSE events without pivoting through intermediate OpenAI format.
 * Preserves thought/thinking content, handles function calls with parameter
 * sanitization (e.g. path -> file_path), and extracts usage metadata.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { CLAUDE_BLOCK } from "../schema/index.js";
import { sanitizeToolArgs } from "../concerns/toolArgs.js";
import { storeGeminiThoughtSignature } from "../../services/thoughtSignatureStore.js";

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

function convertFinishReason(reason, hasTools) {
  if (hasTools) return "tool_use";
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function geminiToClaudeResponse(chunk, state) {
  if (!chunk) return null;

  // Handle Antigravity or raw response wrapper
  const response = chunk.response || chunk;
  if (!response || (!response.candidates?.[0] && !response.usageMetadata)) return null;

  const results = [];
  const candidate = response.candidates?.[0];
  const content = candidate?.content;

  // Initialize state
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = response.responseId || state.messageId || `msg_${Date.now()}`;
    state.model = response.modelVersion || state.model || "gemini";
    state.nextBlockIndex = 0;
    state.geminiToolCount = 0;

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

  // Process candidate parts
  if (content?.parts) {
    for (const part of content.parts) {
      const hasThoughtSig = part.thoughtSignature || part.thought_signature;
      if (hasThoughtSig && typeof hasThoughtSig === "string") {
        state.pendingThoughtSignature = hasThoughtSig;
      }
      const isThought = part.thought === true;

      // Thinking content
      if (isThought && part.text !== undefined && part.text !== "") {
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
          delta: { type: "thinking_delta", thinking: part.text },
        });
        continue;
      }

      // Normal text content
      if (part.text !== undefined && part.text !== "") {
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
          delta: { type: "text_delta", text: part.text },
        });
        continue;
      }

      // Function call
      if (part.functionCall) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);

        const rawName = part.functionCall.name || "";
        const name = restoreToolName(state, rawName);
        const toolIndex = state.nextBlockIndex++;
        const callId = part.functionCall.id || `${name}-${Date.now()}-${toolIndex}`;
        state.geminiToolCount = (state.geminiToolCount || 0) + 1;

        if (state.pendingThoughtSignature) {
          storeGeminiThoughtSignature(callId, state.pendingThoughtSignature, state.sessionId, state.model);
          state.pendingThoughtSignature = null;
        }

        const argsObj = part.functionCall.args || {};
        const sanitizedArgs = sanitizeToolArgs(name, argsObj);
        const argsJson = typeof sanitizedArgs === "string" ? sanitizedArgs : JSON.stringify(sanitizedArgs);

        results.push({
          type: "content_block_start",
          index: toolIndex,
          content_block: {
            type: "tool_use",
            id: callId,
            name,
            input: {},
          },
        });
        results.push({
          type: "content_block_delta",
          index: toolIndex,
          delta: {
            type: "input_json_delta",
            partial_json: argsJson,
          },
        });
        results.push({
          type: "content_block_stop",
          index: toolIndex,
        });
      }
    }
  }

  // Usage metadata
  if (response.usageMetadata) {
    const meta = response.usageMetadata;
    const promptTokens = typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0;
    const outputTokens = typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0;
    const cachedTokens = typeof meta.cachedContentTokenCount === "number" ? meta.cachedContentTokenCount : 0;
    state.usage = {
      input_tokens: promptTokens,
      output_tokens: outputTokens,
      ...(cachedTokens ? { cache_read_input_tokens: cachedTokens } : {}),
    };
  }

  // Finish reason
  if (candidate?.finishReason && !state.finishReasonSent) {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    state.finishReasonSent = true;
    const stopReason = convertFinishReason(candidate.finishReason, (state.geminiToolCount || 0) > 0);
    results.push({
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: state.usage || { input_tokens: 0, output_tokens: 0 },
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

register(FORMATS.GEMINI, FORMATS.CLAUDE, null, geminiToClaudeResponse);
register(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, null, geminiToClaudeResponse);
