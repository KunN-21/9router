import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { canonicalizeUsage, extractUsage } = await import("../../open-sse/utils/usageTracking.js");
const { extractUsageFromResponse } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
const usageDb = await import("@/lib/usageDb.js");

const LITERAL_USAGE = {
  input_tokens: 5000,
  input_tokens_details: { cached_tokens: 4096 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 8 },
  total_tokens: 5020
};

function createCodexStream({
  eventType = "response.completed",
  status = "completed",
  usage = LITERAL_USAGE,
  incompleteDetails = null,
  extraResponseFields = {}
} = {}) {
  const terminalData = {
    type: eventType,
    response: {
      id: "resp_test_1",
      status,
      usage,
      ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
      ...extraResponseFields
    }
  };
  const raw = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test_1","created_at":1700000000}}',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"test response"}]}}',
    `event: ${eventType}\ndata: ${JSON.stringify(terminalData)}`,
    ""
  ].join("\n\n");
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(raw));
      c.close();
    }
  });
}

describe("Upstream 0.5.99 forced usage & details preservation (#4551, #4574)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Real streamToJsonConverter", () => {
    it("preserves cached and reasoning token details and extra valid fields on completed", async () => {
      const usageWithExtra = {
        ...LITERAL_USAGE,
        extra_metric: 42,
        service_tier: "default"
      };
      const json = await convertResponsesStreamToJson(createCodexStream({ usage: usageWithExtra }));
      expect(json.status).toBe("completed");
      expect(json.usage.input_tokens).toBe(5000);
      expect(json.usage.output_tokens).toBe(20);
      expect(json.usage.input_tokens_details).toEqual({ cached_tokens: 4096 });
      expect(json.usage.output_tokens_details).toEqual({ reasoning_tokens: 8 });
      expect(json.usage.extra_metric).toBe(42);
      expect(json.usage.service_tier).toBe("default");
    });

    it("handles response.incomplete and preserves usage and incomplete_details", async () => {
      const json = await convertResponsesStreamToJson(createCodexStream({
        eventType: "response.incomplete",
        status: "incomplete",
        incompleteDetails: { reason: "max_output_tokens" }
      }));
      expect(json.status).toBe("incomplete");
      expect(json.incomplete_details).toEqual({ reason: "max_output_tokens" });
      expect(json.usage.input_tokens_details).toEqual({ cached_tokens: 4096 });
      expect(json.usage.output_tokens_details).toEqual({ reasoning_tokens: 8 });
    });

    it("preserves zero counters correctly", async () => {
      const zeroUsage = {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0
      };
      const json = await convertResponsesStreamToJson(createCodexStream({ usage: zeroUsage }));
      expect(json.usage.input_tokens).toBe(0);
      expect(json.usage.output_tokens).toBe(0);
      expect(json.usage.input_tokens_details).toEqual({ cached_tokens: 0 });
      expect(json.usage.output_tokens_details).toEqual({ reasoning_tokens: 0 });
    });
  });

  describe("handleForcedSSEToJson real flow", () => {
    it("preserves OpenAI inclusive semantics: prompt 5000, cache 4096, reasoning 8, persisted 5000/4096/8", async () => {
      const result = await handleForcedSSEToJson({
        providerResponse: new Response(createCodexStream(), { headers: { "content-type": "text/event-stream" } }),
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        model: "gpt-5-turbo",
        body: { model: "gpt-5-turbo", messages: [] },
        stream: false,
        requestStartTime: Date.now(),
        connectionId: "conn-test-openai",
        clientRawRequest: { endpoint: "/v1/chat/completions" },
        trackDone: vi.fn(),
        appendLog: vi.fn()
      });

      expect(result.success).toBe(true);
      const json = await result.response.json();
      expect(json.usage.prompt_tokens).toBe(5000);
      expect(json.usage.completion_tokens).toBe(20);
      expect(json.usage.prompt_tokens_details).toEqual({ cached_tokens: 4096 });
      expect(json.usage.completion_tokens_details).toEqual({ reasoning_tokens: 8 });

      // Persisted usage via saveRequestUsage: prompt 5000, cached 4096, reasoning 8
      expect(usageDb.saveRequestUsage).toHaveBeenCalled();
      const saved = usageDb.saveRequestUsage.mock.calls.at(-1)[0].tokens;
      expect(saved.prompt_tokens).toBe(5000);
      expect(saved.completion_tokens).toBe(20);
      expect(saved.cached_tokens).toBe(4096);
      expect(saved.reasoning_tokens).toBe(8);
    });

    it("preserves Claude exclusive semantics: input 904, cache 4096, output 20, persisted 5000/4096/8", async () => {
      const result = await handleForcedSSEToJson({
        providerResponse: new Response(createCodexStream(), { headers: { "content-type": "text/event-stream" } }),
        sourceFormat: FORMATS.CLAUDE,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        model: "gpt-5-turbo",
        body: { model: "gpt-5-turbo", messages: [] },
        stream: false,
        requestStartTime: Date.now(),
        connectionId: "conn-test-claude",
        clientRawRequest: { endpoint: "/v1/messages" },
        trackDone: vi.fn(),
        appendLog: vi.fn()
      });

      expect(result.success).toBe(true);
      const json = await result.response.json();
      expect(json.type).toBe("message");
      expect(json.usage.input_tokens).toBe(904);
      expect(json.usage.cache_read_input_tokens).toBe(4096);
      expect(json.usage.output_tokens).toBe(20);

      // Persisted usage via saveRequestUsage: canonical prompt 5000, cached 4096, reasoning 8
      expect(usageDb.saveRequestUsage).toHaveBeenCalled();
      const saved = usageDb.saveRequestUsage.mock.calls.at(-1)[0].tokens;
      expect(saved.prompt_tokens).toBe(5000);
      expect(saved.completion_tokens).toBe(20);
      expect(saved.cached_tokens).toBe(4096);
      expect(saved.reasoning_tokens).toBe(8);
    });

    it("handles response.incomplete in handleForcedSSEToJson with finish_reason length and preserves details", async () => {
      const result = await handleForcedSSEToJson({
        providerResponse: new Response(createCodexStream({
          eventType: "response.incomplete",
          status: "incomplete",
          incompleteDetails: { reason: "max_output_tokens" }
        }), { headers: { "content-type": "text/event-stream" } }),
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        model: "gpt-5-turbo",
        body: { model: "gpt-5-turbo", messages: [] },
        stream: false,
        requestStartTime: Date.now(),
        connectionId: "conn-test-incomplete",
        clientRawRequest: { endpoint: "/v1/chat/completions" },
        trackDone: vi.fn(),
        appendLog: vi.fn()
      });

      expect(result.success).toBe(true);
      const json = await result.response.json();
      expect(json.choices[0].finish_reason).toBe("length");
      expect(json.usage.prompt_tokens).toBe(5000);
      expect(json.usage.prompt_tokens_details).toEqual({ cached_tokens: 4096 });
      expect(json.usage.completion_tokens_details).toEqual({ reasoning_tokens: 8 });
    });

    it("handles zero counters in handleForcedSSEToJson", async () => {
      const zeroUsage = {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0
      };
      const result = await handleForcedSSEToJson({
        providerResponse: new Response(createCodexStream({ usage: zeroUsage }), { headers: { "content-type": "text/event-stream" } }),
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        model: "gpt-5-turbo",
        body: { model: "gpt-5-turbo", messages: [] },
        stream: false,
        requestStartTime: Date.now(),
        connectionId: "conn-test-zero",
        clientRawRequest: { endpoint: "/v1/chat/completions" },
        trackDone: vi.fn(),
        appendLog: vi.fn()
      });

      expect(result.success).toBe(true);
      const json = await result.response.json();
      expect(json.usage.prompt_tokens).toBe(0);
      expect(json.usage.completion_tokens).toBe(0);
    });
  });

  describe("canonicalizeUsage", () => {
    it("canonicalizes Responses usage with cached part in prompt and reasoning extracted", () => {
      const c = canonicalizeUsage(LITERAL_USAGE);
      expect(c.prompt_tokens).toBe(5000);
      expect(c.cached_tokens).toBe(4096);
      expect(c.completion_tokens).toBe(20);
      expect(c.reasoning_tokens).toBe(8);
      expect(c.total_tokens).toBe(5020);
    });

    it("canonicalization is strictly idempotent", () => {
      const first = canonicalizeUsage(LITERAL_USAGE);
      const second = canonicalizeUsage(first);
      expect(second).toEqual(first);
    });

    it("handles zero counters and missing details gracefully", () => {
      const zero = canonicalizeUsage({
        input_tokens: 0,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 }
      });
      expect(zero.prompt_tokens).toBe(0);
      expect(zero.completion_tokens).toBe(0);
      expect(zero.cached_tokens).toBe(0);
      expect(zero.reasoning_tokens).toBeUndefined();
    });
  });

  describe("extractUsageFromResponse (non-stream)", () => {
    it("extracts reasoning_tokens and cached_tokens from Responses format", () => {
      const extracted = extractUsageFromResponse({
        usage: LITERAL_USAGE
      });
      expect(extracted.prompt_tokens).toBe(5000);
      expect(extracted.cached_tokens).toBe(4096);
      expect(extracted.completion_tokens).toBe(20);
      expect(extracted.reasoning_tokens).toBe(8);

      const canonical = canonicalizeUsage(extracted);
      expect(canonical.prompt_tokens).toBe(5000);
      expect(canonical.cached_tokens).toBe(4096);
      expect(canonical.reasoning_tokens).toBe(8);
    });

    it("extracts reasoning_tokens from OpenAI output_tokens_details format if present", () => {
      const extracted = extractUsageFromResponse({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          output_tokens_details: { reasoning_tokens: 15 }
        }
      });
      expect(extracted.reasoning_tokens).toBe(15);
    });
  });

  describe("extractUsage (stream chunks)", () => {
    it("extracts reasoning and cache from response.completed / response.done / response.incomplete", () => {
      for (const type of ["response.completed", "response.done", "response.incomplete"]) {
        const chunk = {
          type,
          response: { usage: LITERAL_USAGE }
        };
        const extracted = extractUsage(chunk);
        expect(extracted.prompt_tokens).toBe(5000);
        expect(extracted.completion_tokens).toBe(20);
        expect(extracted.cached_tokens).toBe(4096);
        expect(extracted.reasoning_tokens).toBe(8);
      }
    });
  });
});
