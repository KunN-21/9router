import { detectFormat } from "../services/provider.js";
import { createNonStreamingResponse, createStreamingResponse } from "./bypassResponse.js";

const GAIN_DASHBOARD_REPLY = "Usage totals are available in the dashboard Token Saver tab.";
const DEFAULT_PONYTAIL_HELP =
  "Ponytail — lazy-senior persona for minimal code.\n" +
  "\n" +
  "3 intensity levels:\n" +
  "  lite   — name the lazier alternative in one line; user picks\n" +
  "  full   — ladder enforced; stdlib and native first\n" +
  "  ultra  — YAGNI extremist; ship the one-liner, challenge the rest\n" +
  "\n" +
  "7-rung ladder (stop at the first rung that holds):\n" +
  "  1. Does this need to exist at all? (YAGNI)\n" +
  "  2. Does the codebase already solve it? Reuse patterns.\n" +
  "  3. Stdlib does it? Use it.\n" +
  "  4. Native platform feature covers it? Use it (CSS over JS, DB over app).\n" +
  "  5. Already-installed dependency solves it? Use it.\n" +
  "  6. Can it be one line? One line.\n" +
  "  7. Only then: the minimum code that works.\n" +
  "\n" +
  "Rules: no unrequested abstractions. No boilerplate \"for later\". " +
  "Deletion over addition. Boring over clever. Shortest working diff wins.\n" +
  "\n" +
  "Output: code first. Then at most three short lines: what was skipped, " +
  "when to add it. Pattern: `[code] -> skipped: [X], add when [Y].`\n" +
  "\n" +
  "How to enable: toggle Ponytail in Token Saver settings.\n" +
  "\n" +
  "Commands:\n" +
  "  /ponytail-gain  — " + GAIN_DASHBOARD_REPLY + "\n" +
  "  /ponytail-help  — show this help text";

/**
 * Intercept Ponytail slash commands and return synthetic bypass response.
 * Returns null if no command matched — let request pass through.
 * Matches only when the newest message is a user command. Global usage is not
 * loaded because chat calls may run under any credential; usage summaries stay
 * in the dashboard Token Saver view.
 */
export function handlePonytailCommands(body, model, { helpText, sourceFormatOverride, streamOverride } = {}) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return null;

  const current = body.messages[body.messages.length - 1] || {};
  if (current.role !== "user") return null;

  const content = current.content;
  const lastText = (typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter(c => c.type === "text").map(c => c.text).join(" ")
      : "").trim();
  if (!lastText) return null;

  const lowerText = lastText.toLowerCase();
  let text = null;
  if (lowerText === "/ponytail-help" || lowerText === "/ponytail help") {
    text = helpText || DEFAULT_PONYTAIL_HELP;
  } else if (lowerText === "/ponytail-gain" || lowerText === "/ponytail gain") {
    text = GAIN_DASHBOARD_REPLY;
  }
  if (text === null) return null;

  const sourceFormat = sourceFormatOverride || detectFormat(body);
  const stream = streamOverride ?? body.stream === true;

  return stream
    ? createStreamingResponse(sourceFormat, model, text)
    : createNonStreamingResponse(sourceFormat, model, text);
}

export { DEFAULT_PONYTAIL_HELP };
