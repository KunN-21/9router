import { FORMATS } from "../../translator/formats.js";
import { ROLE, RESPONSES_ITEM, OPENAI_FINISH, CLAUDE_STOP } from "../../translator/schema/index.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { responsesToClaudeUsage } from "../../translator/concerns/usage.js";

export function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

export function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = responseBody.usage || {};
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };
}

export function openAICompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const usage = responseBody.usage || {};
  let status = "completed";
  let incomplete_details;
  if (choice.finish_reason === OPENAI_FINISH.LENGTH) {
    status = "incomplete";
    incomplete_details = { reason: "max_output_tokens" };
  } else if (choice.finish_reason && choice.finish_reason !== "tool_calls" && choice.finish_reason !== "stop") {
    status = choice.finish_reason;
  }

  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status,
    ...(incomplete_details ? { incomplete_details } : {}),
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

export function responsesOutputToChatParts(output) {
  let textContent = "", reasoningContent = "";
  const toolCalls = [];
  for (const item of output || []) {
    if (item?.type === RESPONSES_ITEM.REASONING) {
      for (const s of item.summary || []) {
        if (typeof s?.text === "string") reasoningContent += s.text;
      }
    } else if (item?.type === RESPONSES_ITEM.MESSAGE) {
      for (const c of item.content || []) {
        if (typeof c?.text === "string") textContent += c.text;
      }
    } else if (item?.type === RESPONSES_ITEM.FUNCTION_CALL || item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
      const args = item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL
        ? JSON.stringify({ input: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? "") })
        : typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {});
      toolCalls.push({
        id: item.call_id || item.id || `call_${item.name}_${toolCalls.length}`,
        type: "function",
        function: { name: item.name || "", arguments: args },
      });
    }
  }
  return { textContent, reasoningContent, toolCalls };
}

export function responsesStatusToFinish(status, details) {
  // Align streaming T7 (responses-to-claude.js:211): max_tokens variant + missing reason count as truncation.
  const reason = details?.reason;
  if (status === "incomplete" && (reason === "max_output_tokens" || reason === "max_tokens" || !reason)) {
    return { finishReason: OPENAI_FINISH.LENGTH, stopReason: CLAUDE_STOP.MAX_TOKENS };
  }
  return { finishReason: OPENAI_FINISH.STOP, stopReason: CLAUDE_STOP.END_TURN };
}

export function responsesToOpenAICompletion(responseBody) {
  if (!Array.isArray(responseBody?.output)) return responseBody;
  const { textContent, reasoningContent, toolCalls } = responsesOutputToChatParts(responseBody.output);

  const message = { role: ROLE.ASSISTANT };
  message.content = textContent || (toolCalls.length > 0 ? null : "");
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = responseBody.usage || {};
  const mapped = responsesStatusToFinish(responseBody.status, responseBody.incomplete_details);
  // Truncation wins over tool presence — mirrors streaming translator (T7).
  const finishReason = mapped.finishReason === OPENAI_FINISH.LENGTH
    ? OPENAI_FINISH.LENGTH
    : toolCalls.length > 0 ? OPENAI_FINISH.TOOL_CALLS : mapped.finishReason;

  return {
    id: responseBody.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: responseBody.created_at || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

export function responsesToClaudeMessage(responseBody) {
  if (!Array.isArray(responseBody?.output)) return responseBody;
  const { textContent, reasoningContent, toolCalls } = responsesOutputToChatParts(responseBody.output);

  const content = [];
  if (reasoningContent) content.push({ type: "thinking", thinking: reasoningContent });
  if (textContent) content.push({ type: "text", text: textContent });
  for (const tc of toolCalls) {
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseToolArguments(tc.function.arguments) });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = responsesToClaudeUsage(responseBody.usage || {});
  const mapped = responsesStatusToFinish(responseBody.status, responseBody.incomplete_details);
  // Truncation wins over tool presence — mirrors streaming translator (T7).
  const stopReason = mapped.stopReason === CLAUDE_STOP.MAX_TOKENS
    ? CLAUDE_STOP.MAX_TOKENS
    : toolCalls.length > 0 ? CLAUDE_STOP.TOOL_USE : mapped.stopReason;

  return {
    id: responseBody.id || `msg_${Date.now()}`,
    type: "message",
    role: ROLE.ASSISTANT,
    model: responseBody.model || "unknown",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}
