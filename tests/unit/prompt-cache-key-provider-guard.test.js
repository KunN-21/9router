import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { stripUnsupportedChatExtensions } from "../../open-sse/translator/concerns/paramSupport.js";

const KEY = "stable-cache-key";

const chatBody = () => ({
  model: "example-model",
  messages: [{ role: "user", content: "hello" }],
  prompt_cache_key: KEY,
});

const responsesBody = () => ({
  model: "example-model",
  input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  prompt_cache_key: KEY,
});

describe("prompt_cache_key provider-boundary guard (Responses → Chat hop only)", () => {
  it.each(["openai", "azure", "github", "codex", "grok-cli"])(
    "responses → chat keeps the key for quirked provider %s",
    (provider) => {
      const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gpt-4o", responsesBody(), true, {}, provider);

      expect(out.prompt_cache_key).toBe(KEY);
      expect(out.messages?.[0]?.role).toBe("user");
    },
  );

  it.each(["groq", "cerebras", "no-such-provider"])(
    "responses → chat strips the key for strict/unknown provider %s",
    (provider) => {
      const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "llama-3.3-70b", responsesBody(), true, {}, provider);

      expect(out.prompt_cache_key).toBeUndefined();
      expect(out.messages?.[0]?.role).toBe("user");
    },
  );

  it("chat → chat retains the key for a non-quirk provider (opencode session affinity)", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "any", chatBody(), true, {}, "opencode");

    expect(out.prompt_cache_key).toBe(KEY);
  });

  it("chat → chat retains the key for openai-compatible-* nodes", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "any", chatBody(), true, {}, "openai-compatible-chat-abc");

    expect(out.prompt_cache_key).toBe(KEY);
  });

  it("leaves Responses-target bodies untouched regardless of provider", () => {
    const passthrough = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "any", responsesBody(), true, {}, "openai-compatible-custom");
    expect(passthrough.prompt_cache_key).toBe(KEY);

    const chatToResponses = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "any", chatBody(), true, {}, "groq");
    expect(chatToResponses.prompt_cache_key).toBe(KEY);
  });

  it("stripUnsupportedChatExtensions leaves null/non-object bodies untouched, never throws", () => {
    expect(stripUnsupportedChatExtensions("no-such-provider", null)).toBeNull();
    expect(stripUnsupportedChatExtensions(undefined, undefined)).toBeUndefined();
    expect(stripUnsupportedChatExtensions("groq", "text")).toBe("text");
    // Unknown provider: not fail-open — key stripped (fail-closed); legacy input only untouched when no key present
    const strictOut = stripUnsupportedChatExtensions("no-such-provider", { prompt_cache_key: KEY });
    expect(strictOut.prompt_cache_key).toBeUndefined();
    const legacyOut = stripUnsupportedChatExtensions(undefined, { messages: [] });
    expect(legacyOut).toEqual({ messages: [] });
    expect(() => stripUnsupportedChatExtensions("no-such-provider", { prompt_cache_key: KEY })).not.toThrow();
  });
});
