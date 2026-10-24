// Convert OpenAI-style message lists into a single prompt for the muse web chat.
//
// muse.ai's web UI is a single text box, so multi-turn context and system
// prompts are serialised into one message. Image parts are extracted separately
// so the executor can attach them as files.

const ROLE_LABELS = {
  system: "System",
  developer: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/**
 * Flatten message content to text; image parts (data URLs / http(s) URLs) are
 * collected into `images` in order.
 */
function contentToText(content, images) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      if (part.text) parts.push(part.text);
    } else if (part.type === "image_url" || part.type === "input_image") {
      const ref = part.image_url && typeof part.image_url === "object" ? part.image_url.url : part.image_url;
      if (ref) images.push(ref);
    }
  }
  return parts.filter(Boolean).join("\n");
}

/** Role/text pairs, using the same text extraction as `flattenMessages`. */
export function messageTurns(messages) {
  const turns = [];
  for (const message of messages || []) {
    const text = contentToText(message?.content, []).trim();
    if (text) turns.push([message?.role || "user", text]);
  }
  return turns;
}

/**
 * Flatten the full history into the single prompt typed into the muse.ai box.
 *
 * A lone user turn is sent verbatim; anything richer gets role headers plus an
 * [Instruction] suffix telling the agent to answer as the Assistant.
 *
 * Two ordering rules matter, and both were learned the hard way:
 *
 *  - System/developer turns are HOISTED to the top. The webTools shim appends
 *    its `<tool>` contract as a trailing system message, so rendering in array
 *    order put the contract AFTER the user's ask — the one placement an agentic
 *    model reliably ignores. gemini-web and chatgpt-web already hoist.
 *  - Assistant turns that called a tool and the `role: "tool"` results are
 *    RENDERED, not dropped. They carry no text of their own, so a text-only
 *    filter silently erased the entire tool history and the model re-issued the
 *    same call forever. This is the loop gemini-web documents at length.
 */
export function flattenMessages(messages) {
  const images = [];
  const systemLines = [];
  const lines = [];
  const callNameById = new Map();
  let sawToolActivity = false;

  for (const message of messages || []) {
    const role = message?.role || "user";
    const text = contentToText(message?.content, images).trim();

    if (role === "system" || role === "developer") {
      if (text) systemLines.push(text);
      continue;
    }
    if (role === "user") {
      if (text) lines.push(`[${ROLE_LABELS[role]}]\n${text}`);
      continue;
    }
    if (role === "assistant") {
      const parts = [];
      if (text) parts.push(text);
      for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        const name = typeof call?.function?.name === "string" ? call.function.name : "";
        const rawArgs = call?.function?.arguments;
        const args = typeof rawArgs === "string" && rawArgs ? rawArgs : JSON.stringify(rawArgs ?? {});
        if (call?.id) callNameById.set(call.id, name);
        parts.push(`<tool>{"name": ${JSON.stringify(name)}, "arguments": ${args}}</tool>`);
        sawToolActivity = true;
      }
      if (parts.length) lines.push(`[${ROLE_LABELS.assistant}]\n${parts.join("\n")}`);
      continue;
    }
    if (role === "tool") {
      const name = (message?.tool_call_id && callNameById.get(message.tool_call_id)) || message?.name || "tool";
      lines.push(`[${ROLE_LABELS.tool} (${name})]\n${text || "(no output)"}`);
      sawToolActivity = true;
      continue;
    }
    if (text) lines.push(`[${ROLE_LABELS[role] || role}]\n${text}`);
  }

  if (lines.length === 0 && systemLines.length === 0) return { text: "", images };
  if (lines.length === 1 && !systemLines.length && !sawToolActivity && lines[0].startsWith(`[${ROLE_LABELS.user}]\n`)) {
    return { text: lines[0].slice(ROLE_LABELS.user.length + 3), images };
  }

  if (sawToolActivity) {
    lines.push(
      "[Instruction]\nContinue the task using the tool results above. Do NOT repeat tool calls " +
        "that already succeeded; perform the next step or give the final answer."
    );
  } else {
    lines.push(
      "[Instruction]\nContinue the conversation above and reply as the Assistant to the last " +
        "User message. Output only the reply."
    );
  }

  return { text: [...systemLines, ...lines].join("\n\n"), images };
}
