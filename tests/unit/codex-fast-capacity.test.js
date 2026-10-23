import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { claudeToResponsesRequest } from "../../open-sse/translator/request/claude-to-responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

afterEach(() => vi.restoreAllMocks());

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function streamFromChunks(texts) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const text of texts) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex fast tier and capacity handling", () => {
  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-reserve", {
      model: "gpt-reserve",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("classifies 200-SSE model capacity as account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("does not treat user output containing capacity text as fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"model_at_capacity is just text"}',
      "",
    ].join("\n")), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    expect(peek.accountFallback).toBe(false);
  });

  it("reassembles normal SSE after peeking", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("does not judge a capacity JSON half-frame split across chunks", async () => {
    const executor = new CodexExecutor();
    const full = [
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n");
    // Split right after "capacity": chunk 1 holds the full pattern but no
    // newline, so a half-frame judge would match on truncated text.
    const splitAt = full.indexOf("capacity. Please") + "capacity".length;
    const response = new Response(
      streamFromChunks([full.slice(0, splitAt), full.slice(splitAt)]),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("replays a content delta split across chunks verbatim", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const splitAt = text.indexOf('"delta":"OK"') + '"delta":"O'.length;
    const response = new Response(
      streamFromChunks([text.slice(0, splitAt), text.slice(splitAt)]),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    expect(peek.accountFallback).toBe(false);
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("skips codex SSE peek when caller requests combo peek", async () => {
    const executor = new CodexExecutor();
    let fetchCalls = 0;
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async () => {
      fetchCalls++;
      return new Response(streamFromText([
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"OK"}',
        "",
      ].join("\n")), { status: 200, headers: new Headers({ "Content-Type": "text/event-stream" }) });
    });
    const peekSpy = vi.spyOn(executor, "_peekSseTransientError");
    const result = await executor.execute({
      model: "gpt-5.5",
      body: { model: "gpt-5.5", input: "hi" },
      stream: true,
      credentials: { accessToken: "test" },
      skipSsePeek: true,
    });
    expect(fetchCalls).toBe(1);
    expect(peekSpy).not.toHaveBeenCalled();
    await expect(result.response.text()).resolves.toContain("OK");
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });
});

describe("Direct Route Wire Bridge for Codex", () => {
  it("preserves priority through direct claudeToResponsesRequest", () => {
    const srcPayload = {
      model: "gpt-6.1-sol",
      service_tier: "priority",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };
    const translated = claudeToResponsesRequest("gpt-6.1-sol", srcPayload, true, null);
    expect(translated.service_tier).toBe("priority");
  });

  it("preserves fast through direct claudeToResponsesRequest for Codex normalization", () => {
    const srcPayload = {
      model: "gpt-6.1-sol",
      service_tier: "fast",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };
    const translated = claudeToResponsesRequest("gpt-6.1-sol", srcPayload, true, null);
    expect(translated.service_tier).toBe("fast");

    const executor = new CodexExecutor();
    const transformed = executor.transformRequest("gpt-6.1-sol", translated, true, {});
    expect(transformed.service_tier).toBe("priority");
  });

  it("preserves explicit supported and unsupported values without auto-upgrading", () => {
    for (const tier of ["standard", "flex", "scale", "custom_tier"]) {
      const srcPayload = {
        model: "gpt-6.1-sol",
        service_tier: tier,
        messages: [{ role: "user", content: "Hello" }],
      };
      const translated = claudeToResponsesRequest("gpt-6.1-sol", srcPayload, true, null);
      expect(translated.service_tier).toBe(tier);
    }
  });

  it("does not inject service_tier when key is absent", () => {
    const srcPayload = {
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };
    const translated = claudeToResponsesRequest("gpt-6.1-sol", srcPayload, true, null);
    expect(translated).not.toHaveProperty("service_tier");
    expect(translated.service_tier).toBeUndefined();
  });

  it("keeps caller request body unchanged (immutability)", () => {
    const srcPayload = {
      model: "gpt-6.1-sol",
      service_tier: "priority",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      max_tokens: 1000,
    };
    const snapshot = JSON.parse(JSON.stringify(srcPayload));
    claudeToResponsesRequest("gpt-6.1-sol", srcPayload, true, null);
    expect(srcPayload).toEqual(snapshot);
  });

  it("preserves service_tier via public translateRequest for gpt-family and muse-spark routes", () => {
    const gptPayload = {
      model: "gpt-6.1-sol",
      service_tier: "priority",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };
    const gptOut = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
      "gpt-6.1-sol",
      gptPayload,
      true,
      null
    );
    expect(gptOut.service_tier).toBe("priority");
    expect(gptOut.model).toBe("gpt-6.1-sol");

    const musePayload = {
      model: "muse-spark-1.3-contributor-free",
      service_tier: "priority",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };
    const museOut = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
      "muse-spark-1.3-contributor-free",
      musePayload,
      true,
      null
    );
    expect(museOut.service_tier).toBe("priority");
    expect(museOut.model).toBe("muse-spark-1.3-contributor-free");
  });

  it("does not inject premium or priority default on non-Codex providers", () => {
    const regularPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };
    const regularOut = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "gpt-4o",
      regularPayload,
      true,
      null,
      "openai"
    );
    expect(regularOut.service_tier).toBeUndefined();

    const autoPayload = {
      model: "gpt-4o",
      service_tier: "auto",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };
    const autoOut = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "gpt-4o",
      autoPayload,
      true,
      null,
      "openai"
    );
    expect(autoOut.service_tier).not.toBe("priority");
  });
});
