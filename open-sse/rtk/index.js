// RTK port: compress tool_result content in LLM request bodies
// Injected at the top of translateRequest (before any format translation)
import { RAW_CAP, MIN_COMPRESS_SIZE } from "./constants.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";
import { isProtectedTool, isUnknownTool, getToolCallMap } from "./guard.js";

// Compress tool_result content in-place. Returns stats or null if disabled/failed.
export function compressMessages(body, enabled) {
  if (!enabled) return null;
  if (!body) return null;

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState) {
    return compressKiroFormat(body, enabled);
  }

  // Gemini-family format: contents[].parts[].functionResponse (Antigravity wraps
  // in body.request). Only result text may shrink; signatures/binaries preserved.
  if (Array.isArray(body.contents) || Array.isArray(body.request?.contents)) {
    return compressGeminiFormat(body, enabled);
  }

  // Support both OpenAI/Claude "messages" and OpenAI Responses "input"
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!items) return null;

  const toolCallMap = getToolCallMap(body);
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses — top-level { type:"function_call_output", output: string | [{type:"input_text", text}] }
      if (msg.type === "function_call_output") {
        if (msg.is_error === true || msg.status === "error" || msg.isError === true) continue;
        const toolName = msg.name || toolCallMap.get(msg.call_id) || "";
        if (isProtectedTool(toolName)) continue;
        const isUnknown = isUnknownTool(toolName);

        if (typeof msg.output === "string") {
          msg.output = compressText(msg.output, stats, "openai-responses-string", isUnknown);
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "openai-responses-array", isUnknown);
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role:"tool", content: "string" }
      if (msg.role === "tool" && typeof msg.content === "string") {
        if (msg.is_error === true || msg.status === "error" || msg.isError === true) continue;
        const toolName = msg.name || toolCallMap.get(msg.tool_call_id) || "";
        if (isProtectedTool(toolName)) continue;
        const isUnknown = isUnknownTool(toolName);
        msg.content = compressText(msg.content, stats, "openai-tool", isUnknown);
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 1b: OpenAI tool message — { role:"tool", content:[{type:"text", text:"..."}] }
      if (msg.role === "tool") {
        if (msg.is_error === true || msg.status === "error" || msg.isError === true) continue;
        const toolName = msg.name || toolCallMap.get(msg.tool_call_id) || "";
        if (isProtectedTool(toolName)) continue;
        const isUnknown = isUnknownTool(toolName);
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "openai-tool-array", isUnknown);
          }
        }
        continue;
      }

      // Shape 2/3: blocks array with tool_result entries
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;
        if (block.is_error === true || block.status === "error" || block.isError === true) continue; // preserve error traces

        const toolName = block.name || toolCallMap.get(block.tool_use_id) || "";
        if (isProtectedTool(toolName)) continue;
        const isUnknown = isUnknownTool(toolName);

        if (typeof block.content === "string") {
          // Shape 2: claude string form
          block.content = compressText(block.content, stats, "claude-string", isUnknown);
        } else if (Array.isArray(block.content)) {
          // Shape 3: claude array form — compress each text part
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "claude-array", isUnknown);
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressMessages error:", e.message);
    return null;
  }
  return stats;
}

// Compress Kiro format: conversationState.history[].userInputMessage.userInputMessageContext.toolResults[].content[].text
function compressKiroFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  const toolCallMap = getToolCallMap(body);
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);

    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (tr.status === "error" || tr.is_error === true || tr.isError === true) continue; // preserve error traces
        const toolName = tr.name || toolCallMap.get(tr.toolUseId) || "";
        if (isProtectedTool(toolName)) continue;
        const isUnknown = isUnknownTool(toolName);

        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "kiro-tool-result", isUnknown);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressKiroFormat error:", e.message);
    return null;
  }
  return stats;
}

// Compress Gemini-family format: contents[].parts[].functionResponse.response.result.
// Pattern mirrors compressKiroFormat. Only result text may shrink — signatures,
// functionCall args, thought, and non-text parts (inlineData/fileData) are routing
// identity and must round-trip untouched. Antigravity wraps contents under
// body.request; mutate in place on the live array so both paths are covered.
function compressGeminiFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  const toolCallMap = getToolCallMap(body);
  try {
    const contents = Array.isArray(body.contents)
      ? body.contents
      : Array.isArray(body.request?.contents)
        ? body.request.contents
        : null;
    if (!contents) return stats;

    for (const content of contents) {
      const parts = Array.isArray(content?.parts) ? content.parts : null;
      if (!parts) continue;

      for (const part of parts) {
        const fr = part?.functionResponse;
        if (!fr || typeof fr !== "object") continue;
        // Skip explicit error results — preserve error traces.
        const resp = fr.response;
        if (resp && typeof resp === "object" && (resp.isError === true || resp.status === "error" || resp.is_error === true)) continue;

        const toolName = fr.name || toolCallMap.get(fr.id) || "";
        if (isProtectedTool(toolName)) continue;
        const isUnknown = isUnknownTool(toolName);

        const result = resp?.result;
        if (typeof result === "string") {
          resp.result = compressText(result, stats, "gemini-function-response", isUnknown);
        } else if (result && typeof result === "object" && typeof result.text === "string") {
          result.text = compressText(result.text, stats, "gemini-function-response", isUnknown);
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressGeminiFormat error:", e.message);
    return null;
  }
  return stats;
}

function compressText(text, stats, shape, isUnknown = false) {
  const bytesIn = Buffer.byteLength(text, "utf8");
  stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const fn = autoDetectFilter(text);
  if (!fn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  // Fail-open: do not apply generic fallbacks (smartTruncate, dedupLog) on unknown tool output
  if (isUnknown && (fn.filterName === "smart-truncate" || fn.filterName === "dedup-log")) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const out = safeApply(fn, text);

  // Safety: never return empty, never grow the input
  const bytesOut = typeof out === "string" ? Buffer.byteLength(out, "utf8") : bytesIn;
  if (!out || out.length === 0 || bytesOut >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  stats.bytesAfter += bytesOut;
  stats.hits.push({ shape, filter: fn.filterName || fn.name, saved: bytesIn - bytesOut });
  return out;
}

// Convenience: format a log line from stats
export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
