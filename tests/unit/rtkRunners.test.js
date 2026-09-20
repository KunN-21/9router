// Port of Rust rtk *_cmd test-runner filter tests: pytest, go-test, vitest,
// tsc, mypy, ruff, prettier, cargo-test. Pattern mirrors tests/unit/rtkKiro.test.js.
// Every filter is fail-open: error input → return input untouched, never throw.
import { describe, it, expect } from "vitest";
import { autoDetectFilter } from "../../open-sse/rtk/autodetect.js";
import { safeApply } from "../../open-sse/rtk/applyFilter.js";
import { resolveFilter } from "../../open-sse/rtk/registry.js";
import { pytest } from "../../open-sse/rtk/filters/pytest.js";
import { goTest } from "../../open-sse/rtk/filters/goTest.js";
import { vitest } from "../../open-sse/rtk/filters/vitest.js";
import { tsc } from "../../open-sse/rtk/filters/tsc.js";
import { mypy } from "../../open-sse/rtk/filters/mypy.js";
import { ruff, ruffCheck, ruffFormat } from "../../open-sse/rtk/filters/ruff.js";
import { prettier } from "../../open-sse/rtk/filters/prettier.js";
import { cargoTest } from "../../open-sse/rtk/filters/cargoTest.js";

function pad(n, seed) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`${seed} filler line ${i} with padding text padding text padding`);
  return lines.join("\n");
}

describe("pytest filter", () => {
  it("collapses progress lines, keeps failures + summary", () => {
    const input = [
      "============================= test session starts ==============================",
      "platform linux -- Python 3.11, pytest-8.0",
      "rootdir: /repo",
      "collected 3 items",
      "",
      "tests/test_a.py::test_one PASSED [ 33%]",
      "tests/test_a.py::test_two FAILED [ 66%]",
      "tests/test_a.py::test_three PASSED [100%]",
      "",
      "=================================== FAILURES ===================================",
      "_________________________ test_two _________________________",
      "",
      "E       assert 1 == 2",
      "",
      "=========================== short test summary info ============================",
      "FAILED tests/test_a.py::test_two - assert 1 == 2",
      "2 passed, 1 failed in 1.23s",
    ].join("\n") + "\n" + pad(10, "noise");
    const out = pytest(input);
    expect(out).toContain("Pytest:");
    expect(out).toContain("assert 1 == 2");
    expect(out).toContain("2 passed, 1 failed");
    expect(out.length).toBeLessThan(input.length);
  });

  it("passes through non-pytest input", () => {
    const input = pad(20, "hello");
    expect(pytest(input)).toBe(input);
  });
});

describe("go-test filter", () => {
  it("groups NDJSON by package, keeps failing tests + build-fail output", () => {
    const events = [
      { Action: "run", Package: "example.com/foo", Test: "TestFail" },
      { Action: "output", Package: "example.com/foo", Test: "TestFail", Output: "=== RUN   TestFail\n" },
      { Action: "output", Package: "example.com/foo", Test: "TestFail", Output: "    foo_test.go:42: Error: expected 5, got 3\n" },
      { Action: "fail", Package: "example.com/foo", Test: "TestFail", Elapsed: 0.5 },
      { Action: "fail", Package: "example.com/foo", Elapsed: 0.5 },
      { Action: "build-output", ImportPath: "example.com/broken", Output: "broken.go:3: undefined: Foo\n" },
      { Action: "fail", Package: "example.com/broken", FailedBuild: "example.com/broken", Elapsed: 0.1 },
    ].map((e) => JSON.stringify(e)).join("\n");
    const input = events + "\n" + pad(10, "tail");
    const out = goTest(input);
    expect(out).toContain("2 failed");
    expect(out).toContain("TestFail");
    expect(out).toContain("foo_test.go:42:");
    expect(out).toContain("[build failed]");
    expect(out).toContain("undefined: Foo");
    expect(out.length).toBeLessThan(input.length);
  });

  it("passes through non-JSON input", () => {
    const input = pad(20, "plain");
    expect(goTest(input)).toBe(input);
  });
});

describe("vitest filter", () => {
  it("Tier1: summarizes JSON reporter output", () => {
    const data = {
      numTotalTests: 3,
      numFailedTests: 1,
      testResults: [
        { name: "a.test.js", status: "passed", assertionResults: [{ status: "passed", title: "one" }] },
        {
          name: "b.test.js", status: "failed",
          assertionResults: [{ status: "failed", title: "two", failureMessages: [`AssertionError: nope\n${pad(10, "stack")}`] }],
        },
      ],
    };
    const input = JSON.stringify(data) + "\n" + pad(20, "noise");
    const out = vitest(input);
    expect(out).toContain("2/3 passed");
    expect(out).toContain("FAIL b.test.js");
    expect(out.length).toBeLessThan(input.length);
  });

  it("Tier2: keeps FAIL/summary text lines, drops pass marks", () => {
    const input = [
      "✓ src/a.test.js (3 tests) 12ms",
      "❯ src/b.test.js (1 failed)",
      "× b fails hard",
      "Test Files  1 failed | 1 passed (2)",
      "Tests  1 failed | 3 passed (4)",
    ].join("\n") + "\n" + pad(10, "filler");
    const out = vitest(input);
    expect(out).not.toContain("✓ src/a.test.js");
    expect(out).toContain("1 failed | 1 passed (2)");
    expect(out.length).toBeLessThan(input.length);
  });

  it("Tier3: unrecognized input passes through", () => {
    const input = pad(20, "hello");
    expect(vitest(input)).toBe(input);
  });
});

describe("tsc filter", () => {
  it("groups TS errors by file + code with top codes", () => {
    const lines = [];
    for (let i = 1; i <= 15; i++) lines.push(`src/a.ts(${i},2): error TS2322: Type 'string' is not assignable with padding ${"x".repeat(20)}`);
    for (let i = 1; i <= 5; i++) lines.push(`src/b.ts(${i},1): error TS2304: Cannot find name 'foo' padding ${"y".repeat(20)}`);
    lines.push("Found 20 errors.");
    const input = lines.join("\n");
    const out = tsc(input);
    expect(out).toContain("TypeScript: 20 errors in 2 files");
    expect(out).toContain("src/a.ts (15 errors)");
    expect(out).toContain("src/b.ts (5 errors)");
    expect(out).toContain("Top codes: TS2322 (15x), TS2304 (5x)");
    expect(out.length).toBeLessThan(input.length);
  });

  it("handles --pretty ANSI format", () => {
    const lines = [
      "\x1b[96msrc/index.ts\x1b[0m:\x1b[93m1\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType 'string' is not assignable to type 'number'.",
      "\x1b[96msrc/index.ts\x1b[0m:\x1b[93m4\x1b[0m:\x1b[93m8\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType 'boolean' is not assignable to type 'number'.",
      "\x1b[96msrc/index.ts\x1b[0m:\x1b[93m4\x1b[0m:\x1b[93m16\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2345: \x1b[0mArgument of type 'null' is not assignable.",
    ];
    const input = lines.join("\n") + "\n" + pad(10, "pretty-tail");
    const out = tsc(input);
    expect(out).toContain("TypeScript: 3 errors in 1 files");
    expect(out).toContain("src/index.ts (3 errors)");
    expect(out).toContain("TS2322");
    expect(out).not.toContain("\x1b[");
  });

  it("handles global file-less errors", () => {
    const lines = [
      "error TS5058: The specified path does not exist: 'tsconfig.json'.",
      "  The file is in the program because:",
      "    Root file specified for compilation",
    ];
    const input = lines.join("\n") + "\n" + pad(10, "global-tail");
    const out = tsc(input);
    expect(out).toContain("TS5058");
    expect(out).toContain("global (1 errors)");
    expect(out).toContain("The file is in the program because:");
  });

  it("preserves continuation lines indent", () => {
    const lines = [
      "src/app.tsx(10,3): error TS2322: Type '{ children: Element; }' is not assignable to type 'Props'.",
      "  Property 'children' does not exist on type 'Props'.",
      "src/app.tsx(20,5): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
    ];
    const input = lines.join("\n") + "\n" + pad(10, "tail");
    const out = tsc(input);
    expect(out).toContain("Property 'children' does not exist on type 'Props'.");
    expect(out).toContain("L10:");
    expect(out).toContain("L20:");
  });

  it("handles 'Found 0 errors'", () => {
    const input = "Found 0 errors. Watching for file changes.";
    const out = tsc(input);
    expect(out).toBe("TypeScript: No errors found");
  });

  it("passes through non-diagnostic input", () => {
    const input = pad(20, "hello");
    expect(tsc(input)).toBe(input);
  });
});

describe("mypy filter", () => {
  it("groups mypy errors by file, sorted by error count", () => {
    const output = [
      "src/server/auth.py:12: error: Incompatible return value type (got \"str\", expected \"int\")  [return-value]",
      "src/server/auth.py:15: error: Argument 1 has incompatible type \"int\"; expected \"str\"  [arg-type]",
      "src/models/user.py:8: error: Name \"foo\" is not defined  [name-defined]",
      "src/models/user.py:10: error: Incompatible types in assignment  [assignment]",
      "src/models/user.py:20: error: Missing return statement  [return]",
      "Found 5 errors in 2 files (checked 10 source files)",
    ].join("\n") + "\n" + pad(10, "mypy-tail");

    const out = mypy(output);
    expect(out).toContain("mypy: 5 errors in 2 files");
    const userPos = out.indexOf("user.py");
    const authPos = out.indexOf("auth.py");
    expect(userPos).toBeLessThan(authPos);
    expect(out).toContain("user.py (3 errors)");
    expect(out).toContain("auth.py (2 errors)");
    expect(out).toContain("Top codes:");
  });

  it("handles column numbers and codes", () => {
    const input = "src/api.py:10:5: error: Incompatible return value type  [return-value]\n" + pad(10, "tail");
    const out = mypy(input);
    expect(out).toContain("L10:");
    expect(out).toContain("[return-value]");
    expect(out).toContain("Incompatible return value type");
  });

  it("attaches note severity to preceding error if same file", () => {
    const input = [
      "src/app.py:10: error: Incompatible types in assignment  [assignment]",
      "src/app.py:10: note: Expected type \"int\"",
      "src/app.py:10: note: Got type \"str\"",
      "src/app.py:20: error: Missing return statement  [return]",
    ].join("\n") + "\n" + pad(10, "tail");

    const out = mypy(input);
    expect(out).toContain("Incompatible types in assignment");
    expect(out).toContain("Expected type \"int\"");
    expect(out).toContain("Got type \"str\"");
    expect(out).toContain("L10:");
    expect(out).toContain("L20:");
  });

  it("displays file-less errors first", () => {
    const input = [
      "mypy: error: No module named 'nonexistent'",
      "src/api.py:10: error: Name \"foo\" is not defined  [name-defined]",
      "Found 1 error in 1 file",
    ].join("\n") + "\n" + pad(10, "tail");

    const out = mypy(input);
    expect(out).toContain("mypy: error: No module named 'nonexistent'");
    expect(out).toContain("api.py (1 errors)");
    const filelessPos = out.indexOf("No module named");
    const groupedPos = out.indexOf("api.py");
    expect(filelessPos).toBeLessThan(groupedPos);
  });

  it("handles 'Success: no issues found'", () => {
    const input = "Success: no issues found in 5 source files\n";
    expect(mypy(input)).toBe("mypy: No issues found");
  });

  it("passes through non-mypy input", () => {
    const input = pad(20, "hello");
    expect(mypy(input)).toBe(input);
  });
});

describe("ruff filter", () => {
  it("caps JSON diagnostics at 50, top rules, top files, fixable hint", () => {
    const diags = [];
    for (let i = 0; i < 70; i++) {
      diags.push({
        filename: `src/${i % 3 === 0 ? "a" : "b"}.py`,
        code: "F401",
        message: `unused import os number ${i} with padding padding padding padding`,
        location: { row: i + 1, column: 1 },
        fix: i < 10 ? { applicability: "safe" } : null,
      });
    }
    const input = JSON.stringify(diags);
    const out = ruff(input);
    expect(out).toContain("70 issues in 2 files");
    expect(out).toContain("(10 fixable)");
    expect(out).toContain("Top rules:");
    expect(out).toContain("Top files:");
    expect(out).toContain("Violations:");
    expect(out).toContain("… +20 more");
    expect(out).toContain("[hint] Run `ruff check --fix`");
    expect(out.length).toBeLessThan(input.length);
  });

  it("handles ruff format: all files formatted correctly", () => {
    const input = "5 files left unchanged";
    const out = ruff(input);
    expect(out).toBe("Ruff format: All files formatted correctly");
  });

  it("handles ruff format: files need formatting", () => {
    const input = [
      "Would reformat: src/main.py",
      "Would reformat: tests/test_utils.py",
      "2 files would be reformatted, 3 files left unchanged",
    ].join("\n");
    const out = ruff(input);
    expect(out).toContain("Ruff format: 2 files need formatting");
    expect(out).toContain("1. main.py");
    expect(out).toContain("2. test_utils.py");
    expect(out).toContain("3 files already formatted");
    expect(out).toContain("[hint] Run `ruff format`");
  });

  it("passes through non-ruff input", () => {
    const input = pad(20, "hello");
    expect(ruff(input)).toBe(input);
  });
});

describe("prettier filter", () => {
  it("empty or whitespace output -> Error: prettier produced no output", () => {
    expect(prettier("")).toBe("Error: prettier produced no output");
    expect(prettier("   \n\n  ")).toBe("Error: prettier produced no output");
  });

  it("check mode: files need formatting with cap 10", () => {
    const lines = ["Checking formatting..."];
    for (let i = 0; i < 15; i++) lines.push(`src/file${i}.ts`);
    lines.push("Code style issues found in the above file(s). Forgot to run Prettier?");
    const input = lines.join("\n");
    const out = prettier(input);
    expect(out).toContain("Prettier: 15 files need formatting");
    expect(out).toContain("1. src/file0.ts");
    expect(out).toContain("... +5 more files");
  });

  it("All matched files use Prettier -> Prettier: All files formatted correctly", () => {
    const input = "Checking formatting...\nAll matched files use Prettier code style!\n";
    expect(prettier(input)).toBe("Prettier: All files formatted correctly");
  });

  it("write mode: N files formatted", () => {
    const input = "src/a.ts\nsrc/b.ts\nformatted 2 files";
    const out = prettier(input);
    expect(out).toBe("Prettier: 2 files formatted");
  });

  it("passes through non-prettier input", () => {
    const input = pad(20, "hello");
    expect(prettier(input)).toBe(input);
  });
});

describe("cargo-test & cargo-build filter", () => {
  it("keeps test result + failures, collapses ok tests", () => {
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(`test t${i} ... ok`);
    lines.push("test test_boom ... FAILED");
    lines.push("---- test_boom stdout ----");
    lines.push("thread 'test_boom' panicked at src/main.rs:10");
    lines.push("");
    lines.push("failures:");
    lines.push("    test_boom");
    lines.push("test result: FAILED. 30 passed; 1 failed; 0 ignored");
    const input = lines.join("\n") + "\n" + pad(10, "build-noise");
    const out = cargoTest(input);
    expect(out).toContain("30 tests passed (ok collapsed)");
    expect(out).toContain("test_boom");
    expect(out).toContain("test result: FAILED");
    expect(out.length).toBeLessThan(input.length);
  });

  it("handles cargo build success", () => {
    const input = [
      "   Compiling libc v0.2.153",
      "   Compiling cfg-if v1.0.0",
      "   Compiling rtk v0.5.0",
      "    Finished dev [unoptimized + debuginfo] target(s) in 15.23s",
    ].join("\n") + "\n" + pad(10, "tail");
    const out = cargoTest(input);
    expect(out).toContain("cargo build (3 crates compiled)");
    expect(out).toContain("Finished dev [unoptimized + debuginfo] target(s) in 15.23s");
    expect(out).not.toContain("Compiling");
  });

  it("handles cargo build errors", () => {
    const input = [
      "   Compiling rtk v0.5.0",
      "error[E0308]: mismatched types",
      " --> src/main.rs:10:5",
      "  |",
      "10|     \"hello\"",
      "  |     ^^^^^^^ expected `i32`, found `&str`",
      "",
      "error: aborting due to 1 previous error",
    ].join("\n") + "\n" + pad(10, "tail");
    const out = cargoTest(input);
    expect(out).toContain("cargo build: 1 errors, 0 warnings (1 crates)");
    expect(out).toContain("error[E0308]: mismatched types");
    expect(out).toContain("--> src/main.rs:10:5");
  });

  it("passes through input without cargo markers", () => {
    const input = pad(20, "hello");
    expect(cargoTest(input)).toBe(input);
  });
});

describe("autodetect (test runners & linters)", () => {
  it("detects cargo `test result:`", () => {
    expect(autoDetectFilter("test result: ok. 30 passed; 0 failed\nrunning 30 tests\n").filterName).toBe("cargo-test");
  });
  it("detects cargo build via build-output", () => {
    expect(autoDetectFilter("   Compiling rtk v0.5.0\n    Finished dev in 1.2s\n").filterName).toBe("build-output");
  });
  it("detects pytest session", () => {
    expect(autoDetectFilter("===== test session starts =====\ncollected 3 items\n").filterName).toBe("pytest");
  });
  it("detects go NDJSON", () => {
    expect(autoDetectFilter('{"Action":"run","Package":"pkg/a"}\n{"Action":"pass","Package":"pkg/a"}\n').filterName).toBe("go-test");
  });
  it("detects vitest JSON", () => {
    expect(autoDetectFilter('{"numTotalTests":3,"numFailedTests":0,"testResults":[]}\n').filterName).toBe("vitest");
  });
  it("detects mypy errors", () => {
    expect(autoDetectFilter("src/app.py:10: error: bad type here\nsrc/b.py:2: error: nope\n").filterName).toBe("mypy");
  });
  it("detects tsc errors (default)", () => {
    expect(autoDetectFilter("src/a.ts(1,2): error TS2322: bad assign\nsrc/b.ts(3,4): error TS2304: nope\n").filterName).toBe("tsc");
  });
  it("detects tsc errors (--pretty)", () => {
    expect(autoDetectFilter("src/index.ts:1:7 - error TS2322: Type 'string' is not assignable\n").filterName).toBe("tsc");
  });
  it("detects tsc errors (global)", () => {
    expect(autoDetectFilter("error TS5058: The specified path does not exist\n").filterName).toBe("tsc");
  });
  it("detects prettier", () => {
    expect(autoDetectFilter("Checking formatting...\nsrc/index.ts\n").filterName).toBe("prettier");
  });
  it("detects ruff check JSON", () => {
    expect(autoDetectFilter('[{"code":"F401","filename":"src/main.py","location":{"row":1,"column":1},"message":"unused"}]').filterName).toBe("ruff");
  });
  it("detects ruff format", () => {
    expect(autoDetectFilter("Would reformat: src/main.py\n2 files would be reformatted\n").filterName).toBe("ruff");
  });
});

describe("registry (test runners & linters)", () => {
  it("resolves all new filter names", () => {
    for (const [name, fn] of [
      ["pytest", pytest],
      ["go-test", goTest],
      ["vitest", vitest],
      ["tsc", tsc],
      ["mypy", mypy],
      ["prettier", prettier],
      ["ruff", ruff],
      ["ruff-check", ruffCheck],
      ["ruff-format", ruffFormat],
      ["cargo-test", cargoTest],
    ]) {
      expect(resolveFilter(name)).toBe(fn);
    }
  });
});

describe("fail-open (test runners & linters)", () => {
  it("safeApply returns input when filter throws; never-worse guard holds", () => {
    const big = "x".repeat(1000);
    expect(safeApply(() => { throw new Error("boom"); }, big)).toBe(big);
    for (const fn of [pytest, goTest, vitest, tsc, mypy, ruff, prettier, cargoTest]) {
      expect(fn(null)).toBe(null);
      expect(fn(undefined)).toBe(undefined);
      expect(fn("")).toBe(fn === prettier ? "Error: prettier produced no output" : "");
      const junk = "not matching anything\n".repeat(40);
      const out = fn(junk);
      expect(typeof out === "string" && out.length > 0).toBe(true);
      expect(out.length).toBeLessThanOrEqual(junk.length);
    }
  });
});
