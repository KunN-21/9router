// Port of Rust go_cmd filter (src_cmds_go_go_cmd.rs): compress `go test -json` NDJSON.
// Groups by package: pass/fail counts, failing tests + selected failure lines,
// build failures via ImportPath/FailedBuild, package-level fails (timeout/signal).
const ANSI = /\x1b\[[0-9;]*m/g;
const trunc = (s, n) => (s.length > n ? s.slice(0, n) : s);
// ponytail: Rust caps via CAP_ERRORS=20; inline 5-line failure window mirrors
// select_go_test_failure_lines. Promote to constants.js when shared.

export function goTest(input) {
  try {
    if (typeof input !== "string") return input;
    const out = filterGoTestJson(input.replace(ANSI, ""));
    if (!out || out.length >= input.length) return input;
    return out;
  } catch {
    return input;
  }
}

function filterGoTestJson(output) {
  const packages = new Map(); // pkg -> {pass,fail,skip,buildFailed,buildErrors[],failedTests[][[name,lines]],pkgFailed,pkgFailOut[]}
  const testOut = new Map(); // "pkg\0test" -> [lines]
  const buildOut = new Map(); // importPath -> [lines]
  let parsed = 0;

  const pkgOf = (p) => {
    if (!packages.has(p)) {
      packages.set(p, { pass: 0, fail: 0, skip: 0, buildFailed: false, buildErrors: [], failedTests: [], pkgFailed: false, pkgFailOut: [] });
    }
    return packages.get(p);
  };

  for (const line of output.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; } // skip non-JSON lines
    if (!ev || typeof ev.Action !== "string") continue;
    parsed++;

    if (ev.Action === "build-output") {
      if (typeof ev.ImportPath === "string" && typeof ev.Output === "string") {
        const text = ev.Output.trimEnd();
        if (text) {
          if (!buildOut.has(ev.ImportPath)) buildOut.set(ev.ImportPath, []);
          buildOut.get(ev.ImportPath).push(text);
        }
      }
      continue;
    }
    if (ev.Action === "build-fail") continue; // handled at package-level fail via FailedBuild

    const pkg = typeof ev.Package === "string" && ev.Package ? ev.Package : "unknown";
    const st = pkgOf(pkg);

    if (ev.Action === "pass" && ev.Test) {
      st.pass++;
    } else if (ev.Action === "fail") {
      if (ev.Test) {
        st.fail++;
        const key = JSON.stringify([pkg, ev.Test]);
        st.failedTests.push([ev.Test, testOut.get(key) || []]);
        testOut.delete(key);
      } else if (typeof ev.FailedBuild === "string") {
        st.buildFailed = true;
        const errs = buildOut.get(ev.FailedBuild);
        if (errs) { st.buildErrors = errs; buildOut.delete(ev.FailedBuild); }
      } else {
        st.pkgFailed = true; // timeout / signal / panic before tests
      }
    } else if (ev.Action === "skip" && ev.Test) {
      st.skip++;
    } else if (ev.Action === "output" && typeof ev.Output === "string") {
      if (ev.Test) {
        const key = JSON.stringify([pkg, ev.Test]);
        if (!testOut.has(key)) testOut.set(key, []);
        testOut.get(key).push(ev.Output.trimEnd());
      } else {
        const text = ev.Output.trim();
        if (text) st.pkgFailOut.push(text);
      }
    }
  }

  if (parsed === 0) return null; // not go -json: passthrough

  let totalPass = 0, totalFail = 0, totalSkip = 0, totalBuild = 0, totalPkg = 0;
  for (const p of packages.values()) {
    totalPass += p.pass; totalFail += p.fail; totalSkip += p.skip;
    if (p.buildFailed) totalBuild++;
    // trailing package-level fail after test failures is a cascade, not extra failure
    if (p.pkgFailed && p.fail === 0 && !p.buildFailed) totalPkg++;
  }
  const hasFail = totalFail > 0 || totalBuild > 0 || totalPkg > 0;
  if (!hasFail && totalPass === 0) return "Go test: No tests found";
  if (!hasFail) return `Go test: ${totalPass} passed in ${packages.size} packages`;

  let out = `Go test: ${totalPass} passed, ${totalFail + totalBuild + totalPkg} failed`;
  if (totalSkip > 0) out += `, ${totalSkip} skipped`;
  out += ` in ${packages.size} packages\n`;

  for (const [pkg, p] of packages) {
    if (!p.pkgFailed || p.fail > 0 || p.buildFailed) continue;
    out += `\n${compact(pkg)} [FAIL]\n`;
    for (const l of p.pkgFailOut) {
      const t = l.trim();
      if (t) out += `  ${trunc(t, 120)}\n`;
    }
  }

  for (const [pkg, p] of packages) {
    if (!p.buildFailed) continue;
    out += `\n${compact(pkg)} [build failed]\n`;
    for (const l of p.buildErrors) {
      const t = l.trim();
      if (t && !t.startsWith("#")) out += `  ${trunc(t, 120)}\n`;
    }
  }

  for (const [pkg, p] of packages) {
    if (p.fail === 0) continue;
    out += `\n${compact(pkg)} (${p.pass} passed, ${p.fail} failed)\n`;
    for (const [name, outputs] of p.failedTests) {
      out += `  [FAIL] ${name}\n`;
      for (const l of selectFailureLines(outputs)) out += `     ${trunc(l, 100)}\n`;
    }
  }

  return out.trim();
}

function selectFailureLines(outputs) {
  const relevant = [];
  let keepNext = false;
  for (const line of outputs) {
    const t = line.trim();
    if (!t || t.startsWith("=== RUN") || t.startsWith("--- FAIL") || t.startsWith("--- PASS")) {
      keepNext = false;
      continue;
    }
    if (isLocation(t) || isFailure(t) || keepNext) {
      relevant.push(t);
      keepNext = isLocation(t);
    } else {
      keepNext = false;
    }
    if (relevant.length >= 5) break;
  }
  if (relevant.length === 0) {
    const first = outputs.map((l) => l.trim()).find((l) =>
      l && !l.startsWith("=== RUN") && !l.startsWith("--- FAIL") && !l.startsWith("--- PASS"));
    if (first) relevant.push(first);
  }
  return relevant;
}

function isLocation(line) {
  const i = line.indexOf(".go:");
  if (i === -1) return false;
  const c = line[i + 4];
  return c >= "0" && c <= "9";
}

function isFailure(line) {
  const l = line.toLowerCase();
  return l.startsWith("panic:") || l.startsWith("error:") || l.includes(" error:")
    || l.includes("expected") || l.includes("got") || l.includes("want")
    || l.includes("actual") || l.includes("assert") || l.includes("mismatch")
    || l.includes("unexpected") || l.includes("fatal") || line.startsWith("at ");
}

function compact(pkg) {
  const i = pkg.lastIndexOf("/");
  return i === -1 ? pkg : pkg.slice(i + 1);
}

goTest.filterName = "go-test";
