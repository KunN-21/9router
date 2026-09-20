// Port of Rust cargo_cmd filter (src_cmds_rust_cargo_cmd.rs).
// Handles both `cargo test` (collapses ok tests, keeps failures, panics, summaries)
// and `cargo build` / `cargo check` (collapses compiling noise, keeps errors/warnings, finished line).

import { CARGO_TEST_MAX_LINES } from "../constants.js";

const RE_RESULT = /^test result:/m;
const RE_RUNNING_TESTS = /^running \d+ tests?/m;
const RE_FAILED_TEST = /^test (\S+) \.\.\. FAILED$/;
const RE_OK_TEST = /^test (\S+) \.\.\. ok$/;
const RE_STDOUT_HDR = /^---- (\S+) stdout ----$/;
const RE_FAILURES_HDR = /^failures:$/;
const RE_FAILURE_ITEM = /^    (\S+)$/;
const RE_PANIC = /panicked/;
const RE_ERROR = /^(error(\[|:)|warning:)/;
const RE_RUN_MARKER = /^(running \d+ tests?|     Running|   Doc-tests|error: could not compile)/;
const RE_FINISHED = /^\s*Finished\s+/;
const RE_COMPILING = /^\s*Compiling\s+/;

function filterCargoBuild(input) {
  const lines = input.split("\n");
  let compiled = 0;
  let finishedLine = null;
  let errorCount = 0;
  let warningCount = 0;
  const blocks = [];
  let currentBlock = [];
  let inBlock = false;
  let isCheck = false;
  let isTest = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("Checking ")) {
      isCheck = true;
      compiled++;
      continue;
    }
    if (trimmed.startsWith("Compiling ")) {
      compiled++;
      continue;
    }
    if (trimmed.startsWith("Downloading") || trimmed.startsWith("Downloaded")) {
      continue;
    }
    if (trimmed.startsWith("Finished")) {
      finishedLine = trimmed;
      if (trimmed.includes("test")) isTest = true;
      continue;
    }
    if (line.startsWith("warning:") && line.includes("generated") && line.includes("warning")) {
      continue;
    }
    if (
      (line.startsWith("error:") || line.startsWith("error[")) &&
      (line.includes("aborting due to") || line.includes("could not compile"))
    ) {
      if (line.includes("test")) isTest = true;
      continue;
    }

    const isErr = line.startsWith("error[") || line.startsWith("error:");
    const isWarn = line.startsWith("warning:") || line.startsWith("warning[");

    if (isErr || isWarn) {
      if (inBlock && currentBlock.length > 0) {
        blocks.push(currentBlock.join("\n"));
        currentBlock = [];
      }
      inBlock = true;
      if (isErr) errorCount++;
      if (isWarn) warningCount++;
      currentBlock.push(line);
    } else if (inBlock) {
      if (line.trim() === "" && currentBlock.length > 3) {
        blocks.push(currentBlock.join("\n"));
        currentBlock = [];
        inBlock = false;
      } else {
        currentBlock.push(line);
      }
    }
  }

  if (inBlock && currentBlock.length > 0) {
    blocks.push(currentBlock.join("\n"));
  }

  if (compiled === 0 && !finishedLine && errorCount === 0 && warningCount === 0) {
    return input;
  }

  const label = isTest ? "test" : isCheck ? "check" : "build";
  let result = "";

  if (errorCount === 0 && warningCount === 0) {
    result = `cargo ${label} (${compiled} crates compiled)\n`;
    if (finishedLine) {
      result += `${finishedLine}\n`;
    }
  } else {
    result = `cargo ${label}: ${errorCount} errors, ${warningCount} warnings (${compiled} crates)\n`;
    const CAP_ERRORS = 10;
    for (let i = 0; i < Math.min(blocks.length, CAP_ERRORS); i++) {
      result += `${blocks[i]}\n\n`;
    }
    if (blocks.length > CAP_ERRORS) {
      result += `… +${blocks.length - CAP_ERRORS} more issues\n`;
    }
  }

  const out = result.trim();
  if (!out || out.length >= input.length) return input;
  return out;
}

export function cargoTest(input) {
  try {
    if (typeof input !== "string") return input;

    // Handle cargo test if test results/runners detected
    if (RE_RESULT.test(input) || RE_RUNNING_TESTS.test(input)) {
      const kept = [];
      const failures = [];
      let okCount = 0;
      let compilingCount = 0;
      let inStdout = false;
      let stdoutKept = 0;
      const STDOUT_MAX = 20;

      const push = (l) => {
        if (kept.length < CARGO_TEST_MAX_LINES) kept.push(l);
      };

      for (const line of input.split("\n")) {
        const t = line.trim();

        if (RE_STDOUT_HDR.test(t)) {
          inStdout = true;
          stdoutKept = 0;
          push(`-- ${t} --`);
          continue;
        }
        if (inStdout) {
          if (t === "") {
            inStdout = false;
            continue;
          }
          if (stdoutKept < STDOUT_MAX) {
            push(line);
            stdoutKept++;
          } else if (stdoutKept === STDOUT_MAX) {
            push("  ... (stdout truncated)");
            stdoutKept++;
          }
          continue;
        }

        if (RE_OK_TEST.test(t)) {
          okCount++;
          continue;
        }
        if (RE_COMPILING.test(line)) {
          compilingCount++;
          continue;
        }
        if (!t) continue;

        const fm = RE_FAILED_TEST.exec(t);
        if (fm) {
          failures.push(fm[1]);
          push(line);
          continue;
        }
        if (
          RE_RESULT.test(t) ||
          RE_FAILURES_HDR.test(t) ||
          RE_FAILURE_ITEM.test(t) ||
          RE_PANIC.test(t) ||
          RE_ERROR.test(t) ||
          RE_RUN_MARKER.test(t) ||
          RE_FINISHED.test(line)
        ) {
          push(line);
          continue;
        }
      }

      let out = "";
      if (okCount > 0) out += `${okCount} tests passed (ok collapsed)\n`;
      if (compilingCount > 0) out += `Compiled ${compilingCount} crates\n`;
      for (const l of kept) out += `${l}\n`;

      out = out.replace(/\n+$/, "");
      if (!out || out.length >= input.length) return input;
      return out;
    }

    // Handle cargo build / check
    return filterCargoBuild(input);
  } catch {
    return input;
  }
}

cargoTest.filterName = "cargo-test";
