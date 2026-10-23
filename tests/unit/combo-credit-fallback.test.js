import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

describe("combo credit error fallback", () => {
  // A 400 that matches no rule is request-scoped (context overflow, malformed
  // body, unsupported parameter): the credential is healthy, so combo rotation
  // advances to the next member instead of returning the error. Credit wording
  // still matches its text rule and advances with a cooldown. Only permanent
  // errors stop the rotation (see the unknown-model case below).
  it.each([
    ["You have insufficient credits to make this request.", true],
    ["Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", true],
    ["Bad request", true],
  ])("advances past a 400 response: %s", async (message, continueRouting) => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const failure = Response.json({ error: { message } }, { status: 400 });
    const success = Response.json({ choices: [{ message: { content: "Hello" } }] });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success);

    const response = await handleComboChat({
      body,
      models,
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback",
      comboStrategy: "fallback",
    });

    expect(response).toBe(continueRouting ? success : failure);
    expect(handleSingleModel.mock.calls.map(args => args[1])).toEqual(
      continueRouting ? models : models.slice(0, 1)
    );
  });

  it("does not fall back for permanent unknown-model errors", async () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const failure = Response.json({ error: { message: "Model unknown-model is not supported" } }, { status: 400 });
    const success = Response.json({ choices: [{ message: { content: "Hello" } }] });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success);

    const response = await handleComboChat({
      body,
      models,
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback",
      comboStrategy: "fallback",
    });

    expect(response).toBe(failure);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls.map(args => args[1])).toEqual(models.slice(0, 1));
  });

  it("stops and does not attempt next model when signal is aborted before next attempt", async () => {
    const controller = new AbortController();
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const failure = Response.json({ error: { message: "You have insufficient credits to make this request." } }, { status: 400 });
    const success = Response.json({ choices: [{ message: { content: "Hello" } }] });
    const handleSingleModel = vi.fn()
      .mockImplementationOnce(async () => {
        controller.abort(new Error("Request aborted"));
        return failure;
      })
      .mockResolvedValueOnce(success);

    const response = await handleComboChat({
      body,
      models,
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback",
      comboStrategy: "fallback",
      signal: controller.signal,
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(499);
  });

  it("does not fall back after accepted stream content", async () => {
    const encoder = new TextEncoder();
    const contentStream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first model partial"}}]}\n\n'));
        c.close();
      },
    });
    const acceptedResponse = new Response(contentStream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const fallbackResponse = Response.json({ choices: [{ message: { content: "second model" } }] });

    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(acceptedResponse)
      .mockResolvedValueOnce(fallbackResponse);

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"],
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });
});
