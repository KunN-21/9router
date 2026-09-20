// Tests for Gemini-family RTK + Headroom support (gemini / gemini-cli / vertex / antigravity)
// Pattern mirrors tests/unit/rtkKiro.test.js and the Kiro block in tests/unit/headroom.test.js.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

const nativeFetch = global.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = nativeFetch;
});

function bigBuildOutput() {
  return [
    "npm warn deprecated har-validator@5.1.5: this library is no longer supported",
    "npm warn deprecated uuid@3.4.0: uuid@10 and below is no longer supported",
    "npm warn deprecated request@2.88.2: request has been deprecated",
    "npm warn deprecated inflight@1.0.6: This module is not supported",
    "npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported",
    "npm warn deprecated rimraf@2.7.1: Rimraf versions prior to v4 are no longer supported",
    "",
    "added 47 packages, and audited 48 packages in 13s",
    "",
    "3 packages are looking for funding",
    "  run `npm fund` for details",
    "",
    "4 vulnerabilities (2 moderate, 2 critical)",
  ].join("\n");
}

describe("Gemini format RTK support", () => {
  it("compresses functionResponse.result in body.contents", () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "Install express" }] },
        {
          role: "user",
          parts: [{ functionResponse: { id: "call_1", name: "read", response: { result: bigBuildOutput() } } }],
        },
      ],
    };

    const stats = compressMessages(body, true);

    expect(stats).not.toBeNull();
    expect(stats.bytesBefore).toBeGreaterThan(500);
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect(stats.hits.length).toBe(1);
    expect(stats.hits[0].shape).toBe("gemini-function-response");
    expect(body.contents[1].parts[0].functionResponse.response.result.length).toBeLessThan(bigBuildOutput().length);
  });

  it("compresses Antigravity wrapper body.request.contents in place", () => {
    const body = {
      request: {
        contents: [
          {
            role: "user",
            parts: [{ functionResponse: { id: "call_1", name: "read", response: { result: bigBuildOutput() } } }],
          },
        ],
      },
    };

    const stats = compressMessages(body, true);

    expect(stats).not.toBeNull();
    expect(stats.hits.length).toBe(1);
    expect(body.request.contents[0].parts[0].functionResponse.response.result.length).toBeLessThan(bigBuildOutput().length);
  });

  it("skips isError results and preserves functionCall args + thoughtSignature", () => {
    const args = { path: "a.js", big: "x".repeat(600) };
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { functionResponse: { id: "e1", name: "read", response: { isError: true, result: bigBuildOutput() } } },
          ],
        },
        {
          role: "model",
          parts: [{ thoughtSignature: "sig123", functionCall: { id: "c1", name: "read", args } }],
        },
      ],
    };
    const before = structuredClone(body);

    const stats = compressMessages(body, true);

    expect(stats).not.toBeNull();
    expect(stats.hits.length).toBe(0);
    expect(body).toEqual(before);
  });
});

describe("Gemini format Headroom support", () => {
  it("projects contents to proxy and copies compressed text back, preserving signatures", async () => {
    const toolOutput = `long tool output ${"with padding ".repeat(120)}`;
    const body = {
      request: {
        systemInstruction: { parts: [{ text: `base instruction ${"with padding ".repeat(60)}` }] },
        contents: [
          { role: "user", parts: [{ text: `earlier user ${"with padding ".repeat(60)}` }] },
          {
            role: "model",
            parts: [{ thoughtSignature: "sig123", functionCall: { id: "c1", name: "read", args: { path: "a.js" } } }],
          },
          {
            role: "user",
            parts: [{ functionResponse: { id: "call_1", name: "read", response: { result: toolOutput } } }],
          },
        ],
      },
    };

    let requestPayload;
    global.fetch = vi.fn(async (url, opts) => {
      requestPayload = JSON.parse(opts.body);
      const compressed = requestPayload.messages.map((m) => ({ ...m, content: `compressed ${m.role}` }));
      return new Response(
        JSON.stringify({ messages: compressed, tokens_before: 1000, tokens_after: 100, tokens_saved: 900 }),
        { status: 200 }
      );
    });

    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "gemini-3.8-flash",
      format: "antigravity",
    });

    expect(stats.tokens_saved).toBe(900);
    // system + text + tool projected; signature/functionCall-only parts excluded
    expect(requestPayload.messages).toEqual([
      { role: "system", content: expect.any(String) },
      { role: "user", content: expect.any(String) },
      { role: "tool", content: expect.any(String), tool_call_id: "call_1" },
    ]);
    expect(body.request.systemInstruction.parts[0].text).toBe("compressed system");
    expect(body.request.contents[0].parts[0].text).toBe("compressed user");
    expect(body.request.contents[2].parts[0].functionResponse.response.result).toBe("compressed tool");
    // routing identity untouched
    expect(body.request.contents[1].parts[0].thoughtSignature).toBe("sig123");
    expect(body.request.contents[1].parts[0].functionCall.args).toEqual({ path: "a.js" });
  });

  it("functionResponse isError skips before fetch", async () => {
    global.fetch = vi.fn();
    const body = {
      contents: [
        {
          role: "user",
          parts: [{ functionResponse: { id: "e1", name: "read", response: { isError: true, result: "failed" } } }],
        },
      ],
    };
    const diag = {};
    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "gemini-3.8-flash",
      format: "gemini",
      diagnostics: diag,
    });
    expect(stats).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(diag.reason).toMatch(/error tool result/);
  });

  it("fails open when proxy output does not preserve message order", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ role: "assistant", content: "x".repeat(200) }],
      tokens_before: 1000, tokens_after: 10, tokens_saved: 990,
    }), { status: 200 }));
    const body = {
      contents: [
        { role: "user", parts: [{ text: `original payload ${"with padding ".repeat(60)}` }] },
      ],
    };
    const original = structuredClone(body);
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "gemini-3.8-flash",
      format: "gemini",
      diagnostics,
    });

    expect(stats).toBeNull();
    expect(body).toEqual(original);
    expect(diagnostics.reason).toBe("proxy response did not preserve Gemini message order");
  });
});
