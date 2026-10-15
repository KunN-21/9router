import { describe, expect, it, vi, beforeEach } from "vitest";
// Note: beforeEach imported for parity with opencode-go-transport-routing.test.js;
// per-suite hooks below use it to clear the synthetic executor mock.
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getModelSupportedFormats, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { resolveUpstreamRoute } from "../../open-sse/handlers/chatCore/upstreamRoute.js";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (mimeType, base64) => `data:${mimeType};base64,${base64}`,
  parseDataUri: (url) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    return m ? { mimeType: m[1], base64: m[2] } : null;
  },
  fetchImageAsBase64: async () => null,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const BASE = "https://opencode.ai/zen/go/v1";
const ENDPOINTS = {
  openai: `${BASE}/chat/completions`,
  claude: `${BASE}/messages`,
  "openai-responses": `${BASE}/responses`,
};

// Minimal non-stream provider JSON per target format — mirrors
// opencode-go-transport-routing.test.js so the claude lane answers a Messages
// shape (an OpenAI shape here would fail response translation, not routing).
const RESPONSE_BY_FORMAT = {
  claude: {
    id: "msg_1", type: "message", role: "assistant", model: "test",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  openai: {
    id: "chatcmpl-1", object: "chat.completion", model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
};

async function route(model, sourceFormat) {
  executeMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify(RESPONSE_BY_FORMAT[sourceFormat] || RESPONSE_BY_FORMAT.openai), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    url: ENDPOINTS[sourceFormat] || ENDPOINTS.openai,
    headers: {},
    transformedBody: null,
  });

  const credentials = { apiKey: "test-key", providerSpecificData: {} };
  const result = await handleChatCore({
    body: {
      model: `opencode-go/${model}`,
      stream: false,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    },
    modelInfo: { provider: "opencode-go", model },
    credentials,
    connectionId: "ocg-haiku55-route-test",
    sourceFormatOverride: sourceFormat,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });

  const { credentials: creds } = executeMock.mock.calls.at(-1)[0];
  return { result, runtimeTransport: creds.runtimeTransport ?? null };
}

const MODEL = "claude-haiku-5-5";
describe("OpenCode Go claude-haiku-5-5 core routing", () => {
  it("declares Messages route and exact capabilities without search", () => {
    // RED: HEAD cho targetFormat null (family /^claude-/ chỉ khai supportedFormats, không targetFormat).
    expect(getModelTargetFormat("opencode-go", MODEL)).toBe("claude");
    // Control (đã xanh ở HEAD): family fallback đã trả ["claude"]; giữ để khóa không rơi về openai.
    expect(getModelSupportedFormats("opencode-go", MODEL)).toEqual(["claude"]);
    // RED: HEAD pattern "*claude*haiku*" (capabilities.js:323) cho claude-budget + search true.
    const caps = getCapabilitiesForModel("opencode-go", MODEL);
    expect(caps.thinkingFormat).toBe("claude-adaptive");
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(128000);
    // Bằng chứng override exact thắng pattern broad (pattern Haiku đặt search: true).
    // Không port search từ PR; chỉ assert false.
    expect(caps.search).toBe(false);
  });
  it("keeps adaptive thinking for this exact model only", () => {
    const b = { model: MODEL, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "hi" }] };
    normalizeClaudePassthrough(b, MODEL);
    expect(b.thinking.type).toBe("adaptive");
    // Negative control: Haiku khác vẫn bị hạ xuống budget — carve-out không broad.
    const other = { model: "claude-haiku-4-5", thinking: { type: "adaptive" }, messages: [{ role: "user", content: "hi" }] };
    normalizeClaudePassthrough(other, "claude-haiku-4-5");
    expect(other.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });
  it("strips context_management only for opencode-go", () => {
    const ocg = { context_management: { edits: [] }, messages: [{ role: "user", content: "hi" }] };
    prepareClaudeRequest(ocg, "opencode-go");
    expect(ocg.context_management).toBeUndefined();
    const ag = { context_management: { edits: [] }, messages: [{ role: "user", content: "hi" }] };
    prepareClaudeRequest(ag, "antigravity");
    expect(ag.context_management).toBeDefined();
    const cx = { context_management: { edits: [] }, messages: [{ role: "user", content: "hi" }] };
    prepareClaudeRequest(cx, "codex");
    expect(cx.context_management).toBeDefined();
  });
  it("routes claude-format client to /messages via resolveUpstreamRoute", () => {
    // Control (xanh cả trước/sau): family fallback đã cho supported ["claude"] nên
    // sourceTransport khớp; khóa targetFormat/target endpoint sau khi registry append.
    const { targetFormat, transport } = resolveUpstreamRoute({
      provider: "opencode-go", alias: "opencode-go", model: MODEL,
      sourceFormat: "claude", credentials: {},
    });
    expect(targetFormat).toBe("claude");
    expect(transport?.baseUrl).toBe("https://opencode.ai/zen/go/v1/messages");
  });
});

describe("OpenCode Go claude-haiku-5-5 handleChatCore routing proof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes claude-format client to /messages through real handleChatCore", async () => {
    // Synthetic executor/mock only — no provider calls. Asserts the exact field
    // DefaultExecutor.buildUrl/buildHeaders reads (credentials.runtimeTransport).
    const { result, runtimeTransport } = await route(MODEL, "claude");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS.claude);
  });
});
