// Shared helpers for OpenAI-shaped → Claude streaming translators.
// Used by both response/openai-to-claude.js and response/kiro-to-claude.js
// so the two direct Claude routes don't drift.

// Repair duplicated / repeated JSON objects emitted by upstream proxies or
// cumulative streams: exact-half repeats ("{...}" + "{...}") and concatenated
// objects ("{...}{...}"). Returns the original string when nothing matches.
export function repairDuplicatedJsonArguments(raw) {
  if (typeof raw !== "string" || raw.length < 4) return raw;
  try {
    JSON.parse(raw);
    return raw;
  } catch {}

  const len = raw.length;
  if (len % 2 === 0) {
    const half = raw.slice(0, len / 2);
    if (half === raw.slice(len / 2)) {
      try {
        JSON.parse(half);
        return half;
      } catch {}
    }
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = trimmed.slice(0, i + 1);
            try {
              JSON.parse(candidate);
              const remainder = trimmed.slice(i + 1).trim();
              if (remainder.startsWith("{")) {
                return candidate;
              }
            } catch {
              break;
            }
          }
        }
      }
    }
  }

  return raw;
}

// Append streamed tool-call arguments. Upstreams stream either diff chunks
// (append) or cumulative snapshots (full string starting with what we have);
// repeated full payloads (proxy resends the whole args on the finish chunk)
// must not double the buffer.
export function appendToolArgs(current, incoming) {
  if (!incoming) return current || "";
  if (!current) return incoming;
  if (incoming === current) return current;
  if (incoming.startsWith(current)) return incoming;
  return current + incoming;
}

export const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Map common non-Claude model aliases (path, file, filepath, filename) to file_path
export function sanitizeFileArgs(args) {
  if (!args || typeof args !== "object") return;
  if (!args.file_path) {
    const alias = args.path || args.filepath || args.file || args.filename || args.target;
    if (typeof alias === "string" && alias.trim()) {
      args.file_path = alias.trim();
    }
  }
}

export function sanitizeNotebookArgs(args) {
  if (!args || typeof args !== "object") return;
  if (!args.notebook_path) {
    const alias = args.path || args.filepath || args.file || args.file_path || args.filename;
    if (typeof alias === "string" && alias.trim()) {
      args.notebook_path = alias.trim();
    }
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return (
    typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages)
  );
}

export function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

// Sanitize tool call arguments to fix bad params from non-Anthropic models.
// Fast path: single parse for the common valid case; repair only on failure.
export function sanitizeToolArgs(toolName, argsJson) {
  let args;
  try {
    args = typeof argsJson === "object" && argsJson !== null ? argsJson : JSON.parse(argsJson);
  } catch {
    const repairedJson = repairDuplicatedJsonArguments(argsJson);
    try {
      args = JSON.parse(repairedJson);
    } catch {
      return repairedJson;
    }
  }
  const name = typeof toolName === "string" && toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
    ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
    : toolName;
  if (name === "Read" || name === "Edit" || name === "Write") sanitizeFileArgs(args);
  if (name === "NotebookEdit") sanitizeNotebookArgs(args);
  if (name === "Read") sanitizeReadArgs(args);
  return typeof argsJson === "object" && argsJson !== null ? args : JSON.stringify(args);
}
