import { describe, it, expect } from "vitest";
import { translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";

function newChatState() {
  return {
    seq: 0,
    responseId: "resp_test",
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

describe("Responses API → OpenAI Chat: zero delta empty arguments wire", () => {
  it("emits exactly one {} argument chunk on added-time index when done arrives with empty arguments and id != call_id", () => {
    const state = newChatState();

    // 1. Output item added: function call declared with id != call_id
    const addedEvent = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_xyz123",
        type: "function_call",
        call_id: "call_abc789",
        name: "get_weather",
        arguments: "",
      },
    };

    // Actual translator dispatch via translateResponse
    const addedChunks = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, addedEvent, state);
    expect(addedChunks).toHaveLength(1);
    expect(addedChunks[0].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: "call_abc789",
        type: "function",
        function: {
          name: "get_weather",
          arguments: "",
        },
      },
    ]);

    // Zero deltas emitted between added and done

    // 2. Done arrives with empty arguments (or {}) referenced by item_id (not call_id)
    const doneEvent = {
      type: "response.function_call_arguments.done",
      item_id: "item_xyz123",
      output_index: 0,
      arguments: "",
    };

    const doneChunks = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, doneEvent, state);
    // Must emit exactly one chunk with arguments "{}" on index 0
    expect(doneChunks).toHaveLength(1);
    expect(doneChunks[0].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        function: {
          arguments: "{}",
        },
      },
    ]);

    // 3. Duplicate done arrives (e.g. response.output_item.done after function_call_arguments.done)
    const duplicateDoneEvent = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "item_xyz123",
        type: "function_call",
        call_id: "call_abc789",
        name: "get_weather",
        arguments: "",
      },
    };

    const dupChunks = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, duplicateDoneEvent, state);
    // Duplicate done must not emit another argument chunk
    expect(dupChunks).toHaveLength(0);
  });

  it("handles parallel same-name tools with zero delta and emits {} on distinct added-time indices", () => {
    const state = newChatState();

    // Parallel same-name tools: Tool 0 and Tool 1
    const addTool0 = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_read_0",
        type: "function_call",
        call_id: "call_read_0",
        name: "Read",
        arguments: "",
      },
    };
    const addTool1 = {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "item_read_1",
        type: "function_call",
        call_id: "call_read_1",
        name: "Read",
        arguments: "",
      },
    };

    const chunk0 = openaiResponsesToOpenAIResponse(addTool0, state);
    const chunk1 = openaiResponsesToOpenAIResponse(addTool1, state);

    expect(chunk0.choices[0].delta.tool_calls[0].index).toBe(0);
    expect(chunk1.choices[0].delta.tool_calls[0].index).toBe(1);

    // Zero deltas for both.
    // Done for Tool 0 with item_id: "item_read_0"
    const doneTool0 = {
      type: "response.function_call_arguments.done",
      item_id: "item_read_0",
      output_index: 0,
      arguments: "{}",
    };
    const chunkDone0 = openaiResponsesToOpenAIResponse(doneTool0, state);
    expect(chunkDone0).not.toBeNull();
    expect(chunkDone0.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      function: { arguments: "{}" },
    });

    // Done for Tool 1 with item_id: "item_read_1"
    const doneTool1 = {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "item_read_1",
        type: "function_call",
        call_id: "call_read_1",
        name: "Read",
        arguments: "",
      },
    };
    const chunkDone1 = openaiResponsesToOpenAIResponse(doneTool1, state);
    expect(chunkDone1).not.toBeNull();
    expect(chunkDone1.choices[0].delta.tool_calls[0]).toEqual({
      index: 1,
      function: { arguments: "{}" },
    });

    // Duplicate done for Tool 0 must not emit again
    const dupDoneTool0 = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "item_read_0",
        type: "function_call",
        call_id: "call_read_0",
        name: "Read",
        arguments: "{}",
      },
    };
    const dupChunk0 = openaiResponsesToOpenAIResponse(dupDoneTool0, state);
    expect(dupChunk0).toBeNull();
  });
});
