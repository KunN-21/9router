// Port of Rust prettier_cmd filter (src_cmds_js_prettier_cmd.rs).
// Check mode: "Prettier: N files need formatting", cap 10, "+N more files".
// All formatted: "Prettier: All files formatted correctly".
// Write mode: "Prettier: N files formatted".
// Empty/whitespace: "Error: prettier produced no output".

const CAP_WARNINGS = 10;
const FILE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".scss"];

export function prettier(input) {
  try {
    if (typeof input !== "string") return input;
    if (input.trim().length === 0) {
      return "Error: prettier produced no output";
    }

    const filesToFormat = [];
    let filesChecked = 0;
    let isCheckMode = true;
    let hasPrettierMarker = false;

    for (const line of input.split("\n")) {
      const trimmed = line.trim();

      if (trimmed.includes("Checking formatting")) {
        isCheckMode = true;
        hasPrettierMarker = true;
      }

      if (
        trimmed.length > 0 &&
        !trimmed.startsWith("Checking") &&
        !trimmed.startsWith("All matched") &&
        !trimmed.startsWith("Code style") &&
        !trimmed.includes("[warn]") &&
        !trimmed.includes("[error]") &&
        FILE_EXTS.some((ext) => trimmed.endsWith(ext))
      ) {
        filesToFormat.push(trimmed);
      }

      if (trimmed.includes("All matched files use Prettier")) {
        hasPrettierMarker = true;
        const countStr = trimmed.split(/\s+/)[0];
        const count = parseInt(countStr, 10);
        if (!isNaN(count)) {
          filesChecked = count;
        }
      }
    }

    if (input.includes("Code style issues found")) {
      hasPrettierMarker = true;
    }

    if (input.includes("modified") || input.includes("formatted")) {
      isCheckMode = false;
      hasPrettierMarker = true;
    }

    if (filesToFormat.length === 0 && input.includes("All matched files use Prettier")) {
      const res = "Prettier: All files formatted correctly";
      return res.length < input.length ? res : input;
    }

    if (!hasPrettierMarker && filesToFormat.length === 0) {
      return input;
    }

    let result = "";

    if (isCheckMode) {
      if (filesToFormat.length === 0) {
        result += "Prettier: All files formatted correctly\n";
      } else {
        result += `Prettier: ${filesToFormat.length} files need formatting\n`;
        for (let i = 0; i < Math.min(filesToFormat.length, CAP_WARNINGS); i++) {
          result += `${i + 1}. ${filesToFormat[i]}\n`;
        }
        if (filesToFormat.length > CAP_WARNINGS) {
          result += `\n... +${filesToFormat.length - CAP_WARNINGS} more files\n`;
        }
        if (filesChecked > 0) {
          result += `\n${filesChecked - filesToFormat.length} files already formatted\n`;
        }
      }
    } else {
      result += `Prettier: ${filesToFormat.length} files formatted\n`;
    }

    const out = result.trim();
    if (!out || out.length >= input.length) return input;
    return out;
  } catch {
    return input;
  }
}

prettier.filterName = "prettier";
