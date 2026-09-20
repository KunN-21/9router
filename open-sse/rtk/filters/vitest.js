// Port of Rust vitest_cmd filter (src_cmds_js_vitest_cmd.rs): compress vitest output.
// Tier1: JSON (`--reporter=json`: testResults/numTotalTests) → per-suite summary.
// Tier2: text output → Tests/Duration regex → failure lines.
// Tier3: unrecognized → passthrough.
const ANSI = /\x1b\[[0-9;]*m/g;
// ponytail: Rust caps via CAP_WARNINGS=10; inline max failures mirrors Tier1
// failure window. Promote to constants.js when shared.
const MAX_FAILURES = 10;

export function vitest(input) {
  try {
    if (typeof input !== "string") return input;
    const t1 = parseJsonTier(input);
    if (t1) return ensureSmaller(t1, input);
    const t2 = parseRegexTier(input.replace(ANSI, ""));
    if (t2) return ensureSmaller(t2, input);
    return input; // Tier3 passthrough
  } catch {
    return input;
  }
}

function parseJsonTier(input) {
  const t = input.trim();
  if (!t.startsWith("{") && !t.startsWith("[") && !t.includes('"testResults"') && !t.includes('"numTotalTests"')) return null;
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    // tool output often wraps JSON with log noise — extract braces span
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try { data = JSON.parse(t.slice(start, end + 1)); } catch { return null; }
  }
  const root = Array.isArray(data) ? { testResults: data } : data;
  if (!Array.isArray(root.testResults) && typeof root.numTotalTests !== "number") return null;

  const results = Array.isArray(root.testResults) ? root.testResults : [];
  let pass = 0;
  let fail = 0;
  const failedSuites = [];
  for (const suite of results) {
    const asserts = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    const bad = asserts.filter((a) => a && a.status === "failed");
    if (bad.length > 0 || suite.status === "failed") {
      fail += bad.length || 1;
      failedSuites.push({ name: suite.name || "unknown", bad: bad.slice(0, 3) });
    } else {
      pass += asserts.length;
    }
  }
  const total = typeof root.numTotalTests === "number" ? root.numTotalTests : pass + fail;
  const failedN = typeof root.numFailedTests === "number" ? root.numFailedTests : fail;

  let out = `vitest: ${total - failedN}/${total} passed (${failedN} failed)\n`;
  for (const s of failedSuites.slice(0, MAX_FAILURES)) {
    out += `FAIL ${s.name}\n`;
    for (const b of s.bad) {
      out += `  ✗ ${b.title || b.fullName || "unnamed"}\n`;
      const msg = Array.isArray(b.failureMessages) ? b.failureMessages[0] : b.failureMessages;
      if (typeof msg === "string" && msg) out += `    ${msg.split("\n")[0].slice(0, 200)}\n`;
    }
  }
  if (failedSuites.length > MAX_FAILURES) out += `+${failedSuites.length - MAX_FAILURES} more failing suites\n`;
  return out.replace(/\n+$/, "");
}

// Tier2: regex over text output. Tests line (failed optional) + Duration header,
// plus kept summary lines and FAIL/[x] blocks with indented context.
function parseRegexTier(clean) {
  const testsRe = /Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed/;
  const durRe = /Duration\s+([\d.]+)(ms|s)/;
  const tm = testsRe.exec(clean);
  if (!tm) return null;
  const failed = tm[1] ? parseInt(tm[1], 10) : 0;
  const passed = parseInt(tm[2], 10);
  const total = passed + failed;
  if (total <= 0) return null;

  let duration = "";
  const dm = durRe.exec(clean);
  if (dm) duration = ` (${dm[1]}${dm[2]})`;

  let out = `vitest: ${passed}/${total} passed (${failed} failed)${duration}\n`;
  const keepRe = /Test Files|Tests\s|Duration|FAIL|\[x\]|×|✗|failed|Errors|Start at|Unhandled/;
  let ctx = false;
  for (const line of clean.split("\n")) {
    const t = line.trim();
    if (!t || /^[✓√]/.test(t)) { ctx = false; continue; } // drop pass marks
    if (keepRe.test(line)) {
      out += `${line.replace(/\s+$/, "")}\n`;
      ctx = /FAIL|\[x\]/.test(t);
      continue;
    }
    if (ctx && /^\s/.test(line)) { out += `${line.replace(/\s+$/, "")}\n`; continue; }
    ctx = false;
  }
  return out.replace(/\n+$/, "");
}

function ensureSmaller(s, input) {
  if (!s) return input;
  return s.length < input.length ? s : input;
}

vitest.filterName = "vitest";
