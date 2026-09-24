/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!dataMatch) return;

  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  const eventType = eventMatch ? eventMatch[1].trim() : (parsed?.type || parsed?.event || "");
  if (!eventType) return;

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
    if (parsed.response?.model) state.model = parsed.response.model;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
    // Terminal events carry the REAL upstream status: OpenAI emits
    // response.completed with status:"incomplete" + incomplete_details when
    // max_output_tokens truncates the output. Hardcoding "completed" turned
    // truncation into a normal stop for non-streaming clients.
    // A prior error event keeps failure: a terminal completed after an error
    // must not resurrect pre-error chunks into a success body.
    if (state.sawError) return;
    state.sawTerminal = true;
    if (parsed.response?.id) state.responseId = parsed.response.id;
    if (parsed.response?.created_at) state.created = parsed.response.created_at;
    if (parsed.response?.model) state.model = parsed.response.model;
    if (parsed.response?.status) {
      state.status = parsed.response.status;
      if (parsed.response?.incomplete_details !== undefined && parsed.response?.incomplete_details !== null) {
        state.incomplete_details = parsed.response.incomplete_details;
      }
    } else {
      // Terminal event without explicit status: completed is terminal,
      // incomplete means truncated — keep the contract signal either way.
      state.status = eventType === "response.incomplete" ? "incomplete" : "completed";
    }
    if (parsed.response?.usage) {
      state.usage = {
        ...state.usage,
        ...parsed.response.usage,
        input_tokens: parsed.response.usage.input_tokens || 0,
        output_tokens: parsed.response.usage.output_tokens || 0,
        total_tokens: parsed.response.usage.total_tokens || 0,
      };
    }
    // Terminal carries authoritative response.output. If present, clear
    // partial items so stale items outside authoritative list do not remain.
    if (Array.isArray(parsed.response?.output)) {
      state.items.clear();
      const terminal = parsed.response.output;
      for (let i = 0; i < terminal.length; i++) {
        state.items.set(i, terminal[i]);
      }
    }
  } else if (eventType === "response.failed") {
    state.sawTerminal = true;
    state.sawError = true;
    state.status = "failed";
    if (parsed.response?.id) state.responseId = parsed.response.id;
    if (parsed.response?.created_at) state.created = parsed.response.created_at;
    if (parsed.response?.model) state.model = parsed.response.model;
    if (parsed.response?.error) state.error = parsed.response.error;
    // An error event before DONE fails the turn even if a later terminal says
    // completed: never return a success tool_use body from pre-error chunks.
  } else if (eventType === "error") {
    state.sawTerminal = true;
    state.sawError = true;
    state.status = "failed";
    if (parsed.response?.id) state.responseId = parsed.response.id;
    if (parsed.error) state.error = parsed.error;
    else if (parsed.response?.error) state.error = parsed.response.error;
    else state.error = { message: "Upstream SSE error event before DONE" };
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    sawTerminal: false,
    incomplete_details: undefined,
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split(/\r?\n\r?\n/);
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  // A stream that never emitted a Responses terminal event
  // (response.completed / response.done / response.incomplete / response.failed)
  // has no trustworthy outcome — never return in_progress as a success body.
  // Mirror the streaming path (response.failed + [DONE]) so non-streaming
  // clients get failed instead of an in_progress HTTP200.
  const finalStatus = state.sawTerminal ? (state.status || "completed") : "failed";
  const result = {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    ...(state.model ? { model: state.model } : {}),
    status: finalStatus,
    ...(state.incomplete_details ? { incomplete_details: state.incomplete_details } : {}),
    output,
    usage: state.usage
  };
  if (state.error !== undefined && finalStatus === "failed") {
    result.error = state.error;
  }
  return result;
}
