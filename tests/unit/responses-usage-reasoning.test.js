import { describe, it, expect } from "vitest";
import { translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";

function newChatState() {
  return {
    seq: 0,
    responseId: "resp_test_usage",
    created: 1234567890,
    started: false,
    msgTextBuf: {},
    msgItemAdded: {},
    msgContentAdded: {},
    msgItemDone: {},
    reasoningId: "",
    reasoningIndex: -1,
    reasoningBuf: "",
    reasoningPartAdded: false,
    reasoningDone: false,
    inThinking: false,
    funcArgsBuf: {},
    funcNames: {},
    funcCallIds: {},
    funcItemAdded: {},
    funcArgsDone: {},
    funcItemDone: {},
    customToolNames: new Set(),
    completedSent: false,
    respToolChatIndex: new Map(),
    respToolArgsEmitted: new Set(),
  };
}

describe("Responses API → OpenAI Chat: usage reasoning_tokens and cache details preservation", () => {
  it("preserves output_tokens_details.reasoning_tokens to completion_tokens_details and preserves cache details in final chunk", () => {
    const state = newChatState();

    // Start response
    const textEvent = {
      type: "response.output_text.delta",
      delta: "Hello, world!",
    };
    translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, textEvent, state);

    // Response completed event with reasoning_tokens in output_tokens_details and cache details
    const completedEvent = {
      type: "response.completed",
      response: {
        id: "resp_test_usage",
        status: "completed",
        usage: {
          input_tokens: 150,
          output_tokens: 85,
          total_tokens: 235,
          input_tokens_details: {
            cached_tokens: 45,
            cache_creation_tokens: 20,
          },
          output_tokens_details: {
            reasoning_tokens: 35,
          },
        },
      },
    };

    const finalChunks = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, completedEvent, state);
    expect(finalChunks).toHaveLength(1);
    const finalChunk = finalChunks[0];

    expect(finalChunk.usage).toBeDefined();
    expect(finalChunk.usage.prompt_tokens).toBe(150);
    expect(finalChunk.usage.completion_tokens).toBe(85);
    expect(finalChunk.usage.total_tokens).toBe(235);

    // Cache details preserved in prompt_tokens_details
    expect(finalChunk.usage.prompt_tokens_details).toBeDefined();
    expect(finalChunk.usage.prompt_tokens_details.cached_tokens).toBe(45);
    expect(finalChunk.usage.prompt_tokens_details.cache_creation_tokens).toBe(20);

    // Reasoning tokens preserved in completion_tokens_details
    expect(finalChunk.usage.completion_tokens_details).toBeDefined();
    expect(finalChunk.usage.completion_tokens_details.reasoning_tokens).toBe(35);
  });

  it("extracts reasoning_tokens and cache details via direct openaiResponsesToOpenAIResponse", () => {
    const state = newChatState();

    // Start with empty added item
    openaiResponsesToOpenAIResponse({
      type: "response.output_text.delta",
      delta: "Test",
    }, state);

    const completedEvent = {
      type: "response.completed",
      response: {
        id: "resp_direct_usage",
        status: "completed",
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          total_tokens: 300,
          input_tokens_details: {
            cached_tokens: 60,
          },
          output_tokens_details: {
            reasoning_tokens: 50,
          },
        },
      },
    };

    const chunk = openaiResponsesToOpenAIResponse(completedEvent, state);
    expect(chunk).not.toBeNull();
    expect(chunk.usage).toBeDefined();
    expect(chunk.usage.prompt_tokens_details?.cached_tokens).toBe(60);
    expect(chunk.usage.completion_tokens_details?.reasoning_tokens).toBe(50);
  });
});
