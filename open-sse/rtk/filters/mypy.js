// Port of Rust mypy_cmd filter (src_cmds_python_mypy_cmd.rs):
// Group mypy errors by file.
// Matches file.py:line: error: msg [code] or file.py:line:col: error: msg [code].
// Attaches note severity to preceding error if same file.
// Shows file-less errors first, top codes when >1 code.

const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const RE_MYPY_DIAG = /^(.+?):(\d+)(?::\d+)?: (error|warning|note): (.+?)(?:\s+\[(.+)\])?$/;
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 3) + "..." : s);

export function mypy(input) {
  try {
    if (typeof input !== "string") return input;

    const clean = input.replace(ANSI, "");
    const lines = clean.split("\n");
    const errors = [];
    const filelessLines = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Skip mypy's own summary line
      if (line.startsWith("Found ") && line.includes(" error")) {
        i++;
        continue;
      }
      // Skip "Success: no issues found"
      if (line.startsWith("Success:")) {
        i++;
        continue;
      }

      const caps = RE_MYPY_DIAG.exec(line);
      if (caps) {
        const file = caps[1];
        const lineNum = parseInt(caps[2], 10) || 0;
        const severity = caps[3];
        const message = caps[4];
        const code = caps[5] || "";

        if (severity === "note") {
          // Attach note to preceding error if same file
          if (errors.length > 0 && errors[errors.length - 1].file === file) {
            errors[errors.length - 1].contextLines.push(message);
            i++;
            continue;
          }
          // Standalone note with no parent -- display as fileless
          filelessLines.push(line);
          i++;
          continue;
        }

        const err = {
          file,
          line: lineNum,
          code,
          message,
          contextLines: [],
        };

        // Capture continuation note lines
        i++;
        while (i < lines.length) {
          const nextCaps = RE_MYPY_DIAG.exec(lines[i]);
          if (nextCaps && nextCaps[3] === "note" && nextCaps[1] === err.file) {
            err.contextLines.push(nextCaps[4]);
            i++;
            continue;
          }
          break;
        }

        errors.push(err);
      } else if (line.includes("error:") && line.trim().length > 0) {
        // File-less error (config errors, import errors)
        filelessLines.push(line);
        i++;
      } else {
        i++;
      }
    }

    if (errors.length === 0 && filelessLines.length === 0) {
      if (clean.includes("Success: no issues found") || clean.includes("no issues found")) {
        const res = "mypy: No issues found";
        return res.length < input.length ? res : input;
      }
      return input;
    }

    const byFile = new Map();
    const codeCounts = new Map();

    for (const err of errors) {
      if (!byFile.has(err.file)) byFile.set(err.file, []);
      byFile.get(err.file).push(err);
      if (err.code) {
        codeCounts.set(err.code, (codeCounts.get(err.code) || 0) + 1);
      }
    }

    let result = "";

    // File-less errors first
    for (const fl of filelessLines) {
      result += `${fl}\n`;
    }
    if (filelessLines.length > 0 && errors.length > 0) {
      result += "\n";
    }

    if (errors.length > 0) {
      result += `mypy: ${errors.length} errors in ${byFile.size} files\n`;

      if (codeCounts.size > 1) {
        const sortedCodes = Array.from(codeCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([code, count]) => `${code} (${count}x)`);
        result += `Top codes: ${sortedCodes.join(", ")}\n\n`;
      }

      const filesSorted = Array.from(byFile.entries()).sort(
        (a, b) => b[1].length - a[1].length
      );

      for (const [file, fileErrors] of filesSorted) {
        result += `${file} (${fileErrors.length} errors)\n`;
        for (const err of fileErrors) {
          if (!err.code) {
            result += `  L${err.line}: ${trunc(err.message, 120)}\n`;
          } else {
            result += `  L${err.line}: [${err.code}] ${trunc(err.message, 120)}\n`;
          }
          for (const ctx of err.contextLines) {
            result += `    ${trunc(ctx, 120)}\n`;
          }
        }
        result += "\n";
      }
    }

    const out = result.trim();
    if (!out || out.length >= input.length) return input;
    return out;
  } catch {
    return input;
  }
}

mypy.filterName = "mypy";
