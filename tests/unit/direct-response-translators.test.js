import { describe, it, expect } from "vitest";
import { translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("responses-to-claude direct response translator", () => {
  it("translates text, thinking, and tool_use directly to Claude SSE events", () => {
    const state = {
      toolNameMap: new Map([["sanitized_tool", "my:custom.tool"]]),
    };

    // 1. response.created
    const init = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, {
      type: "response.created",
      response: { id: "resp_123" },
    }, state);
    expect(init).toBeDefined();
    expect(init[0].type).toBe("message_start");
    expect(init[0].message.id).toBe("resp_123");

    // 2. reasoning delta
    const think = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, {
      type: "response.reasoning_summary_text.delta",
      delta: "thinking deep",
    }, state);
    expect(think).toHaveLength(2);
    expect(think[0].type).toBe("content_block_start");
    expect(think[0].content_block.type).toBe("thinking");
    expect(think[1].type).toBe("content_block_delta");
    expect(think[1].delta.type).toBe("thinking_delta");
    expect(think[1].delta.thinking).toBe("thinking deep");

    // 3. text delta
    const text = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, {
      type: "response.output_text.delta",
      delta: "hello world",
    }, state);
    expect(text.some((e) => e.type === "content_block_stop")).toBe(true); // closes thinking
    const textStart = text.find((e) => e.type === "content_block_start");
    expect(textStart.content_block.type).toBe("text");
    const textDelta = text.find((e) => e.type === "content_block_delta");
    expect(textDelta.delta.text).toBe("hello world");

    // 4. function call added
    const toolAdd = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "fc_1",
        call_id: "call_abc",
        type: "function_call",
        name: "sanitized_tool",
      },
    }, state);
    const toolStart = toolAdd.find((e) => e.type === "content_block_start");
    expect(toolStart.content_block.type).toBe("tool_use");
    expect(toolStart.content_block.id).toBe("call_abc");
    expect(toolStart.content_block.name).toBe("my:custom.tool"); // restored name!

    // 5. function call args delta (with path alias for Read)
    translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      delta: '{"path": "/tmp/test.js"}',
    }, state);

    // 6. function call done (sanitizes path -> file_path)
    const toolDone = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "fc_1",
        call_id: "call_abc",
        type: "function_call",
        name: "Read",
      },
    }, state);
    const argDelta = toolDone.find((e) => e.type === "content_block_delta");
    expect(argDelta.delta.type).toBe("input_json_delta");
    const parsedArgs = JSON.parse(argDelta.delta.partial_json);
    expect(parsedArgs.file_path).toBe("/tmp/test.js"); // sanitized!

    // 7. completed
    const done = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 20 },
        },
      },
    }, state);
    const msgDelta = done.find((e) => e.type === "message_delta");
    expect(msgDelta.delta.stop_reason).toBe("tool_use");
    expect(msgDelta.usage.input_tokens).toBe(100);
    expect(msgDelta.usage.output_tokens).toBe(50);
    expect(msgDelta.usage.cache_read_input_tokens).toBe(20);
    expect(done.some((e) => e.type === "message_stop")).toBe(true);
  });
});

describe("gemini-to-claude direct response translator", () => {
  it("translates Gemini candidates directly to Claude SSE events", () => {
    const state = {
      toolNameMap: new Map([["sanitized_tool", "my:custom.tool"]]),
    };

    // 1. Thinking part
    const thinkChunk = {
      responseId: "resp_gemini_1",
      modelVersion: "gemini-3.8-flash",
      candidates: [{
        content: {
          parts: [{
            text: "pondering...",
            thought: true,
          }],
        },
      }],
    };
    const thinkEvents = translateResponse(FORMATS.GEMINI, FORMATS.CLAUDE, thinkChunk, state);
    expect(thinkEvents.some((e) => e.type === "message_start")).toBe(true);
    const thinkStart = thinkEvents.find((e) => e.type === "content_block_start");
    expect(thinkStart.content_block.type).toBe("thinking");
    const thinkDelta = thinkEvents.find((e) => e.type === "content_block_delta");
    expect(thinkDelta.delta.thinking).toBe("pondering...");

    // 2. Text part
    const textChunk = {
      candidates: [{
        content: {
          parts: [{
            text: "Here is the answer",
          }],
        },
      }],
    };
    const textEvents = translateResponse(FORMATS.GEMINI, FORMATS.CLAUDE, textChunk, state);
    expect(textEvents.some((e) => e.type === "content_block_stop")).toBe(true); // closes thinking
    const textStart = textEvents.find((e) => e.type === "content_block_start");
    expect(textStart.content_block.type).toBe("text");
    const textDelta = textEvents.find((e) => e.type === "content_block_delta");
    expect(textDelta.delta.text).toBe("Here is the answer");

    // 3. Function call part (with path alias for Read)
    const toolChunk = {
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              id: "call_g1",
              name: "Read",
              args: { path: "/workspace/index.js", limit: "50" },
            },
          }],
        },
      }],
    };
    const toolEvents = translateResponse(FORMATS.GEMINI, FORMATS.CLAUDE, toolChunk, state);
    const toolStart = toolEvents.find((e) => e.type === "content_block_start");
    expect(toolStart.content_block.type).toBe("tool_use");
    const toolDelta = toolEvents.find((e) => e.type === "content_block_delta");
    const toolParsed = JSON.parse(toolDelta.delta.partial_json);
    expect(toolParsed.file_path).toBe("/workspace/index.js"); // sanitized!
    expect(toolParsed.limit).toBe(50); // coerced number!

    // 4. Finish reason + usage
    const finishChunk = {
      candidates: [{
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 75,
        cachedContentTokenCount: 50,
      },
    };
    const finishEvents = translateResponse(FORMATS.GEMINI, FORMATS.CLAUDE, finishChunk, state);
    const msgDelta = finishEvents.find((e) => e.type === "message_delta");
    expect(msgDelta.delta.stop_reason).toBe("tool_use");
    expect(msgDelta.usage.input_tokens).toBe(200);
    expect(msgDelta.usage.output_tokens).toBe(75);
    expect(msgDelta.usage.cache_read_input_tokens).toBe(50);
    expect(finishEvents.some((e) => e.type === "message_stop")).toBe(true);
  });
});
