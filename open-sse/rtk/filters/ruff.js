// Port of Rust ruff_cmd filter (src_cmds_python_ruff_cmd.rs).
// Supports ruff check JSON (grouped by rule and file, capped at 50 violations, top rules, top files, fixable hint)
// and ruff format text ("would reformat", "left unchanged").

const CAP_WARNINGS = 10;
const MAX_VIOLATIONS = 50;
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 3) + "..." : s);

function compactPath(path) {
  const p = path.replace(/\\/g, "/");
  const srcPos = p.lastIndexOf("/src/");
  if (srcPos !== -1) return `src/${p.slice(srcPos + 5)}`;
  const libPos = p.lastIndexOf("/lib/");
  if (libPos !== -1) return `lib/${p.slice(libPos + 5)}`;
  const testPos = p.lastIndexOf("/tests/");
  if (testPos !== -1) return `tests/${p.slice(testPos + 7)}`;
  const slashPos = p.lastIndexOf("/");
  if (slashPos !== -1) return p.slice(slashPos + 1);
  return p;
}

export function ruffCheck(input) {
  try {
    if (typeof input !== "string") return input;
    const t = input.trim();
    if (!t.startsWith("[")) return input;

    let diagnostics;
    try {
      diagnostics = JSON.parse(t);
    } catch {
      return input;
    }
    if (!Array.isArray(diagnostics)) return input;

    if (diagnostics.length === 0) {
      const res = "Ruff: No issues found";
      return res.length < input.length ? res : input;
    }

    const totalIssues = diagnostics.length;
    const fixableCount = diagnostics.filter((d) => d && d.fix != null).length;

    const uniqueFiles = new Set(diagnostics.map((d) => d.filename || "unknown"));
    const totalFiles = uniqueFiles.size;

    const byRule = new Map();
    const byFile = new Map();

    for (const diag of diagnostics) {
      const code = diag.code || "unknown";
      byRule.set(code, (byRule.get(code) || 0) + 1);
      const file = diag.filename || "unknown";
      byFile.set(file, (byFile.get(file) || 0) + 1);
    }

    let result = `Ruff: ${totalIssues} issues in ${totalFiles} files`;
    if (fixableCount > 0) {
      result += ` (${fixableCount} fixable)`;
    }
    result += "\n";

    // Top rules
    const ruleCounts = Array.from(byRule.entries()).sort((a, b) => b[1] - a[1]);
    if (ruleCounts.length > 0) {
      result += "Top rules:\n";
      for (const [rule, count] of ruleCounts.slice(0, CAP_WARNINGS)) {
        result += `  ${rule} (${count}x)\n`;
      }
      result += "\n";
    }

    // Top files
    const fileCounts = Array.from(byFile.entries()).sort((a, b) => b[1] - a[1]);
    result += "Top files:\n";
    for (const [file, count] of fileCounts.slice(0, CAP_WARNINGS)) {
      result += `  ${compactPath(file)} (${count} issues)\n`;

      // Top 3 rules in this file
      const fileRules = new Map();
      for (const diag of diagnostics) {
        if ((diag.filename || "unknown") === file) {
          const code = diag.code || "unknown";
          fileRules.set(code, (fileRules.get(code) || 0) + 1);
        }
      }
      const fileRuleCounts = Array.from(fileRules.entries()).sort((a, b) => b[1] - a[1]);
      for (const [rule, rCount] of fileRuleCounts.slice(0, 3)) {
        result += `    ${rule} (${rCount})\n`;
      }
    }

    if (fileCounts.length > CAP_WARNINGS) {
      result += `\n... +${fileCounts.length - CAP_WARNINGS} more files\n`;
    }

    result += "\nViolations:\n";
    for (const diag of diagnostics.slice(0, MAX_VIOLATIONS)) {
      const loc = diag.location || { row: 0, column: 0 };
      const row = loc.row || 0;
      const col = loc.column || 0;
      const file = compactPath(diag.filename || "unknown");
      const msg = trunc((diag.message || "").trim(), 100);
      result += `  ${file}:${row}:${col} ${diag.code || ""} ${msg}\n`;
    }

    if (diagnostics.length > MAX_VIOLATIONS) {
      result += `  … +${diagnostics.length - MAX_VIOLATIONS} more\n`;
    }

    if (fixableCount > 0) {
      result += `\n[hint] Run \`ruff check --fix\` to auto-fix ${fixableCount} issues\n`;
    }

    const out = result.trim();
    if (!out || out.length >= input.length) return input;
    return out;
  } catch {
    return input;
  }
}

export function ruffFormat(input) {
  try {
    if (typeof input !== "string") return input;

    const filesToFormat = [];
    let filesChecked = 0;

    for (const line of input.split("\n")) {
      const trimmed = line.trim();
      const lower = trimmed.toLowerCase();

      if (lower.includes("would reformat:")) {
        const parts = trimmed.split(":");
        if (parts.length > 1) {
          filesToFormat.push(parts.slice(1).join(":").trim());
        }
      }

      if (lower.includes("left unchanged")) {
        const parts = trimmed.split(",");
        for (const part of parts) {
          const pLower = part.toLowerCase();
          if (pLower.includes("left unchanged")) {
            const words = part.trim().split(/\s+/);
            for (let i = 0; i < words.length; i++) {
              if ((words[i] === "file" || words[i] === "files") && i > 0) {
                const count = parseInt(words[i - 1], 10);
                if (!isNaN(count)) {
                  filesChecked = count;
                  break;
                }
              }
            }
            break;
          }
        }
      }
    }

    const lower = input.toLowerCase();
    if (filesToFormat.length === 0 && lower.includes("left unchanged")) {
      return "Ruff format: All files formatted correctly";
    }

    if (lower.includes("would reformat")) {
      let result = "";
      if (filesToFormat.length === 0) {
        result += "Ruff format: All files formatted correctly\n";
      } else {
        result += `Ruff format: ${filesToFormat.length} files need formatting\n`;
        for (let i = 0; i < Math.min(filesToFormat.length, CAP_WARNINGS); i++) {
          result += `${i + 1}. ${compactPath(filesToFormat[i])}\n`;
        }
        if (filesToFormat.length > CAP_WARNINGS) {
          result += `\n... +${filesToFormat.length - CAP_WARNINGS} more files\n`;
        }
        if (filesChecked > 0) {
          result += `\n${filesChecked} files already formatted\n`;
        }
        result += "\n[hint] Run `ruff format` to format these files\n";
      }
      return result.trim() || input;
    }

    return input;
  } catch {
    return input;
  }
}

export function ruff(input) {
  if (typeof input !== "string") return input;
  const t = input.trim();
  if (t.startsWith("[")) {
    return ruffCheck(input);
  }
  const lower = t.toLowerCase();
  if (lower.includes("would reformat") || lower.includes("left unchanged")) {
    return ruffFormat(input);
  }
  return input;
}

ruff.filterName = "ruff";
ruffCheck.filterName = "ruff-check";
ruffFormat.filterName = "ruff-format";
