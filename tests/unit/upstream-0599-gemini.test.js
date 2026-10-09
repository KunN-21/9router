import { describe, it, expect } from "vitest";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { cleanJSONSchemaForAntigravity, normalizeGeminiContents } from "../../open-sse/translator/formats/gemini.js";
import kimiRegistry from "../../open-sse/providers/registry/kimi.js";

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
