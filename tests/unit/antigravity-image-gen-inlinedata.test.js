import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const IMAGE_MODEL = "gemini-3.1-flash-image";
const REQUEST_ID =
  "agent/00000000-0000-0000-0000-000000000000/1760000000000/11111111-1111-5111-8111-111111111111/1";
const CREDENTIALS = { projectId: "project-fixture", email: "fixture@example.com", rawHeaders: {} };
const executor = new AntigravityExecutor();

function runImage(parts) {
  return executor.transformRequest(IMAGE_MODEL, {
    requestId: REQUEST_ID,
    request: { sessionId: "ag-fixture-session", contents: [{ role: "user", parts }] },
  }, false, CREDENTIALS);
}

describe("Antigravity image_gen inlineData", () => {
  it("keeps text and camelCase inlineData in input order", () => {
    const out = runImage([
      { text: "modify this" },
      { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
    ]);
    expect(out.requestType).toBe("image_gen");
    expect(out.project).toBe("project-fixture");
    expect(out.request.sessionId).toBe("antigravity:ag-fixture-session");
    expect(out.requestId).toBe(REQUEST_ID);
    expect(out.request.contents).toEqual([{
      role: "user",
      parts: [
        { text: "modify this" },
        { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
      ],
    }]);
  });

  it("normalizes nested mime_type and keeps unknown inline fields", () => {
    const out = runImage([{ inline_data: { mime_type: "image/jpeg", data: "anBn", customField: 42 } }]);
    expect(out.requestType).toBe("image_gen");
    expect(out.request.contents?.[0]?.parts).toEqual([
      { inlineData: { mimeType: "image/jpeg", data: "anBn", customField: 42 } },
    ]);
  });

  it("throws TypeError for inline data that is not a base64 string", () => {
    expect(() => runImage([{ inlineData: { mimeType: "image/png" } }])).toThrow(TypeError);
    expect(() => runImage([{ inline_data: null }])).toThrow(TypeError);
    expect(() => runImage([{ inlineData: { mimeType: "image/png", data: "" } }])).toThrow(TypeError);
    expect(() => runImage([{ inlineData: { mimeType: "image/png", data: 123 } }])).toThrow(TypeError);
    expect(() => runImage([{ inlineData: "not an object" }])).toThrow(TypeError);
  });

  it("rejects missing or non-array contents with a clear error, not a null TypeError", () => {
    expect(() => executor.transformRequest(IMAGE_MODEL, { requestId: REQUEST_ID }, false, CREDENTIALS))
      .toThrow(/contents/i);
    expect(() => executor.transformRequest(IMAGE_MODEL, { requestId: REQUEST_ID, contents: {} }, false, CREDENTIALS))
      .toThrow(/contents/i);
    expect(() => runImage([{ text: "only text" }, null])).not.toThrow();
  });

  it("falls back to top-level body.contents when the envelope has no contents array", () => {
    const out = executor.transformRequest(IMAGE_MODEL, {
      requestId: REQUEST_ID,
      request: { sessionId: "ag-fixture-session" },
      contents: [{ role: "user", parts: [{ text: "only text" }] }],
    }, false, CREDENTIALS);
    expect(out.requestType).toBe("image_gen");
    expect(out.request.sessionId).toBe("antigravity:ag-fixture-session");
    expect(out.request.contents).toEqual([{ role: "user", parts: [{ text: "only text" }] }]);
  });

  it("keeps the chat branch out of the image_gen contract", () => {
    const out = executor.transformRequest("claude-3-7-sonnet", {
      request: { contents: [{ role: "user", parts: [
        { text: "hello" },
        { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
      ] }] },
    }, false, CREDENTIALS);
    expect(out.requestType).toBeUndefined();
    expect(out.request.contents[0].parts[0]).toEqual({ text: "hello" });
  });
});
