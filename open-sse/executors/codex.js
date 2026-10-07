import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS } from "../config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { normalizeResponsesInput, sanitizeResponsesToolName } from "../translator/formats/responsesApi.js";
import { fetchImageAsBase64 } from "../translator/concerns/image.js";
import { getModelUpstreamId, getProviderModels } from "../config/providerModels.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { DEFAULT_RETRY_CONFIG, HTTP_STATUS, STREAM_FIRST_CHUNK_TIMEOUT_MS, resolveRetryEntry } from "../config/runtimeConfig.js";
import { dbg } from "../utils/debugLog.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { stripCodexUnsupportedPatterns } from "../utils/codexToolSchema.js";

// SSE error patterns inside 200-OK bodies. Some retry same account first; capacity rotates accounts.
const CODEX_SSE_RETRY_PATTERNS = ["server_is_overloaded", "service_unavailable_error"];
const CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS = ["selected model is at capacity", "model_at_capacity"];
const CODEX_SSE_USER_OUTPUT_PATTERNS = [
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.reasoning.delta",
];
const CODEX_SSE_PEEK_BYTES = 256 * 1024;
const CODEX_MODEL_CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";

// Single-model peek bound. Post-header content wait uses the first-content
// constant directly: the connect timer is cleared when headers arrive, so it
// never fires against the body wait.
function codexPeekTimeoutMs() {
  return STREAM_FIRST_CHUNK_TIMEOUT_MS;
}

// Match capacity/retry patterns against error/capacity fields only — never
// user delta text. Returns { matched, accountFallback } or null.
function matchCodexSseErrorJson(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [];
  if (typeof value.message === "string") candidates.push(value.message);
  if (typeof value.code === "string") candidates.push(value.code);
  else if (value.code != null) candidates.push(String(value.code));
  if (typeof value.type === "string") candidates.push(value.type);
  const pushErr = (err) => {
    if (typeof err === "string") candidates.push(err);
    else if (err && typeof err === "object") {
      if (typeof err.message === "string") candidates.push(err.message);
      if (typeof err.code === "string") candidates.push(err.code);
      else if (err.code != null) candidates.push(String(err.code));
      if (typeof err.type === "string") candidates.push(err.type);
    }
  };
  pushErr(value.error);
  pushErr(value.response?.error);
  const lower = candidates.join("\n").toLowerCase();
  if (!lower.trim()) return null;
  const accountHit = CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS.find(p => lower.includes(p));
  if (accountHit) return { matched: accountHit, accountFallback: true };
  const retryHit = CODEX_SSE_RETRY_PATTERNS.find(p => lower.includes(p));
  if (retryHit) return { matched: retryHit, accountFallback: false };
  return null;
}

// Match one complete SSE line. data: JSON goes through the JSON gate;
// non-JSON data lines keep legacy substring behavior so plain-text upstream
// errors still trigger retry/fallback. Returns { matched, accountFallback } or null.
function matchCodexSseDataLine(line) {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  let parsed = null;
  try { parsed = JSON.parse(data); } catch { parsed = null; }
  if (parsed === null || typeof parsed !== "object") {
    const lower = data.toLowerCase();
    const accountHit = CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS.find(p => lower.includes(p));
    if (accountHit) return { matched: accountHit, accountFallback: true };
    const retryHit = CODEX_SSE_RETRY_PATTERNS.find(p => lower.includes(p));
    if (retryHit) return { matched: retryHit, accountFallback: false };
    return null;
  }
  return matchCodexSseErrorJson(parsed);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// Complete payloads carry generated text without a prior delta: reasoning
// text/summary done, reasoning or message item done, output_text done.
function isCodexCompleteContentJson(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.type === "response.reasoning_text.done" || parsed.type === "response.reasoning_summary_text.done") {
    return isNonEmptyString(parsed.text);
  }
  if (parsed.type === "response.output_text.done") {
    return isNonEmptyString(parsed.text);
  }
  if (parsed.type === "response.output_item.done") {
    const item = parsed.item;
    if (item?.type === "reasoning") {
      if (Array.isArray(item.summary) && item.summary.some((part) => isNonEmptyString(part?.text))) return true;
      return isNonEmptyString(item.text);
    }
    if (item?.type === "message") {
      if (Array.isArray(item.content) && item.content.some((part) => isNonEmptyString(part?.text))) return true;
      return isNonEmptyString(item.text);
    }
    return false;
  }
  return false;
}

function isCodexUserOutputLine(line) {
  if (line.startsWith("event:")) {
    return CODEX_SSE_USER_OUTPUT_PATTERNS.includes(line.slice(6).trim());
  }
  let parsed = null;
  try {
    parsed = JSON.parse(line.slice(5).trim());
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  // Error gate runs first: a structured error/capacity frame is never content,
  // even when it also carries generated text.
  if (matchCodexSseErrorJson(parsed)) return false;
  if (CODEX_SSE_USER_OUTPUT_PATTERNS.includes(parsed?.type)) return true;
  return isCodexCompleteContentJson(parsed);
}

// Classify one complete SSE line: { kind: "error", matched, accountFallback },
// { kind: "content" }, or null (keep scanning). Error detection is JSON-gated
// for data: lines; user-output detection covers event: and data: lines.
function scanCodexSseLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith(":")) return null;
  if (line.startsWith("event:")) {
    return isCodexUserOutputLine(line) ? { kind: "content" } : null;
  }
  if (!line.startsWith("data:")) return null;
  const hit = matchCodexSseDataLine(line);
  if (hit) return { kind: "error", matched: hit.matched, accountFallback: hit.accountFallback };
  return isCodexUserOutputLine(line) ? { kind: "content" } : null;
}

function isCodexResponsesLiteModel(model) {
  const baseId = String(model || "").replace(/\([^()]+\)\s*$/, "");
  return getProviderModels("cx").some((entry) => entry.id === baseId && entry.responsesLite === true);
}

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types that Codex/OpenAI Responses executes server-side
const CODEX_HOSTED_TOOL_TYPES = new Set([
  "image_generation", "web_search", "web_search_preview", "file_search",
  "computer", "computer_use_preview", "code_interpreter", "mcp", "local_shell",
  "tool_search"
]);

// Responses-native freeform tools carry a name plus format payload and must pass through intact.
const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(["custom"]);

// Allowlist of fields accepted by Codex Responses API — anything else is stripped
const RESPONSES_API_ALLOWLIST = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  "reasoning", "service_tier", "include", "prompt_cache_key", "client_metadata",
  "text", "parallel_tool_calls"
]);

// Convert role=system → role=developer in body.input (keeps content in cacheable prefix)
function convertSystemToDeveloperRole(body) {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const isSystemMsg = item.role === "system" && (!item.type || item.type === "message");
    if (isSystemMsg) item.role = "developer";
  }
}

// Strip server-generated item IDs (rs_/fc_/resp_/msg_) from input — avoids 404 with store=false.
// Also strip function_call ids not matching 'fc' prefix (Codex 400 rejection).
function stripStoredItemReferences(body, preserveLitePrefix = false) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      if (typeof item.id === "string") {
        if (SERVER_ID_PATTERN.test(item.id) && !(preserveLitePrefix && item.role === "developer" && item.id.startsWith("msg_"))) delete item.id;
        else if (item.type === "function_call" && !item.id.startsWith("fc")) delete item.id;
      }
    }
    return true;
  });
}

// Flatten Chat-Completions tool shape into Responses flat format + filter unsupported tools
function normalizeCodexTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  // Codex's schema validator has no Unicode property escapes; a `pattern`
  // carrying `\p{...}` 400s the whole request on every account (#3922).
  const patternStats = { removed: 0 };
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (type === "namespace") {
      if (Array.isArray(tool.tools)) {
        for (const st of tool.tools) {
          const n = typeof st?.name === "string" ? st.name.trim().slice(0, 128) : "";
          if (n) validNames.add(n);
          if (st?.parameters && typeof st.parameters === "object") {
            st.parameters = stripCodexUnsupportedPatterns(st.parameters, patternStats);
          }
        }
      }
      return true;
    }
    if (type !== "function") {
      if (CODEX_PASSTHROUGH_TOOL_TYPES.has(type)) return true;
      if (!type || tool.function || typeof tool.name === "string") return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    const parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    const strict = typeof tool.strict === "boolean" ? tool.strict
      : (fn && typeof fn.strict === "boolean" ? fn.strict : undefined);
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    const sanitizedName = sanitizeResponsesToolName(name, validNames);
    tool.name = sanitizedName;
    if (description) tool.description = description;
    tool.parameters = stripCodexUnsupportedPatterns(parameters, patternStats);
    if (typeof strict === "boolean") tool.strict = strict;
    validNames.add(sanitizedName);
    return true;
  });
  if (patternStats.removed > 0) {
    dbg("CODEX", `stripped ${patternStats.removed} unsupported tool schema pattern(s)`);
  }
  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
  // Sanitize function_call / custom_tool_call names in input history
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item && typeof item === "object" && (item.type === "function_call" || item.type === "custom_tool_call")) {
        if (typeof item.name === "string" && item.name) {
          item.name = sanitizeResponsesToolName(item.name);
        }
      }
    }
  }
}

// Resolve prompt-cache session id: client session → assistant-text-hash → workspaceId → connection
function resolveCacheSessionId(body, credentials) {
  return resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    workspaceId: credentials?.providerSpecificData?.workspaceId,
    scope: "codex"
  });
}

function normalizeReasoningEffort(model, value) {
  if (isCodexResponsesLiteModel(model) && (value === "none" || value === "minimal")) return "low";
  const supportedLevels = getThinkingLevels("codex", model);
  if (supportedLevels?.includes(value)) return value;
  if (value === "ultra" && supportedLevels?.includes("max")) return "max";
  if (value === "max" || value === "ultra") return "xhigh";
  return value;
}

function findNestedMessage(value, depth = 0) {
  if (!value || depth > 6 || typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  if (typeof value.error?.message === "string" && value.error.message.trim()) return value.error.message;
  if (typeof value.response?.error?.message === "string" && value.response.error.message.trim()) return value.response.error.message;
  for (const child of Object.values(value)) {
    const found = findNestedMessage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractSseErrorMessage(text, fallback) {
  const exact = text?.match(/Selected model is at capacity\. Please try a different model\./i)?.[0];
  if (exact) return exact;

  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const message = findNestedMessage(JSON.parse(data));
      if (message) return message;
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }

  return fallback || CODEX_MODEL_CAPACITY_MESSAGE;
}

function codexSseErrorResponse(status, message) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: status === HTTP_STATUS.SERVICE_UNAVAILABLE ? "service_unavailable" : "upstream_error",
    }
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing
 */
export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
    this._currentSessionId = null;
  }

  /**
   * Override headers to add codex-specific identity headers.
   * transformRequest runs BEFORE buildHeaders, sets this._currentSessionId.
   */
  buildHeaders(credentials, stream = true, _url = null, model = null) {
    const headers = super.buildHeaders(credentials, stream);
    if (isCodexResponsesLiteModel(model && getModelUpstreamId("cx", model))) {
      headers["x-openai-internal-codex-responses-lite"] = "true";
    }
    headers["session_id"] = this._currentSessionId || credentials?.connectionId || "default";
    // Identify client type to Codex backend (matches official codex CLI)
    if (!headers["originator"]) headers["originator"] = "codex_cli_rs";
    // Account/workspace binding header — required when multiple Codex accounts
    // are configured. OAuth import stores ChatGPT account ID as chatgptAccountId;
    // older/custom rows may use workspaceId/accountId. Prefer explicit workspaceId
    // but fall back to chatgptAccountId so requests don't cross-bind to the wrong
    // OpenAI account and surface as token_invalid after adding another account.
    const accountId =
      credentials?.providerSpecificData?.workspaceId ||
      credentials?.providerSpecificData?.chatgptAccountId ||
      credentials?.providerSpecificData?.accountId;
    if (typeof accountId === "string" && accountId && !headers["ChatGPT-Account-ID"]) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
    return headers;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = super.buildUrl(model, stream, urlIndex, credentials);
    return this._isCompact ? `${base}/compact` : base;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codex", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codex", credentials);
  }

  /**
   * Prefetch remote image URLs and inline them as base64 data URIs.
   * Runs before execute() because Codex backend cannot fetch remote images.
   * Mutates body.input in place.
   */
  async prefetchImages(body) {
    if (!Array.isArray(body?.input)) return;
    const jobs = [];
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      item.content.forEach((c, idx) => {
        if (c?.type !== "image_url") return;
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const detail = c.image_url?.detail || "auto";
        if (!url) return;
        if (url.startsWith("data:")) {
          item.content[idx] = { type: "input_image", image_url: url, detail };
          return;
        }
        jobs.push({ item, idx, url, detail });
      });
    }
    // ponytail: uncapped parallel fetch; upgrade path = p-limit/chunked when large batches expected
    await Promise.all(jobs.map(async ({ item, idx, url, detail }) => {
      const t0 = Date.now();
      try {
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000 });
        item.content[idx] = { type: "input_image", image_url: fetched?.url || url, detail };
      } catch {
        item.content[idx] = { type: "input_image", image_url: url, detail };
      } finally {
        dbg("CODEX", `prefetch ${String(url).slice(0, 80)} | ${Date.now() - t0}ms`);
      }
    }));
  }

  async execute(args) {
    const imgCount = Array.isArray(args.body?.input) ? args.body.input.reduce((n, it) => n + (Array.isArray(it.content) ? it.content.filter(c => c.type === "image_url").length : 0), 0) : 0;
    const inputLen = Array.isArray(args.body?.input) ? args.body.input.length : 0;
    dbg("CODEX", `execute start | inputItems=${inputLen} | images=${imgCount} | sessionId=${this._currentSessionId || "pending"}`);
    if (imgCount > 0) {
      const t0 = Date.now();
      await this.prefetchImages(args.body);
      dbg("CODEX", `prefetchImages done | ${Date.now() - t0}ms`);
    } else {
      await this.prefetchImages(args.body);
    }

    // Retry loop for SSE-level overloaded errors (200 OK body contains event: error)
    // Reuses 503 retry config — same semantic: upstream temporarily unavailable
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const { attempts, delayMs } = resolveRetryEntry(retryConfig[503]);
    let attempt = 0;
    while (true) {
      const result = await super.execute(args);
      if (args.skipSsePeek) return result;
      const peek = await this._peekSseTransientError(result.response, { signal: args.signal });
      if (!peek.matched) {
        // Replace body with re-assembled stream (prefix bytes already read + rest)
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        return result;
      }
      if (peek.accountFallback) {
        args.log?.warn?.("RETRY", `CODEX | SSE account fallback "${peek.message}"`);
        result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || CODEX_MODEL_CAPACITY_MESSAGE);
        return result;
      }
      if (attempt >= attempts) {
        args.log?.warn?.("RETRY", `CODEX | SSE overloaded "${peek.matched}" — retries exhausted (${attempt}/${attempts})`);
        result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || peek.matched);
        return result;
      }
      attempt++;
      args.log?.debug?.("RETRY", `CODEX | SSE "${peek.matched}" retry ${attempt}/${attempts} after ${delayMs / 1000}s`);
      dbg("CODEX", `SSE overloaded "${peek.matched}" → retry ${attempt}/${attempts} in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Peek first N bytes of SSE body to detect upstream transient errors.
  // Returns { matched: string|null, message: string|null, accountFallback: boolean, replacementBody: ReadableStream|null }.
  // Caller must use replacementBody when no error matched (original body has been read).
  async _peekSseTransientError(response, { timeoutMs = codexPeekTimeoutMs(), signal = null } = {}) {
    if (!response || !response.ok || !response.body) return { matched: null, message: null, accountFallback: false, replacementBody: null };
    if (signal?.aborted) return { matched: null, message: null, accountFallback: false, replacementBody: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let rawBytes = 0;
    let text = "";
    let pending = "";
    let matched = null;
    let accountFallback = false;
    let peekError = null;
    let timedOut = false;
    let settled = false;
    let timer = null;

    let abortResolve = null;
    const abortPromise = signal
      ? new Promise((resolve) => { abortResolve = resolve; })
      : null;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reader.cancel(signal?.reason).catch(() => {});
      abortResolve?.("aborted");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanupAbort = signal ? () => signal.removeEventListener("abort", onAbort) : null;

    try {
      const readLoop = (async () => {
        try {
          for (;;) {
            if (settled) return "aborted";
            let readResult;
            try {
              readResult = abortPromise
                ? await Promise.race([reader.read(), abortPromise.then(() => ({ aborted: true }))])
                : await reader.read();
            } catch (e) {
              // Propagate: reassembling a truncated body as clean loses data.
              if (!settled) { settled = true; peekError = e; }
              return "error";
            }
            if (settled) return "aborted";
            if (readResult?.aborted || signal?.aborted) { settled = true; return "aborted"; }
            const { done, value } = readResult;
            if (done) {
              settled = true;
              return "done";
            }
            chunks.push(value);
            rawBytes += value.byteLength;
            const decoded = decoder.decode(value, { stream: true });
            text += decoded;

            // Only scan complete lines; a JSON frame split across chunks must
            // not be judged on its first half.
            pending += decoded;
            let newline;
            let lineDone = false;
            while ((newline = pending.indexOf("\n")) !== -1) {
              const frame = scanCodexSseLine(pending.slice(0, newline));
              pending = pending.slice(newline + 1);
              if (!frame) continue;
              if (frame.kind === "error") { matched = frame.matched; accountFallback = frame.accountFallback; lineDone = true; break; }
              lineDone = true;
              break;
            }
            if (matched || lineDone) { settled = true; return matched ? "error_frame" : "content"; }
            if (rawBytes >= CODEX_SSE_PEEK_BYTES) { settled = true; return "budget"; }
          }
        } catch (e) {
          if (!settled) { settled = true; peekError = e; }
          return "error";
        }
      })();

      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          settled = true;
          reader.cancel().catch(() => {});
          resolve("timeout");
        }, timeoutMs);
        if (timer.unref) timer.unref();
      });
      const outcome = await Promise.race([readLoop, timeoutPromise]);

      if (outcome === "aborted" || signal?.aborted) {
        await reader.cancel(signal?.reason).catch(() => {});
        try { reader.releaseLock(); } catch { /* noop */ }
        const reason = signal?.reason;
        throw reason instanceof Error ? reason : new DOMException(String(reason ?? "aborted"), "AbortError");
      }
      if (peekError) throw peekError;
      if (outcome === "timeout" || timedOut) {
        // Stalled body: reader cancelled, stream not replayable. Surface as a
        // retryable transient so the execute() retry loop handles it (same
        // semantic as SSE overloaded), ending in 503 when retries exhaust.
        try { await reader.cancel(); } catch { /* noop */ }
        try { reader.releaseLock(); } catch { /* noop */ }
        return { matched: "peek_timeout", message: "Upstream stream stalled before first frame", accountFallback: false, replacementBody: null, timedOut: true };
      }
      // Scan tail frame without trailing newline. Budget tail is partial by
      // definition — never judge it, the prefix replay preserves it verbatim.
      if (!matched && (outcome === "done" || outcome === "error_frame" || outcome === "content")) {
        text += decoder.decode();
        const tail = pending.trim();
        pending = "";
        if (tail && !matched) {
          const frame = scanCodexSseLine(tail);
          if (frame?.kind === "error") { matched = frame.matched; accountFallback = frame.accountFallback; }
        }
      }
    } catch (e) {
      try { await reader.cancel(); } catch { /* noop */ }
      try { reader.releaseLock(); } catch { /* noop */ }
      cleanupAbort?.();
      throw e;
    } finally {
      settled = true;
      if (timer) clearTimeout(timer);
      cleanupAbort?.();
    }

    if (matched) {
      try { await reader.cancel(); } catch { /* noop */ }
      try { reader.releaseLock(); } catch { /* noop */ }
      // ponytail: timedOut message is fixed text; extractSseErrorMessage would
      // fall back to the "peek_timeout" sentinel. Keep extractor for real frames.
      const message = timedOut
        ? "Upstream stream stalled before first frame"
        : extractSseErrorMessage(text, matched);
      return { matched, message, accountFallback, replacementBody: null, timedOut };
    }

    reader.releaseLock();

    // Re-assemble stream: prefix chunks + remaining upstream body
    const upstream = response.body;
    let upstreamReader = null;
    const replacementBody = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        upstreamReader = upstream.getReader();
      },
      async pull(controller) {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        } catch (e) { controller.error(e); }
      },
      cancel(reason) {
        try { upstreamReader?.cancel(reason); } catch { /* noop */ }
      },
    });
    return { matched: null, message: null, accountFallback: false, replacementBody };
  }

  // Parse Codex usage_limit_reached to extract precise resetsAtMs; fallback to default otherwise
  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const err = json?.error;
        if (err?.type === "usage_limit_reached") {
          const now = Date.now();
          let resetsAtMs = null;
          if (typeof err.resets_at === "number" && err.resets_at > 0) {
            const ms = err.resets_at * 1000;
            if (ms > now) resetsAtMs = ms;
          }
          if (!resetsAtMs && typeof err.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
            resetsAtMs = now + err.resets_in_seconds * 1000;
          }
          if (resetsAtMs) {
            return { status: 429, message: err.message || bodyText, resetsAtMs };
          }
        }
      } catch { /* fall through to default */ }
    }
    return super.parseError(response, bodyText);
  }

  /**
   * Transform request before sending - inject default instructions if missing.
   * Image fetching is handled separately in prefetchImages() so this stays sync.
   */
  transformRequest(model, body, stream, credentials) {
    this._isCompact = !!body._compact;
    delete body._compact;
    // Resolve conversation-stable session_id (priority: body → assistant-text → workspace → machine)
    this._currentSessionId = resolveCacheSessionId(body, credentials);
    // Convert string input to array format (Codex API requires input as array)
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // Ensure input is present and non-empty (Codex API rejects empty input)
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }

    // Keep system prompts in body.input as role=developer so they stay in the cacheable prefix
    convertSystemToDeveloperRole(body);
    // Strip server-generated item IDs (rs_/fc_/resp_/msg_) — Codex /responses can't resolve when store=false
    const upstreamModel = getModelUpstreamId("cx", body.model || model);
    const responsesLite = isCodexResponsesLiteModel(upstreamModel);
    stripStoredItemReferences(body, responsesLite);
    // Flatten function tools + drop unsupported types
    normalizeCodexTools(body);

    // Ensure streaming is enabled (Codex API requires it)
    body.stream = true;

    // If no instructions provided, inject default Codex instructions
    if (!responsesLite && (!body.instructions || body.instructions.trim() === "")) {
      body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Ensure store is false (Codex requirement)
    body.store = false;

    // Inject prompt_cache_key for stable Codex prompt caching
    if (!body.prompt_cache_key && this._currentSessionId) {
      body.prompt_cache_key = this._currentSessionId;
    }

    // Map virtual Codex review models to the upstream Codex model before suffix parsing.
    body.model = upstreamModel;

    if (responsesLite) {
      // Codex 0.155 carries tools and instructions as input prefix items.
      const input = Array.isArray(body.input) ? body.input : [body.input];
      const hasLitePrefix = input.some((item) => item?.type === "additional_tools");
      if (!hasLitePrefix) {
        const instructions = typeof body.instructions === "string" && body.instructions.trim()
          ? body.instructions : CODEX_DEFAULT_INSTRUCTIONS;
        const prefix = [{ type: "additional_tools", role: "developer", tools: Array.isArray(body.tools) ? body.tools : [] }];
        if (instructions) {
          prefix.push({ type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] });
        }
        input.unshift(...prefix);
      }
      body.input = input;
      body.instructions = "";
      body.tools = null;
      body.tool_choice ||= "auto";
      body.parallel_tool_calls = false;
    } else {
      delete body.parallel_tool_calls;
    }

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    let modelEffort = null;
    for (const level of effortLevels) {
      if (body.model.endsWith(`-${level}`)) {
        modelEffort = level;
        // Strip suffix from model name for actual API call
        body.model = body.model.replace(`-${level}`, '');
        break;
      }
    }

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (medium)
    if (!body.reasoning) {
      const effort = normalizeReasoningEffort(body.model, body.reasoning_effort || modelEffort || (responsesLite ? 'medium' : 'low'));
      body.reasoning = responsesLite ? { effort } : { effort, summary: "auto" };
    } else {
      body.reasoning.effort = normalizeReasoningEffort(body.model, body.reasoning.effort);
      if (!responsesLite && !body.reasoning.summary) body.reasoning.summary = "auto";
    }
    if (responsesLite) body.reasoning.context = "all_turns";
    delete body.reasoning_effort;

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none') {
      body.include = ["reasoning.encrypted_content"];
    }

    // Remove unsupported parameters for Codex API
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.max_output_tokens; // Responses API clients send this but Codex rejects it
    delete body.user; // Cursor sends this but Codex doesn't support it
    delete body.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete body.metadata; // Cursor sends this but Codex doesn't support it
    delete body.stream_options; // Cursor sends this but Codex doesn't support it
    delete body.safety_identifier; // Droid CLI sends this but Codex doesn't support it
    delete body.previous_response_id; // store=false → backend can't resolve previous resp; avoid 404

    if (body.service_tier === "fast") body.service_tier = "priority";
    if (body.service_tier && body.service_tier !== "priority") delete body.service_tier;

    // Final allowlist filter — strip any unknown field that could trigger upstream "routing_unsupported"
    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    return body;
  }
}
