/**
 * Claude → OpenAI Responses Request Translator (DIRECT route, no OpenAI pivot)
 *
 * Converts Anthropic Messages API requests straight to OpenAI Responses API
 * payloads (`input[]`). Registered on two 3-part family keys —
 * `claude:muse-spark:openai-responses` + `claude:gpt-family:openai-responses` —
 * so only those families hit it; never claude→KIRO or other targets.
 * Mirrors the `input[]` shape of `request/openai-responses.js` (reverse leg).
 * Thinking is left for `applyThinking` post-processing except a minimal
 * `reasoning` summary item (signature/encrypted continuity dropped).
 * Fail-open: bad input returns a near-original body, never throws.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import {
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../formats/responsesApi.js";
import { encodeDataUri } from "../concerns/image.js";
import { ROLE, CLAUDE_BLOCK, RESPONSES_ITEM, OPENAI_BLOCK } from "../schema/index.js";

function extractInstructionsText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((s) => (typeof s === "string" ? s : s?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Mirror convertToolChoice in claude-to-openai.js, Responses-native output:
// Claude {type:"any"} → "required"; {type:"tool",name} → {type:"function",name}.
function convertToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) {
    return { type: OPENAI_BLOCK.FUNCTION, name: choice.name };
  }
  return "auto";
}

function asBlocks(content) {
  if (typeof content === "string") return [{ type: CLAUDE_BLOCK.TEXT, text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

export function claudeToResponsesRequest(model, body, stream, credentials) {
  try {
    const src = body && typeof body === "object" ? body : {};
    const result = { model, input: [], store: false };

    const instructions = extractInstructionsText(src.system);
    result.instructions = instructions;

    for (const msg of Array.isArray(src.messages) ? src.messages : []) {
      if (!msg || typeof msg !== "object") continue;
      const textParts = [];
      const flushText = (role) => {
        if (textParts.length === 0) return;
        result.input.push({
          type: RESPONSES_ITEM.MESSAGE,
          role,
          content: textParts.splice(0).map((text) => ({
            type: role === ROLE.ASSISTANT ? RESPONSES_ITEM.OUTPUT_TEXT : RESPONSES_ITEM.INPUT_TEXT,
            text,
          })),
        });
      };

      for (const block of asBlocks(msg.content)) {
        if (!block || typeof block !== "object") continue;
        if (block.type === CLAUDE_BLOCK.TEXT && block.text) {
          textParts.push(block.text);
        } else if (
          block.type === CLAUDE_BLOCK.THINKING ||
          block.type === CLAUDE_BLOCK.REDACTED_THINKING
        ) {
          const text = block.thinking || block.text || "";
          if (!text) continue;
          flushText(msg.role === ROLE.ASSISTANT ? ROLE.ASSISTANT : ROLE.USER);
          result.input.push({
            type: RESPONSES_ITEM.REASONING,
            summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text }],
          });
        } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
          flushText(ROLE.ASSISTANT);
          result.input.push({
            type: RESPONSES_ITEM.FUNCTION_CALL,
            id: block.id,
            call_id: clampResponsesCallId(block.id),
            name: block.name,
            arguments: coerceResponsesArguments(block.input),
          });
        } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
          flushText(ROLE.USER);
          // One output per block — never merge duplicate ids. is_error → prefix.
          let output = coerceResponsesOutput(block.content);
          if (block.is_error) output = `[error] ${output}`;
          result.input.push({
            type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
            call_id: clampResponsesCallId(block.tool_use_id),
            output,
          });
        } else if (
          block.type === CLAUDE_BLOCK.IMAGE &&
          block.source?.type === "base64" &&
          block.source?.data
        ) {
          flushText(ROLE.USER);
          result.input.push({
            type: RESPONSES_ITEM.INPUT_IMAGE,
            image_url: encodeDataUri(block.source.media_type, block.source.data),
            detail: "auto",
          });
        }
      }
      flushText(msg.role === ROLE.ASSISTANT ? ROLE.ASSISTANT : ROLE.USER);
    }

    if (Array.isArray(src.tools) && src.tools.length > 0) {
      const tools = [];
      for (const tool of src.tools) {
        const name = typeof tool?.name === "string" ? tool.name.trim() : "";
        if (!name) continue;
        tools.push({
          type: OPENAI_BLOCK.FUNCTION,
          name,
          description: String(tool.description || ""),
          parameters: tool.input_schema || { type: "object", properties: {} },
        });
      }
      if (tools.length > 0) result.tools = tools;
    }

    const toolChoice = convertToolChoice(src.tool_choice);
    if (toolChoice !== undefined) result.tool_choice = toolChoice;

    if (src.max_tokens !== undefined) result.max_output_tokens = src.max_tokens;
    if (src.temperature !== undefined) result.temperature = src.temperature;
    if (src.top_p !== undefined) result.top_p = src.top_p;
    if (src.reasoning !== undefined) result.reasoning = src.reasoning;

    return result;
  } catch {
    // Fail-open: never throw out of a translator.
    return { ...((body && typeof body === "object" ? body : {})), model };
  }
}

register("claude", `muse-spark:${FORMATS.OPENAI_RESPONSES}`, claudeToResponsesRequest, null);
register("claude", `gpt-family:${FORMATS.OPENAI_RESPONSES}`, claudeToResponsesRequest, null);
