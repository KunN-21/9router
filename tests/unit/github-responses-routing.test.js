/**
 * Regression test for #1062:
 * GitHub Copilot's /responses endpoint only serves OpenAI (gpt/codex) models.
 * Gemini/Claude models must never be routed/escalated there, otherwise they
 * fail with a misleading 400 "does not support Responses API".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, default: proxyAwareFetch }));

import { GithubExecutor } from "../../open-sse/executors/github.js";

describe("GithubExecutor.supportsResponsesEndpoint", () => {
  const exec = new GithubExecutor();

  it("excludes Gemini models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-preview")).toBe(false);
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-low")).toBe(false);
  });

  it("excludes Claude models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("claude-sonnet-4.6")).toBe(false);
    expect(exec.supportsResponsesEndpoint("claude-opus-4.7")).toBe(false);
  });

  it("allows OpenAI/codex models on the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gpt-5.5-codex")).toBe(true);
    expect(exec.supportsResponsesEndpoint("o4-mini")).toBe(true);
    expect(exec.supportsResponsesEndpoint("gpt-4.1")).toBe(true);
  });

  it("is null-safe", () => {
    expect(exec.supportsResponsesEndpoint(undefined)).toBe(true);
    expect(exec.supportsResponsesEndpoint("")).toBe(true);
  });
});

describe("GithubExecutor.execute cached-route guard (#1062)", () => {
  it("does NOT use /responses for a Gemini model even if it was wrongly cached as codex", async () => {
    const exec = new GithubExecutor();
    // Simulate a prior misclassification that cached the Gemini model.
    exec.knownCodexModels.add("gemini-3.1-pro-preview");

    const respSpy = vi
      .spyOn(exec, "executeWithResponsesEndpoint")
      .mockResolvedValue({ via: "responses" });
    // Short-circuit the /chat/completions path (BaseExecutor.execute).
    const baseSpy = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(exec)), "execute")
      .mockResolvedValue({ response: { status: 200 }, via: "chat" });

    const result = await exec.execute({ model: "gemini-3.1-pro-preview", body: { messages: [] }, log: null });

    expect(respSpy).not.toHaveBeenCalled();
    expect(baseSpy).toHaveBeenCalled();
    expect(result.via).toBe("chat");
  });
});


describe("GithubExecutor /responses strips unsupported params (#4706)", () => {
  beforeEach(() => proxyAwareFetch.mockReset());
  const reject = () => proxyAwareFetch.mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" });
  const call = (model, body) => new GithubExecutor().executeWithResponsesEndpoint({ model, body, stream: false, credentials: { copilotToken: "ghs_test_token" }, log: null });
  const outbound = () => JSON.parse(proxyAwareFetch.mock.calls.at(-1)[1].body);

  it.each(["gpt-5.4", "gpt-5.4-mini", "gpt-6.1-sol"])("sends no temperature to /responses for %s", async (model) => {
    reject();
    const callerBody = { messages: [{ role: "user", content: "hi" }], temperature: 0.7, top_p: 1 };
    const result = await call(model, callerBody);
    const [url, options] = proxyAwareFetch.mock.calls.at(-1);
    const sent = JSON.parse(options.body);
    expect(result.response.status).toBe(503);
    expect(String(url)).toContain("/responses");
    expect(sent).toMatchObject({ model, top_p: 1 });
    expect(sent.temperature).toBeUndefined();
    expect(callerBody.temperature).toBe(0.7);
  });

  it("keeps temperature on /responses for models that still accept it", async () => {
    reject();
    await call("gpt-5.3-codex", { messages: [{ role: "user", content: "hi" }], temperature: 0.7 });
    expect(outbound().temperature).toBe(0.7);
  });

  it("keeps stripping temperature on the /chat/completions path", () => {
    const out = new GithubExecutor().transformRequest("gpt-5.4", { temperature: 0.7, top_p: 1 }, false, {});
    expect(out).toEqual({ top_p: 1 });
  });

  it("escalates from the native chat path, then serves the cached route", async () => {
    const exec = new GithubExecutor();
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(exec));
    const baseSpy = vi.spyOn(proto, "execute").mockClear().mockResolvedValue({ response: { status: 400, clone: () => ({ text: async () => "not accessible via the /chat/completions endpoint" }) } });
    const responsesSpy = vi.spyOn(exec, "executeWithResponsesEndpoint").mockResolvedValue({ via: "responses" });

    expect((await exec.execute({ model: "gpt-5.4", body: { messages: [] }, log: null })).via).toBe("responses");
    expect(baseSpy).toHaveBeenCalledTimes(1);
    expect((await exec.execute({ model: "gpt-5.4", body: { messages: [] }, log: null })).via).toBe("responses");
    expect(baseSpy).toHaveBeenCalledTimes(1);
    expect(responsesSpy).toHaveBeenCalledTimes(2);
    baseSpy.mockRestore();
    responsesSpy.mockRestore();
  });
});
