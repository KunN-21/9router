// Port of Rust pytest_cmd filter (src_cmds_python_pytest_cmd.rs): compress `pytest -q` output.
// States: Header → TestProgress → Failures → Summary. Keeps failure bodies,
// XFAIL/XPASS lines, final counts. Drops per-test progress, warnings, captured noise.
const RE_SESSION = /test session starts/;
const RE_HDR = /^===/;
const RE_FAILURES_HDR = /^===.*FAILURES.*===/;
const RE_SUMMARY_HDR = /^===.*short test summary.*===/;
const RE_FINAL = /^===.*(passed|failed|skipped).*===/;
const RE_HINT = /\d+ (passed|failed|skipped|xfailed|xpassed)/;
// ponytail: mirrors Rust CAP_WARNINGS=10; promote to constants.js when shared.
const MAX_FAILURES = 10;
const MAX_XFAIL = 10;
const NO_TESTS = "Pytest: No tests collected";
const ANSI = /\x1b\[[0-9;]*m/g;
const trunc = (s, n) => (s.length > n ? s.slice(0, n) : s);

export function pytest(input) {
  try {
    if (typeof input !== "string") return input;
    if (!RE_SESSION.test(input) && !RE_HINT.test(input)) return input;
    const clean = input.replace(ANSI, "");

    // 0=Header 1=TestProgress 2=Failures 3=Summary
    let state = 0;
    const failures = [];
    let current = [];
    const xfailLines = [];
    let summaryLine = "";

    for (const line of clean.split("\n")) {
      const t = line.trim();
      if (RE_SESSION.test(t)) { state = 0; continue; }
      if (RE_FAILURES_HDR.test(t)) { state = 2; continue; }
      if (RE_SUMMARY_HDR.test(t)) {
        state = 3;
        if (current.length > 0) { failures.push(current.join("\n")); current = []; }
        continue;
      }
      if (RE_FINAL.test(t)) { summaryLine = t; continue; }
      // quiet mode (-q): bare summary without === wrapper
      if (!summaryLine && !RE_HDR.test(t) && !t.startsWith("FAILED") && !t.startsWith("ERROR")
        && (t.includes(" passed") || t.includes(" failed") || t.includes(" skipped")) && t.includes(" in ")) {
        summaryLine = t; continue;
      }

      if (state === 0) {
        if (t.startsWith("collected")) state = 1;
      } else if (state === 2) {
        if (t.startsWith("___")) {
          if (current.length > 0) { failures.push(current.join("\n")); current = []; }
          current.push(t);
        } else if (t && !RE_HDR.test(t)) {
          current.push(t);
        }
      } else if (state === 3) {
        if (t.startsWith("FAILED") || t.startsWith("ERROR")) failures.push(t);
        else if (t.startsWith("XFAIL") || t.startsWith("XPASS")) xfailLines.push(t);
      }
    }
    if (current.length > 0) failures.push(current.join("\n"));

    const c = parseSummary(summaryLine);
    if (!c.passed && !c.failed && !c.skipped && !c.xfailed && !c.xpassed) return ensureSmaller(NO_TESTS, input);

    const extras = c.skipped > 0 || c.xfailed > 0 || c.xpassed > 0 || xfailLines.length > 0;
    if (!c.failed && c.passed > 0 && !extras) return ensureSmaller(`Pytest: ${c.passed} passed`, input);

    let out = `Pytest: ${c.passed} passed, ${c.failed} failed`;
    if (c.skipped > 0) out += `, ${c.skipped} skipped`;
    if (c.xfailed > 0) out += `, ${c.xfailed} xfailed`;
    if (c.xpassed > 0) out += `, ${c.xpassed} xpassed`;
    out += "\n";

    if (xfailLines.length > 0) {
      out += "\nExpected-failure outcomes:\n";
      for (const l of xfailLines.slice(0, MAX_XFAIL)) out += `  ${trunc(l, 120)}\n`;
      if (xfailLines.length > MAX_XFAIL) out += `  … +${xfailLines.length - MAX_XFAIL} more\n`;
    }

    if (failures.length > 0) {
      out += "\nFailures:\n";
      failures.slice(0, MAX_FAILURES).forEach((f, i) => {
        const lines = f.split("\n");
        const first = lines[0] || "";
        if (first.startsWith("___")) {
          out += `${i + 1}. [FAIL] ${first.replace(/_/g, "").trim()}\n`;
        } else if (first.startsWith("FAILED")) {
          const parts = first.split(" - ");
          out += `${i + 1}. [FAIL] ${parts[0].replace(/^FAILED /, "")}\n`;
          if (parts.length > 1) out += `     ${trunc(parts[1], 100)}\n`;
          return;
        } else {
          out += `${i + 1}. [FAIL] ${trunc(first, 100)}\n`;
        }
        let kept = 0;
        for (const l of lines.slice(1)) {
          const ll = l.toLowerCase();
          if (kept < 3 && (l.trim().startsWith(">") || l.trim().startsWith("E")
            || ll.includes("assert") || ll.includes("error") || l.includes(".py:"))) {
            out += `     ${trunc(l, 100)}\n`;
            kept++;
          }
        }
        if (i < Math.min(failures.length, MAX_FAILURES) - 1) out += "\n";
      });
      if (failures.length > MAX_FAILURES) out += `\n… +${failures.length - MAX_FAILURES} more failures\n`;
    }

    out = out.replace(/\n+$/, "");
    if (!out || out.length >= input.length) return input;
    return out;
  } catch {
    return input;
  }
}

// Order matters: "xpassed"/"xfailed" contain "passed"/"failed" — check them first.
function parseSummary(summary) {
  const c = { passed: 0, failed: 0, skipped: 0, xfailed: 0, xpassed: 0 };
  for (const part of summary.split(",")) {
    const words = part.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const n = parseInt(words[i - 1], 10);
      if (Number.isNaN(n)) continue;
      const w = words[i];
      if (w.includes("xpassed")) c.xpassed = n;
      else if (w.includes("xfailed")) c.xfailed = n;
      else if (w.includes("passed")) c.passed = n;
      else if (w.includes("failed")) c.failed = n;
      else if (w.includes("skipped")) c.skipped = n;
    }
  }
  return c;
}

function ensureSmaller(s, input) {
  return s.length < input.length ? s : input;
}

pytest.filterName = "pytest";
