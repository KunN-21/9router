import { describe, it, expect, vi } from "vitest";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import {
  cleanJSONSchemaForAntigravity,
  normalizeGeminiContents,
  sanitizeFunctionResponsePayload,
  GEMINI_RESERVED_RESPONSE_KEYS
} from "../../open-sse/translator/formats/gemini.js";
import kimiRegistry from "../../open-sse/providers/registry/kimi.js";

// Mock thoughtSignatureStore boundary to prevent actual DB/credential reads
vi.mock("../../open-sse/services/thoughtSignatureStore.js", () => ({
  getGeminiThoughtSignatureSync: vi.fn(),
  setGeminiThoughtSignature: vi.fn(),
}));

describe("Gemini and Kimi selective upstream fixes", () => {
  it("pairs duplicate Gemini tool results FIFO and uniquifies IDs (6e4f82db)", () => {
    const result = openaiToGeminiRequest("gemini-test", {
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_same", type: "function", function: { name: "toolA", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_same", content: "first" },
        { role: "assistant", tool_calls: [{ id: "call_same", type: "function", function: { name: "toolB", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_same", content: "second" },
      ],
    }, true);

    const modelParts = result.contents.flatMap((entry) => entry.parts).filter((part) => part.functionCall);
    const userParts = result.contents.flatMap((entry) => entry.parts).filter((part) => part.functionResponse);

    expect(modelParts.map((part) => part.functionCall.id)).toEqual(["call_same", "call_same-2"]);
    expect(userParts.map((part) => part.functionResponse.id)).toEqual(["call_same", "call_same-2"]);
    expect(userParts.map((part) => part.functionResponse.name)).toEqual(["toolA", "toolB"]);
    expect(userParts.map((part) => part.functionResponse.response?.result?.result)).toEqual(["first", "second"]);
  });

  it("pairs duplicate tool results with prototype keys (toString, valueOf, constructor, __proto__) FIFO and safely", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "toString", type: "function", function: { name: "tool_toString_1", arguments: "{}" } }
          ]
        },
        { role: "tool", tool_call_id: "toString", content: JSON.stringify({ r: 1 }) },
        {
          role: "assistant",
          tool_calls: [
            { id: "toString", type: "function", function: { name: "tool_toString_2", arguments: "{}" } }
          ]
        },
        { role: "tool", tool_call_id: "toString", content: JSON.stringify({ r: 2 }) },
        {
          role: "assistant",
          tool_calls: [
            { id: "constructor", type: "function", function: { name: "tool_ctor", arguments: "{}" } },
            { id: "__proto__", type: "function", function: { name: "tool_proto", arguments: "{}" } },
            { id: "valueOf", type: "function", function: { name: "tool_val", arguments: "{}" } }
          ]
        },
        { role: "tool", tool_call_id: "constructor", content: "ctor_resp" },
        { role: "tool", tool_call_id: "__proto__", content: "proto_resp" },
        { role: "tool", tool_call_id: "valueOf", content: "val_resp" }
      ]
    };

    const result = openaiToGeminiRequest("gemini-test", input, true);
    const modelCalls = result.contents.flatMap((c) => c.parts).filter((p) => p.functionCall);
    const userResponses = result.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);

    expect(modelCalls.map((p) => p.functionCall.id)).toEqual([
      "toString",
      "toString-2",
      "constructor",
      "__proto__",
      "valueOf"
    ]);
    expect(userResponses.map((p) => p.functionResponse.id)).toEqual([
      "toString",
      "toString-2",
      "constructor",
      "__proto__",
      "valueOf"
    ]);
    expect(userResponses.map((p) => p.functionResponse.name)).toEqual([
      "tool_toString_1",
      "tool_toString_2",
      "tool_ctor",
      "tool_proto",
      "tool_val"
    ]);
    expect(userResponses.map((p) => p.functionResponse.response?.result)).toEqual([
      { r: 1 },
      { r: 2 },
      { result: "ctor_resp" },
      { result: "proto_resp" },
      { result: "val_resp" }
    ]);
  });

  it("handles parallel duplicate tool_call_ids and literal suffix collisions in uniquifier", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call-2", type: "function", function: { name: "tool_prefixed", arguments: "{}" } },
            { id: "call", type: "function", function: { name: "tool_base_1", arguments: "{}" } },
            { id: "call", type: "function", function: { name: "tool_base_2", arguments: "{}" } }
          ]
        },
        { role: "tool", tool_call_id: "call-2", content: "resp_prefixed" },
        { role: "tool", tool_call_id: "call", content: "resp_base_1" },
        { role: "tool", tool_call_id: "call", content: "resp_base_2" }
      ]
    };

    const result = openaiToGeminiRequest("gemini-test", input, true);
    const modelCalls = result.contents.flatMap((c) => c.parts).filter((p) => p.functionCall);
    const userResponses = result.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);

    // "call-2" was already taken by the first call, so duplicate "call" skips "call-2" and lands on "call-3"
    expect(modelCalls.map((p) => p.functionCall.id)).toEqual(["call-2", "call", "call-3"]);
    expect(userResponses.map((p) => p.functionResponse.id)).toEqual(["call-2", "call", "call-3"]);
    expect(userResponses.map((p) => p.functionResponse.name)).toEqual(["tool_prefixed", "tool_base_1", "tool_base_2"]);
    expect(userResponses.map((p) => p.functionResponse.response?.result?.result)).toEqual([
      "resp_prefixed",
      "resp_base_1",
      "resp_base_2"
    ]);
  });

  it("GEMINI_RESERVED_RESPONSE_KEYS is a null-prototype object that does not return Object.prototype values", () => {
    expect(Object.getPrototypeOf(GEMINI_RESERVED_RESPONSE_KEYS)).toBeNull();
    expect(GEMINI_RESERVED_RESPONSE_KEYS["$ref"]).toBe("_ref");
    expect(GEMINI_RESERVED_RESPONSE_KEYS["toString"]).toBeUndefined();
    expect(GEMINI_RESERVED_RESPONSE_KEYS["valueOf"]).toBeUndefined();
    expect(GEMINI_RESERVED_RESPONSE_KEYS["constructor"]).toBeUndefined();
    expect(GEMINI_RESERVED_RESPONSE_KEYS["__proto__"]).toBeUndefined();
  });

  it("sanitizeFunctionResponsePayload roundtrips own keys without prototype pollution or mutating Object.prototype", () => {
    const payload = {
      toString: "custom_toString",
      valueOf: "custom_valueOf",
      constructor: "custom_constructor",
      plain: 123
    };
    Object.defineProperty(payload, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true
    });

    const out = sanitizeFunctionResponsePayload(payload);

    // No prototype mutation
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({}).polluted).toBeUndefined();

    // Roundtrip own keys preserved
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(out.toString).toBe("custom_toString");
    expect(out.valueOf).toBe("custom_valueOf");
    expect(out.constructor).toBe("custom_constructor");
    expect(out.plain).toBe(123);
    expect(Reflect.ownKeys(out)).toEqual(expect.arrayContaining(["toString", "valueOf", "constructor", "plain", "__proto__"]));
  });

  it("sanitizeFunctionResponsePayload sanitizes nested arrays recursively", () => {
    const payload = {
      nested: [
        [{ $ref: "#/$defs/Deep", toString: "inside" }],
        "string",
        42,
        null
      ]
    };
    const out = sanitizeFunctionResponsePayload(payload);
    expect(out.nested[0][0]._ref).toBe("#/$defs/Deep");
    expect(out.nested[0][0].$ref).toBeUndefined();
    expect(out.nested[0][0].toString).toBe("inside");
    expect(out.nested[1]).toBe("string");
    expect(out.nested[2]).toBe(42);
    expect(out.nested[3]).toBeNull();
  });

  it("sanitizeFunctionResponsePayload preserves data on $ref and _ref collision without dropping either", () => {
    const payload = {
      $ref: "#/$defs/FromDollar",
      _ref: "existing_underscore_ref"
    };
    const out = sanitizeFunctionResponsePayload(payload);

    const values = Object.values(out);
    expect(values).toContain("#/$defs/FromDollar");
    expect(values).toContain("existing_underscore_ref");
    expect(out.$ref).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(2);
  });

  it("renames $ref keys to _ref in functionResponse payloads (625df74)", () => {
    const rawContents = [
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "read_schema",
              id: "call_1",
              response: {
                result: {
                  $ref: "#/$defs/MyType",
                  nested: { $ref: "#/$defs/Nested" },
                  items: [{ $ref: "#/$defs/Item" }]
                }
              }
            }
          }
        ]
      }
    ];

    const normalized = normalizeGeminiContents(rawContents);
    const res = normalized[0].parts[0].functionResponse.response;
    expect(res).toEqual({
      result: {
        _ref: "#/$defs/MyType",
        nested: { _ref: "#/$defs/Nested" },
        items: [{ _ref: "#/$defs/Item" }]
      }
    });
  });

  it("keeps input messages and structures non-mutating", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "toolA", arguments: "{}" } }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: JSON.stringify({ $ref: "#/$defs/A" }) }
      ]
    };
    const inputBefore = JSON.stringify(input);
    openaiToGeminiRequest("gemini-test", input, true);
    expect(JSON.stringify(input)).toBe(inputBefore);
  });

  it("does not treat properties map as schema node when tool param named properties (09f6d395)", () => {
    const schema = {
      type: "object",
      properties: {
        properties: {
          description: "A map of property names to definitions"
        }
      }
    };

    cleanJSONSchemaForAntigravity(schema);
    // Before 09f6d395, schema.properties gets corrupted with type: "object"
    expect(schema.properties.type).toBeUndefined();
  });

  it("includes Kimi Responses transport in provider registry (3125ac2)", () => {
    const responsesTransport = kimiRegistry.transports?.find(t => t.format === "openai-responses");
    expect(responsesTransport).toBeDefined();
    expect(responsesTransport.baseUrl).toBe("https://api.kimi.com/coding/v1/responses");
    expect(responsesTransport.auth).toEqual({
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: ["kimiHeaders"]
    });
  });
});
