import { describe, expect, it } from "vitest";

import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { openAICompletionToResponses } from "../../open-sse/handlers/chatCore/nonStreamingFormatters.js";

const encoder = new TextEncoder();
const sseBody = (text) => new Response(new ReadableStream({
  start(c) {
    if (text) c.enqueue(encoder.encode(text));
    c.close();
  },
})).body;

describe("convertResponsesStreamToJson empty/missing-terminal → failed", () => {
  it("SSE rỗng trả status failed, không trả in_progress HTTP200", async () => {
    const json = await convertResponsesStreamToJson(sseBody(""));
    expect(json.status).toBe("failed");
    expect(json.output).toEqual([]);
  });

  it("SSE thiếu response.completed/response.failed trả failed", async () => {
    const json = await convertResponsesStreamToJson(sseBody(
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp_x","status":"in_progress"}}\n\n' +
      'event: response.output_item.done\n' +
      'data: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial","annotations":[]}]}}\n\n'
    ));
    expect(json.status).toBe("failed");
  });

  it("stream null trả failed", async () => {
    const json = await convertResponsesStreamToJson(null);
    expect(json.status).toBe("failed");
  });

  it("giữ nguyên vá response.failed hiện có", async () => {
    const json = await convertResponsesStreamToJson(sseBody(
      'event: response.failed\n' +
      'data: {"type":"response.failed","response":{"id":"resp_f","status":"failed"}}\n\n'
    ));
    expect(json.status).toBe("failed");
  });

  it("response.completed vẫn completed (không sửa over)", async () => {
    const json = await convertResponsesStreamToJson(sseBody(
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_ok","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n'
    ));
    expect(json.status).toBe("completed");
  });

  it("response.incomplete max_output_tokens vẫn incomplete (không sửa over)", async () => {
    const json = await convertResponsesStreamToJson(sseBody(
      'event: response.incomplete\n' +
      'data: {"type":"response.incomplete","response":{"id":"resp_tr","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n'
    ));
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  // Finding 5: sawTerminal / SSE parsing edge cases
  it("Finding 5: CRLF SSE stream with response.completed parses correctly and returns completed status", async () => {
    const raw = "event: response.completed\r\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_crlf\",\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":10,\"total_tokens\":15}}}\r\n\r\n";
    const json = await convertResponsesStreamToJson(sseBody(raw));
    expect(json.status).toBe("completed");
    expect(json.id).toBe("resp_crlf");
  });

  it("Finding 5: Data-only SSE with type in data payload parses correctly and does not fail", async () => {
    const raw = 'data: {"type":"response.completed","response":{"id":"resp_dataonly","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n';
    const json = await convertResponsesStreamToJson(sseBody(raw));
    expect(json.status).toBe("completed");
    expect(json.id).toBe("resp_dataonly");
  });

  it("Finding 5: Terminal response.completed with full response.output preserves output items", async () => {
    const raw =
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_full","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello world","annotations":[]}]}]}}\n\n';
    const json = await convertResponsesStreamToJson(sseBody(raw));
    expect(json.status).toBe("completed");
    expect(json.output).toHaveLength(1);
    expect(json.output[0].content[0].text).toBe("hello world");
  });

  it("Finding 5: Terminal response.output completes list even when partial output_item.done arrived", async () => {
    const raw =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp_partial","status":"in_progress"}}\n\n' +
      'event: response.output_item.done\n' +
      'data: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"part 0","annotations":[]}]}}\n\n' +
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_partial","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"part 0 final","annotations":[]}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"part 1 final","annotations":[]}]}]}}\n\n';
    const json = await convertResponsesStreamToJson(sseBody(raw));
    expect(json.status).toBe("completed");
    expect(json.output).toHaveLength(2);
    expect(json.output[0].content[0].text).toBe("part 0 final");
    expect(json.output[1].content[0].text).toBe("part 1 final");
  });

  it("Finding 5: Completed with output:[] is valid and preserves output:[]", async () => {
    const raw =
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_empty_out","status":"completed","output":[]}}\n\n';
    const json = await convertResponsesStreamToJson(sseBody(raw));
    expect(json.status).toBe("completed");
    expect(json.output).toEqual([]);
  });

  it("Finding 5: Upstream response.failed distinguishes error payload from missing terminal", async () => {
    const raw =
      'event: response.failed\n' +
      'data: {"type":"response.failed","response":{"id":"resp_err","status":"failed","error":{"message":"Upstream model overloaded"}}}\n\n';
    const json = await convertResponsesStreamToJson(sseBody(raw));
    expect(json.status).toBe("failed");
    expect(json.error).toEqual({ message: "Upstream model overloaded" });
  });

  // Self-check reproduction: three protocol contract gaps
  it("Bug 1: openAICompletionToResponses with finish_reason=length maps to status incomplete and incomplete_details max_output_tokens", () => {
    const chatBody = {
      id: "chatcmpl-trunc-1",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "partial content" },
          finish_reason: "length"
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    };

    const resp = openAICompletionToResponses(chatBody);
    expect(resp.status).toBe("incomplete");
    expect(resp.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("Bug 2: terminal response.completed output:[] clears previous streamed output_item.done under authoritative output semantics", async () => {
    const raw =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp_auth_test","status":"in_progress"}}\n\n' +
      'event: response.output_item.done\n' +
      'data: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"streamed item","annotations":[]}]}}\n\n' +
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_auth_test","status":"completed","output":[]}}\n\n';

    const json = await convertResponsesStreamToJson(sseBody(raw));
    expect(json.status).toBe("completed");
    expect(json.output).toEqual([]);
  });

  it("Bug 3: terminal response preserves model and usage details/cache/reasoning metadata", async () => {
    const raw =
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_meta_test","status":"completed","model":"gpt-5-codex","output":[],"usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150,"input_tokens_details":{"cached_tokens":40},"output_tokens_details":{"reasoning_tokens":25},"cache_read_input_tokens":40}}}\n\n';

    const json = await convertResponsesStreamToJson(sseBody(raw));
    expect(json.model).toBe("gpt-5-codex");
    expect(json.usage.input_tokens_details).toEqual({ cached_tokens: 40 });
    expect(json.usage.output_tokens_details).toEqual({ reasoning_tokens: 25 });
    expect(json.usage.cache_read_input_tokens).toBe(40);
  });
});
