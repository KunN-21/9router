import { describe, it } from "vitest";
import assert from "node:assert";
import { claudeToResponsesRequest } from "../../open-sse/translator/request/claude-to-responses.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("claude-to-responses schema fill", () => {
  it("normalizes top-level object schema without properties to have properties: {} in claudeToResponsesRequest", () => {
    const rawSchema = { type: "object" };
    const body = {
      tools: [
        {
          name: "search_tool",
          description: "search",
          input_schema: rawSchema,
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };

    const out = claudeToResponsesRequest("muse-spark-1.3", body, false, null);
    assert.ok(out.tools && out.tools.length === 1);
    assert.deepStrictEqual(out.tools[0].parameters, {
      type: "object",
      properties: {},
    });
    // Ensure input is not mutated
    assert.strictEqual(rawSchema.properties, undefined);
  });

  it("normalizes undefined input_schema to { type: 'object', properties: {} }", () => {
    const body = {
      tools: [
        {
          name: "no_schema_tool",
          description: "no schema",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };

    const out = claudeToResponsesRequest("muse-spark-1.3", body, false, null);
    assert.ok(out.tools && out.tools.length === 1);
    assert.deepStrictEqual(out.tools[0].parameters, {
      type: "object",
      properties: {},
    });
  });

  it("preserves schema that already has properties and extra fields", () => {
    const schemaWithProps = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    };
    const body = {
      tools: [
        {
          name: "query_tool",
          description: "query",
          input_schema: schemaWithProps,
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };

    const out = claudeToResponsesRequest("muse-spark-1.3", body, false, null);
    assert.ok(out.tools && out.tools.length === 1);
    assert.deepStrictEqual(out.tools[0].parameters, schemaWithProps);
    assert.strictEqual(out.tools[0].strict, false);
  });

  it("preserves required/additionalProperties/$defs/oneOf while adding properties: {} when properties is missing", () => {
    const complexSchema = {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      $defs: {
        Filter: { type: "string" },
      },
      oneOf: [{ type: "object" }],
    };
    const body = {
      tools: [
        {
          name: "complex_tool",
          description: "complex",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };
    body.tools[0].input_schema = complexSchema;

    const out = claudeToResponsesRequest("muse-spark-1.3", body, false, null);
    assert.ok(out.tools && out.tools.length === 1);
    assert.deepStrictEqual(out.tools[0].parameters, {
      type: "object",
      properties: {},
      required: ["query"],
      additionalProperties: false,
      $defs: {
        Filter: { type: "string" },
      },
      oneOf: [{ type: "object" }],
    });
    // Ensure complexSchema is not mutated
    assert.strictEqual(complexSchema.properties, undefined);
  });

  it("normalizes top-level schema across direct family routes via translateRequest (muse-spark and gpt-family)", () => {
    const body = {
      tools: [
        {
          name: "fetch_data",
          description: "fetch",
          input_schema: { type: "object" },
        },
      ],
      messages: [{ role: "user", content: "fetch" }],
    };

    for (const model of ["muse-spark-1.3", "gpt-4o"]) {
      const out = translateRequest(
        FORMATS.CLAUDE,
        FORMATS.OPENAI_RESPONSES,
        model,
        body,
        false,
        null,
        null,
        null,
        [],
        null,
        null
      );
      assert.ok(out.tools && out.tools.length === 1);
      assert.deepStrictEqual(
        out.tools[0].parameters,
        { type: "object", properties: {} },
        `model ${model} should have properties: {} in tool parameters`
      );
    }
  });
});
