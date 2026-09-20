// Port of Rust tsc_cmd filter (src_cmds_js_tsc_cmd.rs):
// Group TypeScript compiler errors by file and code.
// Handles default (file(line,col): error TSxxx: msg),
// --pretty (file:line:col - error TSxxx: msg), and global file-less (error TSxxx: msg).

const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const RE_TSC_DEFAULT = /^(.+?)\((\d+),(\d+)\):\s*(?:error|warning)\s+(TS\d+):\s*(.+)$/;
const RE_TSC_PRETTY = /^(.+?):(\d+):(\d+)\s+-\s+(?:error|warning)\s+(TS\d+):\s*(.+)$/;
const RE_TSC_GLOBAL = /^(?:error|warning)\s+(TS\d+):\s*(.+)$/;

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 3) + "..." : s);

function parseDiagnostic(line) {
  let m = RE_TSC_DEFAULT.exec(line);
  if (m) {
    return { file: m[1], line: parseInt(m[2], 10), code: m[4], message: m[5] };
  }
  m = RE_TSC_PRETTY.exec(line);
  if (m) {
    return { file: m[1], line: parseInt(m[2], 10), code: m[4], message: m[5] };
  }
  m = RE_TSC_GLOBAL.exec(line);
  if (m) {
    return { file: null, line: null, code: m[1], message: m[2] };
  }
  return null;
}

export function tsc(input) {
  try {
    if (typeof input !== "string") return input;

    const clean = input.replace(ANSI, "");
    const lines = clean.split("\n");
    const errors = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const diag = parseDiagnostic(line);
      if (diag) {
        const err = {
          file: diag.file,
          line: diag.line,
          code: diag.code,
          message: diag.message,
          contextLines: [],
        };
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (
            next.length > 0 &&
            (next.startsWith("  ") || next.startsWith("\t")) &&
            !parseDiagnostic(next)
          ) {
            err.contextLines.push(next.trim());
            i++;
          } else {
            break;
          }
        }
        errors.push(err);
      } else {
        i++;
      }
    }

    if (errors.length === 0) {
      if (clean.includes("Found 0 errors")) {
        const res = "TypeScript: No errors found";
        return res.length < input.length ? res : input;
      }
      return input;
    }

    const globalErrors = errors.filter((e) => e.file === null);
    const byFile = new Map();
    const codeCounts = new Map();

    for (const err of errors) {
      if (err.file !== null) {
        if (!byFile.has(err.file)) byFile.set(err.file, []);
        byFile.get(err.file).push(err);
      }
      codeCounts.set(err.code, (codeCounts.get(err.code) || 0) + 1);
    }

    let result =
      byFile.size === 0
        ? `TypeScript: ${errors.length} errors\n`
        : `TypeScript: ${errors.length} errors in ${byFile.size} files\n`;

    if (codeCounts.size > 1) {
      const sortedCodes = Array.from(codeCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([code, count]) => `${code} (${count}x)`);
      result += `Top codes: ${sortedCodes.join(", ")}\n\n`;
    }

    if (globalErrors.length > 0) {
      result += `global (${globalErrors.length} errors)\n`;
      for (const err of globalErrors) {
        result += `  ${err.code} ${trunc(err.message, 120)}\n`;
        for (const ctx of err.contextLines) {
          result += `    ${trunc(ctx, 120)}\n`;
        }
      }
      result += "\n";
    }

    const filesSorted = Array.from(byFile.entries()).sort(
      (a, b) => b[1].length - a[1].length
    );

    for (const [file, fileErrors] of filesSorted) {
      result += `${file} (${fileErrors.length} errors)\n`;
      for (const err of fileErrors) {
        result += `  L${err.line || 0}: ${err.code} ${trunc(err.message, 120)}\n`;
        for (const ctx of err.contextLines) {
          result += `    ${trunc(ctx, 120)}\n`;
        }
      }
      result += "\n";
    }

    const out = result.trim();
    if (!out || out.length >= input.length) return input;
    return out;
  } catch {
    return input;
  }
}

tsc.filterName = "tsc";
