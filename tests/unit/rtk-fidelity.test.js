import { describe, it, expect, vi, afterEach } from "vitest";
import { neverWorse, estimateTokens } from "../../open-sse/rtk/guard.js";
import { readNumbered } from "../../open-sse/rtk/filters/readNumbered.js";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

const nativeFetch = global.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = nativeFetch;
});

describe("UTF-8 byte guard (neverWorse & estimateTokens)", () => {
  it("neverWorse rejects filtered string when UTF-8 bytes grow even if character length shrinks", () => {
    // 'abcd' is 4 chars, 4 UTF-8 bytes.
    // 'ếế' is 2 chars, 6 UTF-8 bytes (each 'ế' is 3 bytes: 0xE1 0xBA 0xBF).
    expect(neverWorse("abcd", "ếế")).toBe("abcd");
    expect(neverWorse("ếếếế", "ếế")).toBe("ếế");
    expect(neverWorse("fixture", "")).toBe("fixture");
  });

  it("estimateTokens accounts for native UTF-8 bytes", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4 bytes / 4 = 1
    expect(estimateTokens("ếế")).toBe(2);   // 6 bytes / 4 = 2 (ceil)
  });

  it("readNumbered standalone filter truncates file dump without losing non-truncated lines", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `${i + 1}|  const v${i} = ${i};`);
    const compressed = readNumbered(lines.join("\n"));
    for (const line of compressed.split("\n").filter((l) => !l.startsWith("... +"))) {
      expect(lines).toContain(line);
    }
    expect(compressed).toContain("lines truncated");
  });
});

describe("Native UTF-8 byte accounting in stats", () => {
  it("computes bytesBefore and bytesAfter using native UTF-8 bytes for multibyte text", () => {
    // Construct a diff that contains multibyte Vietnamese characters
    const diffLines = [
      "diff --git a/file.txt b/file.txt",
      "index 123..456 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,5 +1,150 @@",
    ];
    for (let i = 0; i < 150; i++) {
      diffLines.push(`+Dòng tiếng Việt thứ ${i}: Tiếng Việt có dấu ế, à, ỗ, ứ, đ`);
    }
    const diffText = diffLines.join("\n");
    const expectedBytes = Buffer.byteLength(diffText, "utf8");

    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_git", type: "function", function: { name: "bash" } }],
        },
        {
          role: "tool",
          tool_call_id: "call_git",
          content: diffText,
        },
      ],
    };

    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    // Char length != UTF-8 byte length for Vietnamese text
    expect(diffText.length).not.toBe(expectedBytes);
    expect(stats.bytesBefore).toBe(expectedBytes);
    expect(stats.bytesAfter).toBe(Buffer.byteLength(body.messages[1].content, "utf8"));
  });
});

describe("Error preservation across all formats", () => {
  const longOutput = Array.from({ length: 100 }, (_, i) => `npm warn line ${i}`).join("\n");

  it("preserves Claude tool_result with is_error: true, status: 'error', or isError: true", () => {
    for (const flag of [{ is_error: true }, { status: "error" }, { isError: true }]) {
      const body = {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: longOutput,
                ...flag,
              },
            ],
          },
        ],
      };
      const stats = compressMessages(body, true);
      expect(stats.hits.length).toBe(0);
      expect(body.messages[1].content[0].content).toBe(longOutput);
    }
  });

  it("preserves OpenAI tool message with is_error: true, status: 'error', or isError: true", () => {
    for (const flag of [{ is_error: true }, { status: "error" }, { isError: true }]) {
      const body = {
        messages: [
          {
            role: "assistant",
            tool_calls: [{ id: "c1", type: "function", function: { name: "bash" } }],
          },
          {
            role: "tool",
            tool_call_id: "c1",
            content: longOutput,
            ...flag,
          },
        ],
      };
      const stats = compressMessages(body, true);
      expect(stats.hits.length).toBe(0);
      expect(body.messages[1].content).toBe(longOutput);
    }
  });

  it("preserves OpenAI Responses function_call_output with is_error: true, status: 'error', or isError: true", () => {
    for (const flag of [{ is_error: true }, { status: "error" }, { isError: true }]) {
      const body = {
        input: [
          {
            type: "function_call",
            call_id: "r1",
            name: "bash",
          },
          {
            type: "function_call_output",
            call_id: "r1",
            output: longOutput,
            ...flag,
          },
        ],
      };
      const stats = compressMessages(body, true);
      expect(stats.hits.length).toBe(0);
      expect(body.input[1].output).toBe(longOutput);
    }
  });

  it("preserves Kiro toolResults with status: 'error', is_error: true, or isError: true", () => {
    for (const flag of [{ status: "error" }, { is_error: true }, { isError: true }]) {
      const body = {
        conversationState: {
          currentMessage: {
            userInputMessage: {
              content: "run",
              userInputMessageContext: {
                toolResults: [
                  {
                    toolUseId: "k1",
                    content: [{ text: longOutput }],
                    ...flag,
                  },
                ],
              },
            },
          },
        },
      };
      const stats = compressMessages(body, true);
      expect(stats.hits.length).toBe(0);
      expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].content[0].text).toBe(longOutput);
    }
  });

  it("preserves Gemini functionResponse with isError: true, status: 'error', or is_error: true", () => {
    for (const flag of [{ isError: true }, { status: "error" }, { is_error: true }]) {
      const body = {
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "g1",
                  name: "bash",
                  response: {
                    result: longOutput,
                    ...flag,
                  },
                },
              },
            ],
          },
        ],
      };
      const stats = compressMessages(body, true);
      expect(stats.hits.length).toBe(0);
      expect(body.contents[0].parts[0].functionResponse.response.result).toBe(longOutput);
    }
  });
});

describe("Code editing tools protection (Read, Grep, Edit, Write, patch, anchor)", () => {
  const codeContent = Array.from({ length: 60 }, (_, i) => `const var_${i} = "test line ${i}";`).join("\n");

  it.each(["Read", "Grep", "Edit", "Write", "patch", "anchor"])(
    "never compresses or transforms output from tool '%s' into log summary",
    (toolName) => {
      // Test in Claude format
      const claudeBody = {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t_code", name: toolName, input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t_code", content: codeContent }],
          },
        ],
      };
      const claudeStats = compressMessages(claudeBody, true);
      expect(claudeStats.hits.length).toBe(0);
      expect(claudeBody.messages[1].content[0].content).toBe(codeContent);

      // Test in OpenAI format
      const oaiBody = {
        messages: [
          {
            role: "assistant",
            tool_calls: [{ id: "c_code", type: "function", function: { name: toolName } }],
          },
          {
            role: "tool",
            tool_call_id: "c_code",
            name: toolName,
            content: codeContent,
          },
        ],
      };
      const oaiStats = compressMessages(oaiBody, true);
      expect(oaiStats.hits.length).toBe(0);
      expect(oaiBody.messages[1].content).toBe(codeContent);
    }
  );
});

describe("Fail-open: output from unknown tool or command", () => {
  it("leaves output untouched when tool source is unknown rather than blindly applying smartTruncate or dedupLog", () => {
    // Long text with repetitive lines that would normally trigger dedupLog or smartTruncate
    const rawOutput = [
      ...Array.from({ length: 25 }, () => "repeated random line from unidentified tool"),
      "something else in the middle",
      ...Array.from({ length: 25 }, () => "another repeated line from unknown source"),
    ].join("\n");

    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_unknown", type: "function", function: { name: "custom_unknown_tool" } }],
        },
        {
          role: "tool",
          tool_call_id: "call_unknown",
          name: "custom_unknown_tool",
          content: rawOutput,
        },
      ],
    };

    const stats = compressMessages(body, true);
    // Fail-open: should NOT compress unknown tool output with dedupLog or smartTruncate
    expect(stats.hits.length).toBe(0);
    expect(body.messages[1].content).toBe(rawOutput);
  });
});

describe("Headroom skip on protected or unknown tool result", () => {
  it("skips Headroom compression when request contains protected tool result", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t_read", name: "Read", input: { file_path: "foo.js" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t_read", content: "const x = 1;\n".repeat(50) }],
        },
      ],
    };
    const diag = {};
    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "claude-3-7-sonnet",
      format: "claude",
      diagnostics: diag,
    });

    expect(stats).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(diag.reason).toMatch(/protected|unknown/i);
  });

  it("skips Headroom compression when request contains unknown tool result", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "c_unk", type: "function", function: { name: "custom_service_tool" } }],
        },
        {
          role: "tool",
          tool_call_id: "c_unk",
          name: "custom_service_tool",
          content: "output from unknown tool ".repeat(50),
        },
      ],
    };
    const diag = {};
    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "gpt-4o",
      format: "openai",
      diagnostics: diag,
    });

    expect(stats).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(diag.reason).toMatch(/protected|unknown/i);
  });
});
