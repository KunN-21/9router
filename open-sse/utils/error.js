import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, isPermanentModelError, OPENCODE_POLICY_CODES } from "../config/errorConfig.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string} [errorType] - Optional error type override
 * @param {string} [errorCode] - Optional error code override
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message, errorType = null, errorCode = null) {
  const errorInfo = ERROR_TYPES[statusCode] ||
    (statusCode >= 500
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  const rawType = typeof errorType === "string" ? errorType : null;
  const rawCode = typeof errorCode === "string" ? errorCode : null;
  const policyKey = rawCode || rawType;
  const isPolicyKey = Boolean(
    policyKey &&
    OPENCODE_POLICY_CODES &&
    Object.prototype.hasOwnProperty.call(OPENCODE_POLICY_CODES, policyKey)
  );

  let finalType = errorInfo.type;
  let finalCode = errorInfo.code;

  if (statusCode === 403 && isPolicyKey) {
    finalType = "permission_error";
    finalCode = OPENCODE_POLICY_CODES[policyKey];
  }

  const errObj = {
    message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
    type: finalType,
    code: finalCode
  };

  if (rawType && OPENCODE_POLICY_CODES && Object.prototype.hasOwnProperty.call(OPENCODE_POLICY_CODES, rawType)) {
    errObj.upstream_type = rawType;
  }

  return { error: errObj };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {object} [extraHeaders] - Optional headers
 * @param {string} [errorType] - Optional error type override
 * @param {string} [errorCode] - Optional error code override
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, extraHeaders = null, errorType = null, errorCode = null) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message, errorType, errorCode)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string} [errorType] - Optional error type override
 * @param {string} [errorCode] - Optional error code override
 */
export async function writeStreamError(writer, statusCode, message, errorType = null, errorCode = null) {
  const errorBody = buildErrorBody(statusCode, message, errorType, errorCode);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number, errorType?: string, errorCode?: string}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  let resetsAtMs;
  let executorMessage = null;
  let executorStatus = null;
  let executorErrorType = null;
  let executorErrorCode = null;
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        executorStatus = parsed.status;
        if (parsed.message) executorMessage = parsed.message;
        if (parsed.resetsAtMs) resetsAtMs = parsed.resetsAtMs;
        if (parsed.errorType) executorErrorType = parsed.errorType;
        if (parsed.errorCode) executorErrorCode = parsed.errorCode;
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  let errorType = executorErrorType || null;
  let errorCode = executorErrorCode || null;
  let errorCap = null;

  // The live free tier sends its quota window as a `retry-after` HEADER on a
  // body that carries nothing else (`{"type":"error","error":{"type":
  // "FreeUsageLimitError",...}}`). Reading only the body would leave the
  // cooldown at the router's 2s..5min guess against a window that can run to
  // the next UTC midnight, so the header is the authoritative source.
  const retryAfterHeader = response.headers?.get?.("retry-after");
  if (retryAfterHeader && resetsAtMs === undefined) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs > 0) {
      resetsAtMs = Date.now() + secs * 1000;
    } else {
      const when = Date.parse(retryAfterHeader);
      if (Number.isFinite(when) && when > Date.now()) resetsAtMs = when;
    }
  }

  try {
    const json = JSON.parse(bodyText);
    if (json && typeof json === "object") {
      const rawType = (typeof json.error === "object" ? json.error?.type : null)
        || (typeof json.type === "string" && json.type !== "error" ? json.type : null);
      if (typeof rawType === "string") errorType = rawType;

      const rawCode = (typeof json.error === "object" ? json.error?.code : null)
        || (typeof json.code === "string" ? json.code : null);
      if (typeof rawCode === "string") errorCode = rawCode;

      message = (typeof json.error === "object" ? json.error?.message : null)
        || (typeof json.message === "string" ? json.message : null)
        || (typeof json.error === "string" ? json.error : null)
        || (errorType || errorCode ? (errorType || errorCode) : null);

      // 429 quota envelope carries the real reset window and the meter that
      // tripped (OpenCode Free: RateLimit.FreeUsageLimitError). Without this the
      // router backs off 2s..5min while upstream may stay blocked until UTC
      // midnight, so every retry in the window is wasted.
      if (typeof json.retryAfter === "number" && Number.isFinite(json.retryAfter) && json.retryAfter > 0) {
        if (resetsAtMs === undefined) resetsAtMs = Date.now() + json.retryAfter * 1000;
      }
      if (json.cap && typeof json.cap === "object") {
        errorCap = {
          reason: typeof json.cap.reason === "string" ? json.cap.reason : null,
          scope: typeof json.cap.scope === "string" ? json.cap.scope : null,
          limit: Number.isFinite(json.cap.limit) ? json.cap.limit : null,
          usage: Number.isFinite(json.cap.usage) ? json.cap.usage : null,
        };
      }
    }
  } catch {
    message = (executorMessage && executorMessage !== bodyText) ? executorMessage : bodyText;
    if (bodyText) {
      if (bodyText.includes("FreeTierError")) errorType = "FreeTierError";
      else if (bodyText.includes("RegionError")) errorType = "RegionError";
      else if (bodyText.includes("DataPolicyError")) errorType = "DataPolicyError";
    }
  }

  if (executorMessage && executorMessage !== bodyText) {
    message = executorMessage;
  }

  if (!message && bodyText && (errorType || errorCode)) {
    message = errorType || errorCode;
  }

  const messageStr = typeof message === "string" ? message : (message ? JSON.stringify(message) : "");
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  const result = { statusCode: executorStatus || response.status, message: finalMessage };
  if (resetsAtMs !== undefined) result.resetsAtMs = resetsAtMs;
  if (errorType) result.errorType = errorType;
  if (errorCode) result.errorCode = errorCode;
  if (errorCap) result.cap = errorCap;
  return result;
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @param {number|object} [clientStatusOrHeaders] - Client status override or headers
 * @param {object} [extraHeaders] - Optional extra headers
 * @param {string} [errorType] - Optional error type override
 * @param {string} [errorCode] - Optional error code override
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number, errorType?: string, errorCode?: string }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, clientStatusOrHeaders = null, extraHeaders = null, errorType = null, errorCode = null) {
  let clientStatus = null;
  let headers = extraHeaders;
  if (clientStatusOrHeaders && typeof clientStatusOrHeaders === "object") {
    headers = clientStatusOrHeaders;
  } else {
    clientStatus = clientStatusOrHeaders;
  }
  const result = {
    success: false,
    // The true upstream status, kept for internal classification (fallback
    // rules, cooldowns) so those keep seeing what the provider actually said.
    status: statusCode,
    error: message,
    resetsAtMs,
    // What the CLIENT sees, which may be normalised — e.g. an unknown model
    // reported as 401 becomes 404, so callers do not read it as an auth failure.
    response: errorResponse(clientStatus ?? statusCode, message, headers, errorType, errorCode)
  };
  if (errorType) result.errorType = errorType;
  if (errorCode) result.errorCode = errorCode;
  return result;
}

/**
 * Map an upstream failure onto the status the client should see.
 *
 * The contract clients actually depend on is coarse: 4xx means stop, 5xx means
 * retry. So the rule is to preserve the upstream's CLASS, never to flatten it.
 *
 * An earlier version of this collapsed every non-429 4xx to 503 to stop a
 * flaky upstream killing a turn. That was the wrong lever: the real cause of
 * those mislabelled statuses was stale per-connection error state being replayed
 * across requests (fixed in auth.js), and the flattening made permanent failures
 * — a rejected temperature, a nonexistent model — look transient. Clients then
 * burned their whole retry budget on hopeless requests, and 5xx bypassed the
 * reactive repair paths that key off a 4xx naming the rejected parameter.
 *
 * Wrong-model errors are the one deliberate re-mapping: providers report them as
 * 400, as 404, and as 401-with-a-ModelError-body. Passing a 401 through makes a
 * client report "authentication failed" for perfectly good credentials, so those
 * are normalised to 404.
 *
 * @param {number|string|null} upstreamStatus - status from the upstream attempt
 * @param {string|object} [errorText] - upstream error text, for model detection
 * @returns {number} status to return to the client
 */
export function clientStatusForUpstream(upstreamStatus, errorText = null) {
  if (isPermanentModelError(errorText)) return HTTP_STATUS.NOT_FOUND;

  const status = Number(upstreamStatus);
  // Nothing usable to propagate (no attempt made, or a non-numeric code): this
  // is our own "no capacity" condition, which is genuinely transient.
  if (!Number.isFinite(status) || status < 400) return HTTP_STATUS.SERVICE_UNAVAILABLE;
  // Anything already carrying a real class keeps it — 4xx stop, 5xx retry.
  if (status <= 599) return status;
  return HTTP_STATUS.SERVICE_UNAVAILABLE;
}

/**
 * Status for the breaker-open path: every account is in cooldown and we already
 * know when the earliest one frees up.
 *
 * A lock is NOT proof the failure was transient. `checkFallbackError` cools an
 * account down for 30s on ANY error it has no rule for, client-fault 400s
 * included, so "all accounts locked" mixes genuinely self-clearing conditions
 * with permanent ones. Remapping the whole path to 503 would resurrect the
 * incident `.claude/rules/error-classification.md` forbids: a 400 "prompt is too
 * long" would come back retryable, the client would wait and resend the same
 * oversized prompt forever instead of compacting it.
 *
 * So exactly one status is remapped, the one that was reported broken:
 *
 *   A 404 whose text does NOT name a model problem. Nothing else produces it —
 *   an unknown model is caught by isPermanentModelError and keeps its 404 — so
 *   what is left is a gateway/routing hop returning a bodyless 404 that the
 *   router itself decided to cool down for two minutes. Reporting that as 404
 *   told clients "this will never work" about a state that cleared itself: the
 *   model was in /v1/models the whole time and served the request once the
 *   window closed, while clients that classify on status burned their retry
 *   budget in six seconds against a two-minute breaker.
 *
 * Everything else keeps the class clientStatusForUpstream gives it, which is the
 * function that rule names as the owner of this decision. In particular 401/402/
 * 403 stay 4xx deliberately: a revoked or unpaid upstream account is not
 * something the caller's retry can fix, so "try again later" would be a lie.
 *
 * @param {number|string|null} upstreamStatus - status of the error that caused the lock
 * @param {string|null} errorText - stored upstream error text
 * @returns {number}
 */
export function clientStatusForBreakerOpen(upstreamStatus, errorText = null) {
  if (Number(upstreamStatus) === HTTP_STATUS.NOT_FOUND && !isPermanentModelError(errorText)) {
    return HTTP_STATUS.SERVICE_UNAVAILABLE;
  }
  return clientStatusForUpstream(upstreamStatus, errorText);
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, extraHeaders = null) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        ...extraHeaders,
        "Content-Type": "application/json",
        // Intentionally mis-cased to prevent duplicate headers
        "retry-after": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
