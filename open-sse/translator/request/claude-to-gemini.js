/**
 * Claude → Gemini Request Translator (DIRECT route, no OpenAI pivot)
 *
 * Converts Anthropic Messages API requests straight to Gemini
 * `generateContent` payloads. Registered on the 3-part family key
 * `claude:gemini:gemini` so only gemini-family models hit it —
 * never claude→KIRO or other targets.
 * Thinking is left for `applyThinking` post-processing (no self map).
 * Fail-open: bad input returns a near-original body, never throws.
 */
import { register } from "../index.js";
import {
  DEFAULT_SAFETY_SETTINGS,
  cleanJSONSchemaForAntigravity,
  normalizeGeminiContents,
} from "../formats/gemini.js";
import { ROLE, CLAUDE_BLOCK, GEMINI_ROLE, DEFAULT_IMAGE_MIME } from "../schema/index.js";
import { resolveFamily, getPromptInjection } from "../../providers/familyProfiles.js";

// Local copy (same as open-sse/translator/request/openai-to-gemini.js):
// Gemini requires ^[a-zA-Z_][a-zA-Z0-9_.:\-]{0,63}$.
function sanitizeGeminiFunctionName(name) {
  if (!name) return "_unknown";
  let sanitized = String(name).replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(sanitized)) sanitized = `_${sanitized}`;
  return sanitized.substring(0, 64);
}

function extractSystemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((s) => (typeof s === "string" ? s : s?.text || "")).filter(Boolean).join("\n");
  }
  return "";
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === CLAUDE_BLOCK.TEXT ? c.text : JSON.stringify(c))).join("\n");
  }
  if (content) return JSON.stringify(content);
  return "";
}

function convertToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") return { functionCallingConfig: { mode: "AUTO" } };
  if (choice.type === "tool" && choice.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [sanitizeGeminiFunctionName(choice.name)],
      },
    };
  }
  return { functionCallingConfig: { mode: "AUTO" } };
}

export function claudeToGeminiRequest(model, body, stream, credentials) {
  try {
    const src = body && typeof body === "object" ? body : {};
    const result = {
      model,
      contents: [],
      generationConfig: {},
      safetySettings: DEFAULT_SAFETY_SETTINGS,
    };

    const family = resolveFamily(model);
    const injection = getPromptInjection(family?.promptInject);
    let systemText = extractSystemText(src.system);
    if (injection) {
      systemText = systemText ? `${systemText}\n\n${injection}` : injection;
    }
    if (systemText) {
      result.systemInstruction = { role: GEMINI_ROLE.USER, parts: [{ text: systemText }] };
    }

    if (src.max_tokens !== undefined) result.generationConfig.maxOutputTokens = src.max_tokens;
    if (src.temperature !== undefined) result.generationConfig.temperature = src.temperature;
    if (src.top_p !== undefined) result.generationConfig.topP = src.top_p;

    // tool_use id → name so each functionResponse keeps the declared name.
    const toolUseIdToName = {};
    for (const msg of Array.isArray(src.messages) ? src.messages : []) {
      if (!Array.isArray(msg?.content)) continue;
      for (const block of msg.content) {
        if (block?.type === CLAUDE_BLOCK.TOOL_USE && block.id && block.name) {
          toolUseIdToName[block.id] = block.name;
        }
      }
    }

    for (const msg of Array.isArray(src.messages) ? src.messages : []) {
      const parts = [];
      const blocks = Array.isArray(msg?.content)
        ? msg.content
        : typeof msg?.content === "string"
          ? [{ type: CLAUDE_BLOCK.TEXT, text: msg.content }]
          : [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === CLAUDE_BLOCK.TEXT && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
          const text = block.thinking || block.text || "";
          if (text) parts.push({ thought: true, text });
          if (block.signature) parts.push({ thoughtSignature: block.signature, text: "" });
        } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
          parts.push({
            functionCall: {
              id: block.id,
              name: sanitizeGeminiFunctionName(block.name),
              args: block.input || {},
            },
          });
        } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
          // One functionResponse per block — never merge duplicate ids.
          const name = toolUseIdToName[block.tool_use_id]
            ? sanitizeGeminiFunctionName(toolUseIdToName[block.tool_use_id])
            : "tool";
          const response = { result: toolResultText(block.content) };
          if (block.is_error) response.isError = true;
          parts.push({
            functionResponse: { id: block.tool_use_id, name, response },
          });
        } else if (block.type === CLAUDE_BLOCK.IMAGE && block.source?.type === "base64" && block.source?.data) {
          parts.push({
            inlineData: {
              mime_type: block.source.media_type || DEFAULT_IMAGE_MIME,
              data: block.source.data,
            },
          });
        }
      }
      if (parts.length > 0) {
        result.contents.push({
          role: msg.role === ROLE.ASSISTANT ? GEMINI_ROLE.MODEL : GEMINI_ROLE.USER,
          parts,
        });
      }
    }

    if (Array.isArray(src.tools) && src.tools.length > 0) {
      const functionDeclarations = [];
      for (const tool of src.tools) {
        if (tool?.name && tool?.input_schema) {
          functionDeclarations.push({
            name: sanitizeGeminiFunctionName(tool.name),
            description: tool.description || "",
            parameters: cleanJSONSchemaForAntigravity(
              structuredClone(tool.input_schema || { type: "object", properties: {} }),
            ),
          });
        }
      }
      if (functionDeclarations.length > 0) result.tools = [{ functionDeclarations }];
    }

    const toolConfig = convertToolChoice(src.tool_choice);
    if (toolConfig) result.toolConfig = toolConfig;

    result.contents = normalizeGeminiContents(result.contents);
    return result;
  } catch {
    // Fail-open: never throw out of a translator.
    return { model, contents: [], generationConfig: {}, safetySettings: DEFAULT_SAFETY_SETTINGS };
  }
}

register("claude", "gemini:gemini", claudeToGeminiRequest, null);
