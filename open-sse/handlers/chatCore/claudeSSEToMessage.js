/**
 * Parse native Claude SSE (non-streaming capture) into a single Claude Message.
 * Only imported by nonStreamingHandler.js — never by streaming/sseToJson paths.
 *
 * Contract: parseClaudeSSEToMessage(rawSSE, fallbackModel) -> { message } | { error: { code, message } }
 * Error text is parser-composed (no provider/model params, no upstream payload echo).
 *
 * ponytail: hand-rolled SSE framing (single consumer); extract a shared
 * sseFrames() tokenizer when a second Claude-SSE consumer appears.
 */
export function parseClaudeSSEToMessage(rawSSE, fallbackModel = "claude-3-5-sonnet") {
  const TOKEN_KEYS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  const pickUsage = (u) => Object.fromEntries(
    Object.entries(u || {}).filter(([k, v]) => TOKEN_KEYS.includes(k) && typeof v === "number" && Number.isFinite(v))
  );
  const message = {
    id: "", type: "message", role: "assistant", model: fallbackModel,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const blocks = new Map();
  let sawMessageStart = false;
  let sawMessageStop = false;
  let stickyError = null;
  let malformed = 0;
  let curEvent = "";
  let curData = [];

  const flush = () => {
    if (!curEvent && curData.length === 0) return;
    const evt = curEvent;
    const raw = curData.join("\n");
    curEvent = "";
    curData = [];
    if (evt === "error") {
      stickyError = stickyError || { code: "upstream_error", message: "Upstream Claude stream returned an error event" };
      return;
    }
    if (!raw) return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      malformed += 1;
      return;
    }
    if (payload?.type === "error" || payload?.error) {
      stickyError = stickyError || { code: "upstream_error", message: "Upstream Claude stream returned an error payload" };
      return;
    }
    // No new content after the terminal frame: late blocks/deltas cannot
    // resurrect or extend a closed turn (second message_stop stays idempotent).
    if (sawMessageStop) return;
    const type = payload?.type || evt;
    if (type === "message_start") {
      sawMessageStart = true;
      if (typeof payload.message?.id === "string") message.id = payload.message.id;
      if (payload.message?.model) message.model = payload.message.model;
      if (payload.message?.usage) message.usage = { ...message.usage, ...pickUsage(payload.message.usage) };
    } else if (type === "content_block_start") {
      const b = { ...(payload.content_block || {}) };
      // entry.text/signature/json is this block's own accumulator — kept off
      // `block` so no temp key ever leaks into message.content.
      blocks.set(payload.index, {
        block: b, text: b.text ?? b.thinking ?? "", signature: b.signature ?? "", json: "", stopped: false,
      });
    } else if (type === "content_block_delta") {
      const entry = blocks.get(payload.index);
      const d = payload.delta || {};
      if (entry) {
        if (d.type === "text_delta" || d.type === "thinking_delta") entry.text += d.text ?? d.thinking ?? "";
        else if (d.type === "signature_delta") entry.signature += d.signature ?? "";
        else if (d.type === "input_json_delta") entry.json += d.partial_json ?? "";
      }
    } else if (type === "content_block_stop") {
      const entry = blocks.get(payload.index);
      if (entry) {
        entry.stopped = true;
        if (entry.block.type === "tool_use" && entry.json) {
          try {
            entry.block.input = JSON.parse(entry.json);
          } catch {
            stickyError = stickyError || {
              code: "truncated_tool_input",
              message: `Upstream Claude SSE stream has truncated tool_use input for ${fallbackModel}`,
            };
          }
        }
      }
    } else if (type === "message_delta") {
      if (payload.delta?.stop_reason) message.stop_reason = payload.delta.stop_reason;
      if (payload.delta?.stop_sequence) message.stop_sequence = payload.delta.stop_sequence;
      // Never zero-out input/cache the delta does not mention.
      if (payload.usage) message.usage = { ...message.usage, ...pickUsage(payload.usage) };
    } else if (type === "message_stop") {
      sawMessageStop = true;
    }
  };

  for (const line of String(rawSSE ?? "").split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line === "") flush();
    else if (line.startsWith("event:")) curEvent = line.slice(6).trim();
    else if (line.startsWith("data:")) curData.push(line.slice(5).trimStart());
  }
  flush(); // trailing frame without a blank terminator still dispatches

  if (stickyError) return { error: stickyError };
  if (!sawMessageStart) return { error: { code: "missing_message_start", message: "Upstream Claude SSE stream never sent message_start" } };
  if (!sawMessageStop) return { error: { code: "missing_message_stop", message: "Upstream Claude SSE stream never sent message_stop" } };
  if (malformed > 0) return { error: { code: "malformed_data", message: `Upstream Claude SSE stream contained ${malformed} unparseable data frame(s)` } };

  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const entry = blocks.get(index);
    if (!entry.stopped) return { error: { code: "block_not_stopped", message: `Upstream Claude SSE stream left content block ${index} open` } };
    const block = { ...entry.block };
    if (block.type === "text") block.text = entry.text;
    else if (block.type === "thinking") {
      block.thinking = entry.text;
      if (entry.signature) block.signature = entry.signature;
    } else if (block.type === "tool_use" && (block.input === undefined || block.input === null || typeof block.input !== "object")) {
      block.input = {}; // missing/non-object seeded input is still a valid empty object
    }
    message.content.push(block); // unknown blocks (server_tool_use, redacted_thinking) pass through untouched
  }
  return { message };
}
