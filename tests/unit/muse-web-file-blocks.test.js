// The muse.ai Hatch agent has no client-tool protocol — asked to call a tool it
// narrates the call inside Meta's cloud VM instead. It DOES emit marked file
// blocks on request, so the contract is file-shaped and 9Router turns each block
// into a write_file tool_call that the CLIENT executes on the user's machine.
// These tests pin that conversion, including the path-traversal guard.
//
// The marked form (=== FILE: path === / === END ===) is the supported one: the
// page's innerText strips markdown fences, and an unterminated block swallowed
// whatever prose followed it.
import { describe, expect, it } from "vitest";

import {
  buildFileBlockContract,
  buildToolCallsFromReply,
  extractFileBlocks,
  extractShellCommands,
  hasFileBlocks,
} from "../../open-sse/executors/muse-web/fileBlocks.js";

const block = (path, body) => `=== FILE: ${path} ===\n${body}\n=== END ===`;

describe("extractFileBlocks", () => {
  it("pulls one marked file out of a reply", () => {
    const reply = `Here you go.\n\n${block("hello.py", "print('hi')")}\n`;
    expect(extractFileBlocks(reply).files).toEqual([{ path: "hello.py", content: "print('hi')\n" }]);
  });

  it("pulls several files in order and keeps prose as remainder", () => {
    const reply = ["Two files:", block("a.js", "const a = 1;"), "and one more", block("src/b.js", "const b = 2;")].join("\n");
    const { files, remainder } = extractFileBlocks(reply);
    expect(files.map((f) => f.path)).toEqual(["a.js", "src/b.js"]);
    expect(remainder).toContain("Two files:");
    expect(remainder).toContain("and one more");
  });

  it("bounds the body at === END === and leaves following prose alone", () => {
    const reply = `${block("a.js", "code here")}\nThat is all.`;
    const { files, remainder } = extractFileBlocks(reply);
    expect(files[0].content).toBe("code here\n");
    expect(remainder).toContain("That is all.");
    expect(remainder).not.toContain("code here");
  });

  it("keeps the last body when a path repeats", () => {
    const reply = `${block("x.js", "old")}\n${block("x.js", "new")}`;
    expect(extractFileBlocks(reply).files).toEqual([{ path: "x.js", content: "new\n" }]);
  });

  it("still accepts a markdown fenced block from a faithful client", () => {
    const reply = "```file:hello.py\nprint('hi')\n```";
    expect(extractFileBlocks(reply).files).toEqual([{ path: "hello.py", content: "print('hi')\n" }]);
  });

  it("accepts a bare info-string block (fences stripped by innerText)", () => {
    const reply = 'file:hello.py\nprint("hello from muse")';
    expect(extractFileBlocks(reply).files).toEqual([
      { path: "hello.py", content: 'print("hello from muse")\n' },
    ]);
  });

  it("normalises CRLF to LF", () => {
    const reply = "=== FILE: a.txt ===\r\none\r\ntwo\r\n=== END ===";
    expect(extractFileBlocks(reply).files[0].content).toBe("one\ntwo\n");
  });

  it("rejects absolute, parent-relative and control-character paths", () => {
    for (const bad of ["/etc/passwd", "C:/Windows/x", "../../secrets", "a/../../b", "bad\u0000name"]) {
      expect(extractFileBlocks(block(bad, "x")).files, bad).toEqual([]);
    }
  });

  it("does not treat a CMD block as a file", () => {
    const reply = "=== CMD ===\nnpm test\n=== END ===";
    expect(extractFileBlocks(reply).files).toEqual([]);
  });

  it("returns nothing for a reply without blocks", () => {
    expect(extractFileBlocks("just prose").files).toEqual([]);
    expect(hasFileBlocks("just prose")).toBe(false);
  });

  it("is safe on empty and non-string input", () => {
    expect(extractFileBlocks("").files).toEqual([]);
    expect(extractFileBlocks(null).files).toEqual([]);
    expect(extractFileBlocks(undefined).files).toEqual([]);
  });
});

describe("extractShellCommands", () => {
  it("collects CMD blocks in order", () => {
    const reply = "=== CMD ===\nnpm test\n=== END ===\nthen\n=== CMD ===\nnode x.js\n=== END ===";
    expect(extractShellCommands(reply)).toEqual(["npm test", "node x.js"]);
  });

  it("returns an empty list when there are none", () => {
    expect(extractShellCommands("no commands")).toEqual([]);
  });
});

describe("buildToolCallsFromReply", () => {
  it("returns null toolCalls for a pure-prose reply", () => {
    const out = buildToolCallsFromReply("I would write a file.");
    expect(out.toolCalls).toBeNull();
    expect(out.content).toBe("I would write a file.");
  });

  it("turns each file into a write_file call with the file JSON as arguments", () => {
    const out = buildToolCallsFromReply(`${block("a.js", "const a = 1;")}\nDone.`);
    expect(out.toolCalls).toHaveLength(1);
    const call = out.toolCalls[0];
    expect(call.type).toBe("function");
    expect(call.function.name).toBe("write_file");
    expect(JSON.parse(call.function.arguments)).toEqual({ path: "a.js", content: "const a = 1;\n" });
    expect(call.id).toMatch(/^muw-\d+-0$/);
    expect(out.content).toBe("Done.");
  });

  it("gives every call a distinct id", () => {
    const out = buildToolCallsFromReply([block("a", "1"), block("b", "2"), block("c", "3")].join("\n"));
    expect(new Set(out.toolCalls.map((c) => c.id)).size).toBe(3);
  });

  it("only emits run_command when commands are allowed", () => {
    const reply = `${block("a.js", "1")}\n=== CMD ===\nnpm test\n=== END ===`;
    expect(buildToolCallsFromReply(reply).toolCalls.map((c) => c.function.name)).toEqual(["write_file"]);
    expect(
      buildToolCallsFromReply(reply, { allowCommands: true }).toolCalls.map((c) => c.function.name)
    ).toEqual(["write_file", "run_command"]);
  });

  it("caps the number of calls", () => {
    const reply = Array.from({ length: 10 }, (_, i) => block("f" + i, "x")).join("\n");
    expect(buildToolCallsFromReply(reply, { maxCalls: 3 }).toolCalls).toHaveLength(3);
  });

  it("discards the agent's own claim that it ran something", () => {
    // Hatch's built-in tools run in Meta's VM; only the client's run is real.
    const reply = `Created hello.py and ran it.\n${block("hello.py", "print('hi')")}\nOutput: hi`;
    expect(buildToolCallsFromReply(reply).toolCalls.map((c) => c.function.name)).toEqual(["write_file"]);
  });
});

describe("buildFileBlockContract", () => {
  it("shows the exact marked form, including the END terminator", () => {
    const text = buildFileBlockContract();
    expect(text).toContain("=== FILE: src/example.js ===");
    expect(text).toContain("=== END ===");
    expect(text).toContain("write_file");
    expect(text).toContain("Never absolute");
  });

  it("mentions CMD blocks only when commands are allowed", () => {
    expect(buildFileBlockContract()).not.toContain("=== CMD ===");
    expect(buildFileBlockContract({ allowCommands: true })).toContain("=== CMD ===");
  });

  it("round-trips through the parser", () => {
    const reply = "=== FILE: src/example.js ===\nconsole.log('hi');\n=== END ===";
    expect(extractFileBlocks(reply).files).toEqual([
      { path: "src/example.js", content: "console.log('hi');\n" },
    ]);
  });
});
