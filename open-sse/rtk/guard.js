// Port of Rust core/guard.rs never_worse + tracking estimate_tokens.
// Stricter than Rust: also never-empty and never-grow (byte length), so
// filters can use this as the single post-condition.
// ponytail: estimate is native UTF-8 bytes/4; upgrade to a tokenizer count if filters
// ever need byte-growth-with-token-shrink (Rust tie-keeps-filtered).
export function estimateTokens(s) {
  if (!s) return 0;
  return Math.ceil(Buffer.byteLength(s, "utf8") / 4);
}

export function neverWorse(raw, filtered) {
  if (typeof filtered !== "string" || filtered.length === 0) return raw;
  if (typeof raw !== "string") return raw;
  const rawBytes = Buffer.byteLength(raw, "utf8");
  const filteredBytes = Buffer.byteLength(filtered, "utf8");
  if (filteredBytes > rawBytes) return raw;
  if (estimateTokens(filtered) > estimateTokens(raw)) return raw;
  return filtered;
}

// Protected code editing tools: their content must never be compressed
// or transformed into log summaries.
export const PROTECTED_TOOLS = new Set([
  "Read",
  "Grep",
  "Edit",
  "Write",
  "patch",
  "anchor",
]);

export function isProtectedTool(name) {
  if (!name || typeof name !== "string") return false;
  return PROTECTED_TOOLS.has(name) || PROTECTED_TOOLS.has(name.trim());
}

// Known command execution / terminal tools where log/command filters may apply
export const KNOWN_COMMAND_TOOLS = new Set([
  "bash",
  "sh",
  "terminal",
  "shell",
  "exec",
  "cmd",
  "powershell",
  "command_runner",
  "run_terminal_cmd",
  "execute_command",
  "read_file",
  "write_file",
  "read",
  "f",
]);

export function isUnknownTool(name) {
  if (!name || typeof name !== "string") return true;
  const n = name.trim();
  if (n === "unknown" || n === "unknown_tool") return true;
  return !KNOWN_COMMAND_TOOLS.has(n) && !isProtectedTool(n);
}

// Resolve historical tool calls (id -> toolName) across all wire formats
export function getToolCallMap(body) {
  const map = new Map();
  if (!body || typeof body !== "object") return map;

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg?.role === "assistant") {
        if (Array.isArray(msg.tool_calls)) {
          for (const call of msg.tool_calls) {
            if (call?.id) map.set(call.id, call.function?.name || "");
          }
        }
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === "tool_use" && part.id) {
              map.set(part.id, part.name || "");
            }
          }
        }
      }
    }
  }

  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === "function_call" && item.call_id) {
        map.set(item.call_id, item.name || "");
      }
    }
  }

  const state = body.conversationState;
  if (state && typeof state === "object") {
    const items = [...(Array.isArray(state.history) ? state.history : []), state.currentMessage].filter(Boolean);
    for (const item of items) {
      const toolUses = item?.assistantResponseMessage?.toolUses;
      if (Array.isArray(toolUses)) {
        for (const tu of toolUses) {
          if (tu?.toolUseId) map.set(tu.toolUseId, tu.name || "");
        }
      }
    }
  }

  const contents = Array.isArray(body.contents) ? body.contents : body.request?.contents;
  if (Array.isArray(contents)) {
    for (const content of contents) {
      for (const part of (Array.isArray(content?.parts) ? content.parts : [])) {
        if (part?.functionCall?.id) {
          map.set(part.functionCall.id, part.functionCall.name || "");
        }
      }
    }
  }

  return map;
}
