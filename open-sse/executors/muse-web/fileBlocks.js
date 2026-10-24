// File-block contract for the muse.ai Hatch agent.
//
// Hatch has no client-tool protocol and ignores the shared `<tool>` shim: asked
// to call a tool it narrates the call instead ("Created hello.py and ran it"),
// because its built-in tools execute inside Meta's cloud VM, not on the user's
// machine. Verified live over three prompt variants — see the probe writeup.
//
// What it DOES obey is a plain file-block request. Ask for
// ` ```file:<path> ` fences and it emits them reliably. So the contract here is
// file-shaped rather than call-shaped: the model writes the files, and 9Router
// turns each fence into an OpenAI `write_file` tool_call that the CLIENT
// executes. That keeps execution on the user's machine, which is the whole
// point — Hatch's own "I ran it" output is a VM claim and is deliberately
// discarded.
//
// Everything here is pure text in / text out so it can be tested without a
// browser.

const FILE_FENCE_RE = /```[ \t]*file:[ \t]*([^\n`]+?)[ \t]*\r?\n([\s\S]*?)```/gi;

// muse.ai's innerText DROPS the backtick run, so a fenced block arrives as the
// bare info string on its own line followed by the body — and with no closing
// fence the body would swallow everything after it. The supported form is
// therefore a marked block, which survives the DOM intact:
//
//     === FILE: hello.py ===
//     print("hello from muse")
//     === END ===
//
// The trailing `=== END ===` is what bounds the body. It is required by the
// contract rather than guessed at, because guessing is what turned the next
// section's prose into part of the file.
const FILE_MARKER_RE =
  /^[ \t]*===[ \t]*FILE:[ \t]*([^\s=]+)[ \t]*===[ \t]*\r?\n([\s\S]*?)^[ \t]*===[ \t]*END[ \t]*===[ \t]*$/gim;

// Unbounded fallback for a reply that forgot the terminator: the block runs to
// the next `=== FILE:` marker or the end of the reply. `leaky` marks a result
// that may have absorbed trailing prose, so the caller can prefer a bounded
// parse when one exists.
const FILE_MARKER_LOOSE_RE =
  /^[ \t]*===[ \t]*FILE:[ \t]*([^\s=]+)[ \t]*===[ \t]*\r?\n([\s\S]*?)(?=^[ \t]*===[ \t]*FILE:|$(?![\s\S]))/gim;

// The bare `file:<path>` info string with no fences, as delivered by innerText.
const FILE_BARE_RE =
  /^[ \t]*file:[ \t]*([^\s`]+)[ \t]*\r?\n([\s\S]*?)(?=^[ \t]*(?:```[ \t]*)?file:|$(?![\s\S]))/gim;

/** Reject paths that would escape the workspace or name a device/FIFO. */
function isSafePath(path) {
  const p = String(path || "").trim();
  if (!p || p.length > 512) return false;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.split(/[\\/]/).includes("..")) return false;
  if (/[\x00-\x1F]/.test(p)) return false;
  return true;
}

function collect(text, re) {
  const found = [];
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    const path = match[1].trim();
    // Trailing whitespace on the last line is the model's, not the file's.
    // Normalise to exactly one trailing newline: the model's trailing blank
    // lines are noise, and a file with no final newline breaks POSIX tools.
    const content = match[2].replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s*$/, "\n");
    if (isSafePath(path)) found.push({ path, content });
  }
  return found;
}

/**
 * Extract file blocks from a Hatch reply.
 *
 * @returns {{ files: Array<{path: string, content: string}>, remainder: string }}
 *   `files` in emission order, deduplicated (a repeated path keeps the LAST
 *   body, matching how a model correction should be read). `remainder` is the
 *   reply with the blocks removed — the prose the user still wants to see.
 */
export function extractFileBlocks(text) {
  const source = typeof text === "string" ? text : "";
  if (!source) return { files: [], remainder: "" };
  const byPath = new Map();
  let consumed = source;

  // CMD blocks are consumed by extractShellCommands; strip them first so their
  // bodies are never mistaken for file content by the loose/bare passes.
  for (const re of [CMD_MARKER_RE, CMD_MARKER_LOOSE_RE]) consumed = consumed.replace(re, "");

  // Order matters: a bounded marker block wins over the loose and bare forms,
  // so a reply that terminated its blocks never has its prose captured.
  for (const re of [FILE_FENCE_RE, FILE_MARKER_RE, FILE_MARKER_LOOSE_RE, FILE_BARE_RE]) {
    for (const file of collect(consumed, re)) byPath.set(file.path, file.content);
    consumed = consumed.replace(re, "");
  }

  const remainder = consumed.replace(/\n{3,}/g, "\n\n").trim();
  return { files: [...byPath].map(([path, content]) => ({ path, content })), remainder };
}

/** True when the reply carries anything this contract can act on. */
export function hasFileBlocks(text) {
  return extractFileBlocks(text).files.length > 0;
}

/**
 * The instruction appended to the user's turn when the request carries tools.
 *
 * Deliberately NOT the shared `<tool>` shim: Hatch treats that as narration.
 * Naming the exact fence and requiring self-contained files is what the probe
 * showed it follows.
 */
export function buildFileBlockContract({ writeToolName = "write_file", allowCommands = false } = {}) {
  const lines = [
    "[File output protocol]",
    "You cannot call the client's functions directly. To create or change a file, emit its",
    "full contents between a FILE marker and an END marker, exactly like this:",
    "",
    "=== FILE: src/example.js ===",
    "console.log('hi');",
    "=== END ===",
    "",
    "Rules:",
    "- One block per file. Repeat the block with the full new contents to edit a file.",
    "- Every block MUST be closed by `=== END ===` on its own line. A block without it",
    "  runs on and the client cannot tell your code from your explanation.",
    "- Paths are relative to the project root. Never absolute, never containing `..`.",
    "- Emit ONLY the files that actually change. Do not dump files you did not touch.",
    "- Any explanation goes outside the blocks; the client applies the blocks verbatim.",
    `- The client runs \`${writeToolName}\` for each block on the USER'S machine.`,
  ];
  if (allowCommands) {
    lines.push(
      "- To run something, use a CMD marker block the same way:",
      "",
      "=== CMD ===",
      "npm test",
      "=== END ===",
      "",
      "- The client runs it locally and reports the real output on the next turn. Never",
      "  claim a command succeeded — you will be told the result."
    );
  }
  return lines.join("\n");
}

const CMD_MARKER_RE = /^[ \t]*===[ \t]*CMD[ \t]*===[ \t]*\r?\n([\s\S]*?)^[ \t]*===[ \t]*END[ \t]*===[ \t]*$/gim;
const CMD_MARKER_LOOSE_RE = /^[ \t]*===[ \t]*CMD[ \t]*===[ \t]*\r?\n([\s\S]*?)(?=^[ \t]*===[ \t]*(?:FILE|CMD):|$(?![\s\S]))/gim;
const SHELL_FENCE_RE = /```[ \t]*shell[ \t]*\r?\n([\s\S]*?)```/gi;

/** Commands the model asked the client to run, in order. */
export function extractShellCommands(text) {
  let source = typeof text === "string" ? text : "";
  if (!source) return [];

  // Same ordering rule as the file parser: consume the bounded form first, then
  // run the loose one over what is left, so a terminated block is never also
  // matched (and re-read with the following prose) by the fallback.
  const out = [];
  for (const re of [CMD_MARKER_RE, CMD_MARKER_LOOSE_RE, SHELL_FENCE_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      const cmd = match[1].replace(/\r\n/g, "\n").trim();
      if (cmd) out.push(cmd);
    }
    source = source.replace(re, "");
  }
  return out;
}

/**
 * Turn a Hatch reply into OpenAI `tool_calls` plus the prose to keep.
 *
 * Returns `toolCalls: null` when the reply contained no file blocks, so the
 * caller can fall through to ordinary content handling.
 */
export function buildToolCallsFromReply(text, { idSeed = "muw", allowCommands = false, maxCalls = 64 } = {}) {
  const { files, remainder } = extractFileBlocks(text);
  const commands = allowCommands ? extractShellCommands(text) : [];
  if (files.length === 0 && commands.length === 0) {
    return { toolCalls: null, content: typeof text === "string" ? text : "" };
  }

  const stamp = Date.now();
  const toolCalls = [];
  let index = 0;
  for (const file of files) {
    if (toolCalls.length >= maxCalls) break;
    toolCalls.push({
      id: `${idSeed}-${stamp}-${index++}`,
      type: "function",
      function: { name: "write_file", arguments: JSON.stringify(file) },
    });
  }
  for (const cmd of commands) {
    if (toolCalls.length >= maxCalls) break;
    toolCalls.push({
      id: `${idSeed}-${stamp}-${index++}`,
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ cmd }) },
    });
  }

  return { toolCalls, content: remainder };
}
