import { describe, it, expect } from "vitest";
import { translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { responsesToClaudeResponse } from "../../open-sse/translator/response/responses-to-claude.js";

function newClaudeState() {
  return {
    messageStartSent: false,
    messageId: null,
    model: "claude-3-5-sonnet-20241022",
    nextBlockIndex: 0,
    toolCalls: new Map(),
    toolArgBuffers: new Map(),
    toolIndexByKey: new Map(),
    thinkingBlockStarted: false,
    thinkingBlockIndex: null,
    textBlockStarted: false,
    textBlockIndex: null,
    textBlockClosed: false,
    finishReasonSent: false,
    usage: null,
  };
}

describe("Responses API → Claude: incomplete status to max_tokens and Anthropic usage schema", () => {
  it("maps response.incomplete event with reason max_output_tokens to stop_reason max_tokens even during tool call", () => {
    const state = newClaudeState();

    // 1. Tool call started
    const toolAdded = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_tool_1",
        type: "function_call",
        call_id: "call_tool_1",
        name: "Read",
        arguments: '{"file_path":"/truncated',
      },
    };
    translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, toolAdded, state);

    // 2. Upstream cuts off with response.incomplete (e.g. hitting max_output_tokens)
    const incompleteEvent = {
      type: "response.incomplete",
      response: {
        id: "resp_incomplete_1",
        status: "incomplete",
        status_details: {
          reason: "max_output_tokens",
        },
        usage: {
          input_tokens: 100,
          output_tokens: 500,
        },
      },
    };

    const results = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, incompleteEvent, state);
    expect(results).not.toBeNull();
    expect(results.length).toBeGreaterThan(0);

    const messageDelta = results.find((r) => r.type === "message_delta");
    expect(messageDelta).toBeDefined();
    // Must be max_tokens, NOT tool_use, because output was truncated before completion
    expect(messageDelta.delta?.stop_reason).toBe("max_tokens");

    const messageStop = results.find((r) => r.type === "message_stop");
    expect(messageStop).toBeDefined();
  });

  it("maps response.completed with status incomplete/max_output_tokens to stop_reason max_tokens during tool call", () => {
    const state = newClaudeState();

    const toolAdded = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_tool_2",
        type: "function_call",
        call_id: "call_tool_2",
        name: "Bash",
        arguments: '{"command":"echo hello',
      },
    };
    responsesToClaudeResponse(toolAdded, state);

    // response.completed with status "incomplete" and status_details.reason "max_output_tokens"
    const completedIncomplete = {
      type: "response.completed",
      response: {
        id: "resp_incomplete_2",
        status: "incomplete",
        status_details: {
          reason: "max_output_tokens",
        },
        usage: {
          input_tokens: 120,
          output_tokens: 4096,
        },
      },
    };

    const results = responsesToClaudeResponse(completedIncomplete, state);
    expect(results).not.toBeNull();

    const messageDelta = results.find((r) => r.type === "message_delta");
    expect(messageDelta).toBeDefined();
    // Must map to max_tokens even though toolCalls.size > 0
    expect(messageDelta.delta?.stop_reason).toBe("max_tokens");
  });

  it("preserves tool_use stop_reason for complete tool calls and end_turn for text responses", () => {
    // Case 1: Complete tool call
    const stateTool = newClaudeState();
    const toolAdded = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_tool_3",
        type: "function_call",
        call_id: "call_tool_3",
        name: "Bash",
        arguments: '{"command":"pwd"}',
      },
    };
    responsesToClaudeResponse(toolAdded, stateTool);

    const normalCompleted = {
      type: "response.completed",
      response: {
        id: "resp_normal_tool",
        status: "completed",
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    };
    const toolResults = responsesToClaudeResponse(normalCompleted, stateTool);
    const toolDelta = toolResults.find((r) => r.type === "message_delta");
    expect(toolDelta.delta?.stop_reason).toBe("tool_use");

    // Case 2: Complete text response
    const stateText = newClaudeState();
    const textDelta = {
      type: "response.output_text.delta",
      delta: "All done.",
    };
    responsesToClaudeResponse(textDelta, stateText);

    const textCompleted = {
      type: "response.completed",
      response: {
        id: "resp_normal_text",
        status: "completed",
        usage: { input_tokens: 30, output_tokens: 10 },
      },
    };
    const textResults = responsesToClaudeResponse(textCompleted, stateText);
    const textDeltaMsg = textResults.find((r) => r.type === "message_delta");
    expect(textDeltaMsg.delta?.stop_reason).toBe("end_turn");
  });

  it("conforms strictly to Anthropic Messages usage schema and does NOT leak reasoning_tokens", () => {
    const state = newClaudeState();

    responsesToClaudeResponse({
      type: "response.output_text.delta",
      delta: "Thinking finished.",
    }, state);

    // Upstream sends usage with reasoning_tokens
    const completedEvent = {
      type: "response.completed",
      response: {
        id: "resp_usage_schema",
        status: "completed",
        usage: {
          input_tokens: 200,
          output_tokens: 150,
          input_tokens_details: {
            cached_tokens: 50,
          },
          output_tokens_details: {
            reasoning_tokens: 80,
          },
        },
      },
    };

    const results = responsesToClaudeResponse(completedEvent, state);
    const delta = results.find((r) => r.type === "message_delta");
    expect(delta).toBeDefined();
    expect(delta.usage).toBeDefined();

    // Anthropic schema: input_tokens, output_tokens, cache_read_input_tokens
    expect(delta.usage.input_tokens).toBe(200);
    expect(delta.usage.output_tokens).toBe(150);
    expect(delta.usage.cache_read_input_tokens).toBe(50);

    // MUST NOT contain reasoning_tokens in public Anthropic usage
    expect(delta.usage.reasoning_tokens).toBeUndefined();
    expect("reasoning_tokens" in delta.usage).toBe(false);
  });

  it("emits sanitized {} input_json_delta for empty tool buffer on incomplete max_output_tokens", () => {
    const state = newClaudeState();
    responsesToClaudeResponse({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "item_empty_1", type: "function_call", call_id: "call_empty_1", name: "Read", arguments: "" },
    }, state);
    const results = responsesToClaudeResponse({
      type: "response.incomplete",
      response: { id: "resp_empty_1", status: "incomplete", status_details: { reason: "max_output_tokens" } },
    }, state);
    const deltas = results.filter((r) => r.type === "content_block_delta");
    expect(deltas.length).toBe(1);
    expect(deltas[0].delta?.type).toBe("input_json_delta");
    expect(JSON.parse(deltas[0].delta.partial_json)).toEqual({});
    const stop = results.find((r) => r.type === "message_delta");
    expect(stop.delta?.stop_reason).toBe("max_tokens");
  });
});
