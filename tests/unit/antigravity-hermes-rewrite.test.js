import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_PROMPT_REWRITES } from "../../open-sse/config/appConstants.js";

function rewritePrompt(prompt) {
  let text = prompt;
  for (const { from, to } of ANTIGRAVITY_PROMPT_REWRITES) {
    text = text.replaceAll(from, to);
  }
  return text;
}

describe("ANTIGRAVITY_PROMPT_REWRITES Hermes variants", () => {
  const cases = [
    "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
    "You are Hermes Agent, an intelligent AI assistant.",
    "You are Hermes, an AI assistant built by Nous Research.",
    "You are Hermes, an AI agent.",
    "You are Hermes.",
    "You are Hermes Agent.",
  ];

  it.each(cases)("rewrites '%s' to standard assistant", (input) => {
    expect(rewritePrompt(input)).toBe("You are an AI assistant.");
  });
});
