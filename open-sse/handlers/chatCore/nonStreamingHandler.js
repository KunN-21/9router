import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { addBufferToUsage, filterUsageForFormat } from "../../utils/usageTracking.js";
import { createErrorResult } from "../../utils/error.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { unwrapClineEnvelope } from "../../shared/clineEnvelope.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { restoreToolNames } from "../../utils/opencodeFingerprint.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";
import { storeGeminiThoughtSignature } from "../../services/thoughtSignatureStore.js";
import {
  parseToolArguments,
  extractCustomToolInput,
  openAICompletionToClaudeMessage,
  openAICompletionToResponses,
  responsesOutputToChatParts,
  responsesStatusToFinish,
  responsesToOpenAICompletion,
  responsesToClaudeMessage,
} from "./nonStreamingFormatters.js";


/**
 * Translate non-streaming response body from provider format → OpenAI format.
 */
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames = null) {
  if (targetFormat === sourceFormat) return responseBody;
  // Upstream spoke Responses API ({object:"response"} — targetFormat) but the
  // client wants Chat Completions or Claude JSON — flatten the `output` items so
  // no raw object:"response" body ever leaks to non-Responses clients.
  if (targetFormat === FORMATS.OPENAI_RESPONSES && responseBody?.object === "response") {
    if (sourceFormat === FORMATS.CLAUDE) return responsesToClaudeMessage(responseBody);
    return responsesToOpenAICompletion(responseBody);
  }
  // Provider responded in OpenAI Chat Completions shape but the client speaks
  // Responses API — convert so tool_calls/text surface as Responses `output`.
  if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return openAICompletionToResponses(responseBody, customToolNames);
  }
  if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.CLAUDE) {
    return openAICompletionToClaudeMessage(responseBody);
  }
  if (targetFormat === FORMATS.OPENAI) return responseBody;

  // Gemini / Antigravity
  if (targetFormat === FORMATS.GEMINI || targetFormat === FORMATS.ANTIGRAVITY || targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.VERTEX) {
    const response = responseBody.response || responseBody;
    if (!response?.candidates?.[0]) return responseBody;

    const candidate = response.candidates[0];
    const content = candidate.content;
    const usage = response.usageMetadata || responseBody.usageMetadata;
    let textContent = "", reasoningContent = "";
    const toolCalls = [];
    let pendingThoughtSignature = null;

    if (content?.parts) {
      for (const part of content.parts) {
        const hasThoughtSig = part.thoughtSignature || part.thought_signature;
        if (hasThoughtSig && typeof hasThoughtSig === "string") {
          pendingThoughtSignature = hasThoughtSig;
        }
        if (part.thought === true && part.text) reasoningContent += part.text;
        else if (part.text !== undefined) textContent += part.text;
        if (part.functionCall) {
          const callId = part.functionCall.id || `call_${part.functionCall.name || "tool"}_${Date.now()}_${toolCalls.length}`;
          const sigToStore = part.thoughtSignature || part.thought_signature || pendingThoughtSignature;
          if (sigToStore) {
            storeGeminiThoughtSignature(callId, sigToStore, response.sessionId || responseBody.sessionId || null, response.modelVersion || responseBody.model || "gemini");
            pendingThoughtSignature = null;
          }
          toolCalls.push({
            id: callId,
            type: "function",
            function: { name: part.functionCall.name || "", arguments: JSON.stringify(part.functionCall.args || {}) }
          });
        }
        // Handle inline image data (from image generation models)
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData?.data) {
          const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
          textContent += `\n![image](data:${mimeType};base64,${inlineData.data})\n`;
        }
      }
    }

    if (sourceFormat === FORMATS.CLAUDE) {
      const claudeContent = [];
      if (reasoningContent) {
        claudeContent.push({ type: "thinking", thinking: reasoningContent });
      }
      if (textContent) {
        claudeContent.push({ type: "text", text: textContent });
      }
      for (const tc of toolCalls) {
        claudeContent.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: parseToolArguments(tc.function.arguments),
        });
      }
      if (claudeContent.length === 0) claudeContent.push({ type: "text", text: "" });

      const stopReason = toolCalls.length > 0 ? "tool_use" : (candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn");

      return {
        id: String(response.responseId || `msg_${Date.now()}`),
        type: "message",
        role: "assistant",
        model: response.modelVersion || "gemini",
        content: claudeContent,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: (usage?.promptTokenCount || 0) + (usage?.thoughtsTokenCount || 0),
          output_tokens: usage?.candidatesTokenCount || 0,
        },
      };
    }

    if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
      const output = [];
      if (reasoningContent) {
        output.push({
          type: RESPONSES_ITEM.REASONING,
          summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoningContent }],
        });
      }
      if (textContent) {
        output.push({
          type: RESPONSES_ITEM.MESSAGE,
          role: ROLE.ASSISTANT,
          content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text: textContent, annotations: [] }],
        });
      }
      for (const tc of toolCalls) {
        const custom = customToolNames?.has(tc.function.name);
        output.push({
          type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
          id: `${custom ? "ctc" : "fc"}_${tc.id}`,
          call_id: tc.id,
          name: tc.function.name,
          ...(custom
            ? { input: extractCustomToolInput(tc.function.arguments) }
            : { arguments: tc.function.arguments }),
        });
      }
      return {
        id: `resp_${response.responseId || Date.now()}`,
        object: "response",
        created_at: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
        model: response.modelVersion || "gemini",
        status: "completed",
        background: false,
        error: null,
        output,
        usage: {
          input_tokens: (usage?.promptTokenCount || 0) + (usage?.thoughtsTokenCount || 0),
          output_tokens: usage?.candidatesTokenCount || 0,
          total_tokens: usage?.totalTokenCount || 0,
        },
      };
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = (candidate.finishReason || "stop").toLowerCase();
    if (finishReason === "stop" && toolCalls.length > 0) finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${response.responseId || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
      model: response.modelVersion || "gemini",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (usage) {
      result.usage = {
        prompt_tokens: (usage.promptTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      };
      if (usage.thoughtsTokenCount > 0) {
        result.usage.completion_tokens_details = { reasoning_tokens: usage.thoughtsTokenCount };
      }
    }
    return result;
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    // Always translate a Claude-format body to OpenAI, even if `content` is
    // missing/null (e.g. M3 with max_tokens:1 spends the budget on thinking
    // and returns `content: null`). Returning the raw body would leave the
    // OpenAI client without a `choices` array and surface as a UI test error.
    // Early return if the response is already in OpenAI format (has choices array)
    // or if it has content as a non-array value (likely a different non-Claude format).
    // Some providers (e.g. xiaomi-tokenplan) return OpenAI-format responses even when
    // the request was translated to Claude format — the targetFormat is Claude but the
    // actual response is OpenAI-native and needs no further translation.
    if (responseBody.choices || (responseBody.content && !Array.isArray(responseBody.content))) return responseBody;

    let textContent = "", thinkingContent = "";
    const toolCalls = [];

    for (const block of (responseBody.content || [])) {
      if (block.type === "text") {
        // Strip markdown code block markers (e.g. kimi wraps JSON in ```json...```)
        const raw = block.text ?? "";
        const text = raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
        textContent += text;
      } else if (block.type === "thinking") thinkingContent += block.thinking || "";
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = responseBody.stop_reason || "stop";
    if (finishReason === "end_turn") finishReason = "stop";
    if (finishReason === "tool_use") finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (responseBody.usage) {
      result.usage = {
        prompt_tokens: responseBody.usage.input_tokens || 0,
        completion_tokens: responseBody.usage.output_tokens || 0,
        total_tokens: (responseBody.usage.input_tokens || 0) + (responseBody.usage.output_tokens || 0)
      };
    }
    return result;
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    return ollamaBodyToOpenAI(responseBody);
  }

  return responseBody;
}

// Describe why a non-streaming JSON body is empty/misshapen, or null when valid.
// Narrow by design: only a keyless body or an explicitly empty `choices` array
// is rejected. Other unknown shapes (e.g. a non-opt-in {success,data} envelope)
// keep the existing pass-through so pinned behavior never changes. Other targets
// (Claude/Gemini/Ollama) synthesize empty-content bodies by design and are unchecked.
function describeEmptyNonStreamingBody(responseBody, targetFormat) {
  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    return "JSON";
  }
  if (Object.keys(responseBody).length === 0) {
    return targetFormat === FORMATS.OPENAI_RESPONSES ? "Responses API" : "Chat Completions";
  }
  if (targetFormat === FORMATS.OPENAI && "choices" in responseBody) {
    const choices = responseBody.choices;
    if (!Array.isArray(choices) || choices.length === 0 || !choices[0] || typeof choices[0] !== "object") {
      return "Chat Completions";
    }
  }
  if (targetFormat === FORMATS.OPENAI_RESPONSES && responseBody.object === "response" && !Array.isArray(responseBody.output)) {
    return "Responses API";
  }
  return null;
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, trackDone, appendLog, pxpipe, reqTag, log }) {
  trackDone();
  const contentType = providerResponse.headers.get("content-type") || "";
  let responseBody;

  if (contentType.includes("text/event-stream")) {
    // A Responses-API upstream may ignore stream:false and answer with SSE.
    // Its chunks are Responses events (not Chat deltas), so parse them with the
    // Responses stream→JSON converter instead of the Chat Completions one; the
    // resulting object:"response" body then flows through the same translation
    // below. Mirrors sseToJsonHandler's targetFormat-based branch.
    if (targetFormat === FORMATS.OPENAI_RESPONSES) {
      try {
        responseBody = await convertResponsesStreamToJson(providerResponse.body);
      } catch (err) {
        console.error("[ChatCore] Responses API SSE→JSON failed:", err);
        appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON");
      }
    } else {
      const sseText = await providerResponse.text();
      const parsed = parseSSEToOpenAIResponse(sseText, model);
      if (!parsed) {
        appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
      }
      responseBody = parsed;
    }
  } else {
    try {
      responseBody = await providerResponse.json();
    } catch (err) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
    }
  }

  // Reject failed Responses streams before logging or firing success hooks
  if (responseBody?.status === "failed") {
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
    const msg = responseBody?.error?.message
      ? `Upstream Responses error from ${provider}/${model}: ${responseBody.error.message}`
      : `Upstream Responses stream ended without a completed response from ${provider}/${model} (status: failed)`;
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, msg);
  }

  // Reject error payloads (even if upstream returned HTTP 200)
  if (responseBody?.error || responseBody?.type === "error") {
    const status = providerResponse.status >= 400 ? providerResponse.status : HTTP_STATUS.BAD_GATEWAY;
    appendLog({ status: `FAILED ${status}` });
    const msg = responseBody?.error?.message || (typeof responseBody?.error === "string" ? responseBody.error : "Upstream returned error payload");
    console.error(`[ChatCore] Error payload from ${provider}/${model}: ${msg}`);
    return createErrorResult(status, msg);
  }

  // Unwrap before any consumer reads choices/usage so non-stream clients get a
  // bare OpenAI body and usage tracking sees data.usage. No-op unless the
  // provider opts in via transport.quirks.clineEnvelope.
  responseBody = unwrapClineEnvelope(responseBody, provider);

  // Reject an empty/misshapen JSON body before it becomes HTTP200: an empty
  // chat.completion (or Responses body) has no content for clients to read.
  const emptyShape = describeEmptyNonStreamingBody(responseBody, targetFormat);
  if (emptyShape) {
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
    console.error(`[ChatCore] Empty ${emptyShape} JSON from ${provider}/${model} (upstream status ${providerResponse.status})`);
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      `Empty ${emptyShape} JSON response from ${provider}/${model} (upstream status ${providerResponse.status})`
    );
  }

  // Pre-translate to validate final Claude message and avoid double translation
  const translatedResponse = needsTranslation(targetFormat, sourceFormat)
    ? translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames)
    : responseBody;

  // Scope guard for Claude clients: both same-format and translated paths must
  // produce a valid Claude message. Reject non-message shapes before logging/success hooks.
  // Note: empty content (content: [] or content: [{type:"text",text:""}]) is valid;
  // only missing type:"message" or non-array content indicates malformed shape.
  if (sourceFormat === FORMATS.CLAUDE) {
    const valid = translatedResponse?.type === "message"
      && Array.isArray(translatedResponse.content);
    if (!valid) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      const errMsg = responseBody?.error?.message
        || `Malformed ${targetFormat} response for Claude client from ${provider}/${model} (upstream status ${providerResponse.status})`;
      console.error(`[ChatCore] ${errMsg}`);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
    }
  }

  reqLogger.logProviderResponse(providerResponse.status, providerResponse.statusText, providerResponse.headers, responseBody);
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
  responseBody = decloakToolNames(responseBody, toolNameMap);

  const usage = extractUsageFromResponse(responseBody);
  appendLog({ tokens: usage, status: "200 OK" });
  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, silent: true });
  if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));
  const isClaudeMessageResponse = sourceFormat === FORMATS.CLAUDE && translatedResponse?.type === "message";
  // Responses-format translation produces a `object:"response"` body with no
  // `choices`; skip the Chat-Completions-specific post-processing below for it.
  const isResponsesResponse = sourceFormat === FORMATS.OPENAI_RESPONSES && translatedResponse?.object === "response";

  // Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other").
  // Truncation wins over tool presence: a truncated tool call is not executable,
  // so length/max_tokens (or raw Responses incomplete status) must survive.
  if (translatedResponse?.choices?.[0]) {
    const choice = translatedResponse.choices[0];
    const msg = choice.message;
    const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    const truncated = choice.finish_reason === "length" || choice.finish_reason === "max_tokens"
      || responseBody?.status === "incomplete";
    if (hasToolCalls && choice.finish_reason !== "tool_calls" && !truncated) {
      choice.finish_reason = "tool_calls";
    }
  }

  // Ensure OpenAI-required fields
  if (!isClaudeMessageResponse && !isResponsesResponse) {
    if (!translatedResponse.object) translatedResponse.object = "chat.completion";
    if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);
  }

  // Strip Azure-specific fields
  if (!isClaudeMessageResponse && !isResponsesResponse) {
    delete translatedResponse.prompt_filter_results;
    if (translatedResponse?.choices) {
      for (const choice of translatedResponse.choices) delete choice.content_filter_results;
    }
  }

  if (translatedResponse?.usage) {
    translatedResponse.usage = filterUsageForFormat(addBufferToUsage(translatedResponse.usage), sourceFormat);
  }

  // Strip reasoning_content only when content is non-empty.
  // When content is empty (e.g. thinking models that used all tokens for reasoning),
  // reasoning_content is the only useful output and must be preserved.
  if (!isClaudeMessageResponse && !isResponsesResponse && translatedResponse?.choices) {
    for (const choice of translatedResponse.choices) {
      if (choice?.message?.reasoning_content && choice.message.content) {
        delete choice.message.reasoning_content;
      }
    }
  }

  reqLogger.logConvertedResponse(translatedResponse);

  const totalLatency = Date.now() - requestStartTime;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: totalLatency, total: totalLatency },
    tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: responseBody || null,
    response: {
      content: translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
      thinking: translatedResponse?.choices?.[0]?.message?.reasoning_content || translatedResponse?.reasoning_content || null,
      finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown"
    },
    pxpipe,
    status: "success"
  }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });

  return {
    success: true,
    response: new Response(JSON.stringify(restoreToolNames(translatedResponse, toolNameMap)), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...upstreamResponseHeaders(providerResponse.headers) }
    })
  };
}
