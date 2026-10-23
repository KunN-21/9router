import { describe, it, expect, vi, beforeEach } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";

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
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("handleChatCore Headroom diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8787"), { code: "ECONNREFUSED" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("logs why Headroom was skipped on chat completions", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(log.warn).toHaveBeenCalledWith(
      "HEADROOM",
      expect.stringContaining("skipped: request failed")
    );
    expect(log.warn).toHaveBeenCalledWith(
      "HEADROOM",
      expect.stringContaining("ECONNREFUSED")
    );
    expect(log.warn).toHaveBeenCalledWith(
      "HEADROOM",
      expect.stringContaining("http://localhost:8787/v1/compress")
    );
  });

  it("scrubs credentials and query strings from Headroom fetch errors", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    global.fetch = vi.fn(async () => {
      throw new Error("failed to fetch https://user:secret@example.com:8787/proxy/v1/compress?token=abc123");
    });

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "https://user:secret@example.com:8787/proxy?token=abc123",
      headroomCompressUserMessages: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    const logs = JSON.stringify(log.warn.mock.calls);
    expect(logs).toContain("https://example.com:8787/proxy/v1/compress");
    expect(logs).not.toContain("user");
    expect(logs).not.toContain("secret");
    expect(logs).not.toContain("abc123");
  });

  it("masks credentials and query strings in Headroom endpoint diagnostics", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "https://user:secret@example.com:8787/proxy?token=abc123",
      headroomCompressUserMessages: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    const logs = JSON.stringify(log.warn.mock.calls);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://user:secret@example.com:8787/proxy/v1/compress?token=abc123",
      expect.any(Object)
    );
    expect(logs).toContain("https://example.com:8787/proxy/v1/compress");
    expect(logs).not.toContain("user");
    expect(logs).not.toContain("secret");
    expect(logs).not.toContain("abc123");
  });

  it.each([["openai", "gpt-4o"], ["commandcode", "test-model"]])("sends Headroom-compressed messages to the %s executor", async (provider, model) => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const original = "very large context that should be replaced";
    const compressed = "compressed context";

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          messages: [{ role: "user", content: compressed }],
          tokens_before: 100,
          tokens_after: 10,
          tokens_saved: 90,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await handleChatCore({
      body: { model, stream: false, messages: [{ role: "user", content: original }] },
      modelInfo: { provider, model },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining(provider === "commandcode"
        ? { params: expect.objectContaining({ messages: [{ role: "user", content: [{ type: "text", text: compressed }] }] }) }
        : { messages: [{ role: "user", content: compressed }] }),
    }));
    expect(JSON.stringify(executeMock.mock.calls[0][0].body)).not.toContain(original);
    expect(log.info).toHaveBeenCalledWith("HEADROOM", expect.stringContaining("reported token delta=90 before=100 after=10"));
    expect(log.info).toHaveBeenCalledWith("HEADROOM", expect.stringContaining("body="));
    expect(log.info).toHaveBeenCalledWith("HEADROOM", expect.stringContaining("messages="));

    const logs = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logs).not.toContain("saved");
    expect(logs).not.toContain(original);
  });

  it("warns when Headroom reports savings but messages barely shrink", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const original = "x".repeat(1000);
    const nearlySame = "x".repeat(990);

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          messages: [{ role: "user", content: nearlySame }],
          tokens_before: 1000,
          tokens_after: 100,
          tokens_saved: 900,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: original }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    // Either the pre-commit skip diagnostic or the post-hoc size warning — both
    // mean the original payload was kept.
    expect(log.warn).toHaveBeenCalledWith(
      "HEADROOM",
      expect.stringMatching(/phantom savings|shrank <5%/)
    );
  });

  it("bypasses token savers when requested by the client", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const pxpipeTransform = vi.fn();
    const messages = [{ role: "user", content: "Write polished prose." }];

    global.fetch = vi.fn(async (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    });

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: true,
      rtkEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
      pxpipeEnabled: true,
      pxpipeTransform,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: {
          accept: "application/json",
          "x-9router-token-saver": "off",
        },
      },
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(pxpipeTransform).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        messages: [{ role: "user", content: "Write polished prose." }],
      }),
    }));
  });
  it.each(["off", "OFF"])("pxpipe honors token-saver header %s on claude body above threshold", async (headerValue) => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const onPxpipeEvent = vi.fn();
    const transformedBody = { model: "claude-3-5-sonnet", stream: false, max_tokens: 100, system: "base", messages: [{ role: "user", content: "PXPIPE_SENTINEL" }] };
    const pxpipeTransform = vi.fn(async () => ({
      applied: true,
      reason: "applied",
      body: new TextEncoder().encode(JSON.stringify(transformedBody)),
      info: { compressedChars: 25000, imageCount: 1, imageBytes: 1000, imagePixels: 750000 },
      cache: { ownsCacheControl: true },
    }));

    await handleChatCore({
      body: {
        model: "claude-3-5-sonnet",
        stream: false,
        max_tokens: 100,
        system: "base",
        messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(30000) }] }],
      },
      sourceFormatOverride: FORMATS.CLAUDE,
      modelInfo: { provider: "anthropic", model: "claude-3-5-sonnet" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      pxpipeEnabled: true,
      pxpipeMinChars: 1000,
      pxpipeTransform,
      onPxpipeEvent,
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: {},
        headers: {
          accept: "application/json",
          "user-agent": "claude-code",
          "x-9router-token-saver": headerValue,
        },
      },
    });

    expect(pxpipeTransform).not.toHaveBeenCalled();
    expect(onPxpipeEvent).toHaveBeenCalledWith(expect.objectContaining({
      applied: false,
      reason: "disabled",
    }));
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        system: "base",
        messages: [expect.objectContaining({
          content: [expect.objectContaining({ text: expect.stringContaining("xxxxx") })],
        })],
      }),
    }));
  });

  it("pxpipe applies transform when no opt-out header is present", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const onPxpipeEvent = vi.fn();
    const transformedBody = { model: "claude-3-5-sonnet", stream: false, max_tokens: 100, system: "base", messages: [{ role: "user", content: [{ type: "text", text: "PXPIPE_SENTINEL" }] }] };
    const pxpipeTransform = vi.fn(async () => ({
      applied: true,
      reason: "applied",
      body: new TextEncoder().encode(JSON.stringify(transformedBody)),
      info: { compressedChars: 25000, imageCount: 1, imageBytes: 1000, imagePixels: 750000 },
      cache: { ownsCacheControl: true },
    }));

    await handleChatCore({
      body: {
        model: "claude-3-5-sonnet",
        stream: false,
        max_tokens: 100,
        system: "base",
        messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(30000) }] }],
      },
      sourceFormatOverride: FORMATS.CLAUDE,
      modelInfo: { provider: "anthropic", model: "claude-3-5-sonnet" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      pxpipeEnabled: true,
      pxpipeMinChars: 1000,
      pxpipeTransform,
      onPxpipeEvent,
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: {},
        headers: {
          accept: "application/json",
          "user-agent": "claude-code",
        },
      },
    });

    expect(pxpipeTransform).toHaveBeenCalledTimes(1);
    expect(onPxpipeEvent).toHaveBeenCalledWith(expect.objectContaining({
      applied: true,
      reason: "applied",
    }));
    const sentBody = executeMock.mock.calls[0][0].body;
    expect(JSON.stringify(sentBody)).toContain("PXPIPE_SENTINEL");
    expect(JSON.stringify(sentBody)).not.toContain("x".repeat(1000));
  });
});
