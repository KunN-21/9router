// Port of Rust core/guard.rs never_worse + tracking estimate_tokens.
// Stricter than Rust: also never-empty and never-grow (byte length), so
// filters can use this as the single post-condition.
// ponytail: estimate is chars/4; upgrade to a tokenizer count if filters
// ever need byte-growth-with-token-shrink (Rust tie-keeps-filtered).
export function estimateTokens(s) {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

export function neverWorse(raw, filtered) {
  if (typeof filtered !== "string" || filtered.length === 0) return raw;
  if (typeof raw !== "string") return raw;
  if (filtered.length > raw.length) return raw;
  if (estimateTokens(filtered) > estimateTokens(raw)) return raw;
  return filtered;
}
