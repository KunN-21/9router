import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { PROVIDER_MEDIA } from "../providers/index.js";
import { generateSessionId } from "../executors/opencode-zen.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

/**
 * Core System One (Jev) handler — native decision payload pass-through.
 * URL/headers come from the registry's systemoneConfig; body and JSON response
 * are forwarded untouched (decision models have no chat translation layer).
 *
 * @returns {Promise<{ success: boolean, response: Response, usage?: object, status?: number, error?: string }>} 
 */
export async function handleSystemoneCore({
  body,
  modelInfo,
  credentials,
  signal,
  log,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;
  const cfg = PROVIDER_MEDIA[provider]?.systemoneConfig;
  if (!cfg?.baseUrl) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      "Provider '" + provider + "' does not support System One."
    );
  }

  // Validate input at the trust boundary; question-level shape is upstream's job.
  if (body.state === undefined || body.state === null) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: state");
  }
  if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: questions");
  }

  // noAuth free lanes carry accessToken "public" from the credential stub.
  const token = credentials?.apiKey || credentials?.accessToken;
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: "Bearer " + token } : {}),
    ...(cfg.headers || {}),
    // Zen lanes expect the official client session header on every request.
    "x-opencode-session": generateSessionId(),
  };
  const requestBody = { ...body, model };

  log?.debug?.("SYSTEMONE", provider.toUpperCase() + " | " + model);

  const proxyOptions = credentials?.providerSpecificData
    ? {
        connectionProxyEnabled: credentials.providerSpecificData.connectionProxyEnabled,
        connectionProxyUrl: credentials.providerSpecificData.connectionProxyUrl,
        connectionNoProxy: credentials.providerSpecificData.connectionNoProxy,
        strictProxy: credentials.providerSpecificData.strictProxy,
        vercelRelayUrl: credentials.providerSpecificData.vercelRelayUrl,
      }
    : null;

  const timeoutSignal = typeof AbortSignal?.timeout === "function"
    ? AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS)
    : null;
  const combinedSignal = signal && timeoutSignal
    ? (typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : signal)
    : (signal || timeoutSignal || undefined);

  let providerResponse;
  try {
    providerResponse = await proxyAwareFetch(cfg.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      ...(combinedSignal ? { signal: combinedSignal } : {}),
    }, proxyOptions);
  } catch (error) {
    if (signal?.aborted) {
      log?.debug?.("SYSTEMONE", "Client aborted request");
      return createErrorResult(499, "Request aborted");
    }
    if (timeoutSignal?.aborted || error.name === "TimeoutError") {
      const errMsg = formatProviderError(new Error("Upstream connection timeout"), provider, model, HTTP_STATUS.GATEWAY_TIMEOUT);
      log?.debug?.("SYSTEMONE", "Fetch timeout: " + errMsg);
      return createErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, errMsg);
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("SYSTEMONE", "Fetch error: " + errMsg);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("SYSTEMONE", "Provider error: " + errMsg);
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid JSON response from " + provider);
  }

  if (onRequestSuccess) await onRequestSuccess();

  const usage = responseBody?.usage;
  return {
    success: true,
    usage: usage
      ? { prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0, completion_tokens: usage.output_tokens || usage.completion_tokens || 0 }
      : null,
    response: new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
