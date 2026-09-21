import { describe, expect, it, vi } from "vitest";

// Keep the signature store in RAM only; the SQLite kv layer is not under test here.
vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({
    get: async () => null,
    set: async () => {},
    remove: async () => {},
    getAll: async () => ({}),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { translateRequest, translateResponse } = await import("../../open-sse/translator/index.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
await import("../../open-sse/translator/request/claude-to-gemini.js");
await import("../../open-sse/translator/request/openai-to-gemini.js");
await import("../../open-sse/translator/response/gemini-to-claude.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
const { storeGeminiThoughtSignature, getGeminiThoughtSignatureSync } = await import("../../open-sse/services/thoughtSignatureStore.js");

const history = () => ({
  model: "gemini-3.8-flash",
  messages: [
    { role: "assistant", content: [
      { type: "tool_use", id: "call_a", name: "Read", input: { file_path: "/fixture/a.js" } },
      { type: "tool_use", id: "call_b", name: "Read", input: { file_path: "/fixture/b.js" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_a", content: "fixture error", is_error: true },
      { type: "tool_result", tool_use_id: "call_b", content: "fixture content" },
    ] },
  ],
  tools: [{ name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } }],
});

const candidate = () => ({
  response: {
    modelVersion: "gemini-3.8-flash",
    candidates: [{ content: { parts: [
      { thoughtSignature: "fixture-signature", functionCall: { id: "call_a", name: "Read", args: { file_path: "/fixture/a.js" } } },
      { functionCall: { id: "call_b", name: "Read", args: { file_path: "/fixture/b.js" } } },
    ] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  },
});

function finalAntigravityRequest(claudeBody, model = "gemini-3.8-flash") {
  const translated = translateRequest(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, model, claudeBody, true, {});
  return new AntigravityExecutor().transformRequest(model, translated, true, { projectId: "project-fixture" });
}

describe("antigravity protocol contract", () => {
  it("(1) keeps both tool call ids/signatures and the antigravity envelope", () => {
    storeGeminiThoughtSignature("call_a", "fixture-signature", null, "gemini-3.8-flash");
    const finalBody = finalAntigravityRequest(history());
    expect(finalBody.userAgent).toBe("antigravity");
    expect(finalBody.requestType).toBe("agent");
    const parts = finalBody.request.contents.flatMap((c) => c.parts || []);
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    expect(calls.map((c) => c.id)).toEqual(["call_a", "call_b"]);
    expect(calls.every((c) => c.name === "Read")).toBe(true);
    expect(parts.filter((p) => p.functionCall && p.thoughtSignature).length).toBeGreaterThanOrEqual(1);
  });

  it("(2) preserves error tool results through the final antigravity request", () => {
    const finalBody = finalAntigravityRequest(history());
    const responses = finalBody.request.contents.flatMap((c) => c.parts || []).filter((p) => p.functionResponse);
    const errored = responses.find((p) => p.functionResponse.id === "call_a");
    expect(errored.functionResponse.response.isError).toBe(true);
  });

  it("(3) propagates tool_choice semantics to the executor boundary", () => {
    const base = { messages: [{ role: "user", content: "hi" }], tools: history().tools };
    const autoReq = finalAntigravityRequest({ ...base, tool_choice: { type: "auto" } });
    expect(autoReq.request.toolConfig.functionCallingConfig.mode).toBe("AUTO");
    const forcedReq = finalAntigravityRequest({ ...base, tool_choice: { type: "tool", name: "Read" } });
    expect(forcedReq.request.toolConfig.functionCallingConfig.mode).toBe("ANY");
    expect(forcedReq.request.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["Read"]);
    const noneReq = finalAntigravityRequest({ ...base, tool_choice: { type: "none" } });
    expect(noneReq.request.toolConfig?.functionCallingConfig?.mode === "NONE" || noneReq.request.toolConfig === undefined).toBe(true);
  });

  it("(4) direct antigravity stream response keeps distinct ids for same-name calls", () => {
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, candidate(), { toolNameMap: new Map() });
    const starts = events.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(starts.map((s) => s.content_block.id)).toEqual(["call_a", "call_b"]);
    expect(new Set(starts.map((s) => s.content_block.id)).size).toBe(2);
  });

  it("(5) non-streaming claude response keeps ids and claude message shape", () => {
    const out = translateNonStreamingResponse(candidate(), FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    expect(out.type).toBe("message");
    const tools = out.content.filter((b) => b.type === "tool_use");
    expect(tools.map((t) => t.id)).toEqual(["call_a", "call_b"]);
  });

  it("(6) absent ids fall back without colliding inside one response", () => {
    const noIds = candidate();
    delete noIds.response.candidates[0].content.parts[0].functionCall.id;
    delete noIds.response.candidates[0].content.parts[1].functionCall.id;
    const streamEvents = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, structuredClone(noIds), { toolNameMap: new Map() });
    const streamIds = streamEvents.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use").map((e) => e.content_block.id);
    expect(new Set(streamIds).size).toBe(streamIds.length);
    const nonStream = translateNonStreamingResponse(structuredClone(noIds), FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    const nonStreamIds = nonStream.content.filter((b) => b.type === "tool_use").map((t) => t.id);
    expect(new Set(nonStreamIds).size).toBe(nonStreamIds.length);
  });

  it("(7) caches thoughtSignature for function calls in non-streaming response", () => {
    const cand = candidate();
    translateNonStreamingResponse(cand, FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    expect(getGeminiThoughtSignatureSync("call_a", null, "gemini-3.8-flash")).toBe("fixture-signature");
  });
});
