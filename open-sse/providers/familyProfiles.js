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
