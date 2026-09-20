export const PROMPT_INJECTIONS = {
  "gemini-tool-strict": `[Tool Calling Constraints]
When using tools, adhere strictly to the declared parameter names and types.
- For file operations (Read, Edit, Write): always use 'file_path', never 'path' or 'filepath'.
- For Edit tool: 'old_string' must match the exact lines from Read byte-for-byte, including exact whitespace and indentation.
- Never wrap tool call arguments in markdown fences.
- Respond with tool calls directly when an action is required.`,
};

export function getPromptInjection(key) {
  if (!key) return null;
  return PROMPT_INJECTIONS[key] || null;
}

export const FAMILY_PROFILES = [
  { pattern: /^muse-spark-/, family: "muse-spark", profile: { endpoint: "/zen/v1/responses", reasoningMap: { max: "xhigh" }, toolConstraints: { maxNameLen: 64 }, promptInject: null, editNormalize: true } },
  { pattern: /^gemini-/, family: "gemini", profile: { endpoint: "/v1/chat/completions", toolConstraints: { maxNameLen: 64 }, promptInject: "gemini-tool-strict", editNormalize: true } },
  { pattern: /^(gpt-|astra|o[34])/, family: "gpt-family", profile: { endpoint: "/zen/v1/responses", toolConstraints: { maxNameLen: 64 }, editNormalize: true } },
];

function baseModelId(m) {
  return String(m || "").replace(/\([^()]+\)\s*$/, "").trim();
}

export function resolveFamily(model) {
  const base = baseModelId(model);
  for (const e of FAMILY_PROFILES) if (e.pattern.test(base)) return { family: e.family, ...e.profile, pattern: e.pattern };
  return null;
}
