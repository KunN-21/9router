import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

/**
 * Write a file atomically via temporary file and rename.
 * Creates parent directory if missing.
 */
export async function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const randomSuffix = crypto.randomBytes(4).toString("hex");
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${Date.now()}-${randomSuffix}`);
  await fs.writeFile(tmpPath, content, "utf-8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.copyFile(tmpPath, filePath);
      await fs.unlink(tmpPath).catch(() => {});
    } catch (copyErr) {
      await fs.unlink(tmpPath).catch(() => {});
      throw copyErr;
    }
  }
}

/**
 * Ensure a file path stays within the intended base directory (no traversal / symlink escape).
 */
export async function assertSafePath(targetPath, baseDir) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(baseDir);
  const isInside = resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
  if (!isInside) {
    throw new Error(`Path traversal detected: "${targetPath}" is outside "${baseDir}"`);
  }

  // Check if file or symlink exists and resolves safely
  try {
    const stat = await fs.lstat(resolvedTarget);
    if (stat.isSymbolicLink()) {
      const real = await fs.realpath(resolvedTarget);
      const realInside = real === resolvedBase || real.startsWith(resolvedBase + path.sep);
      if (!realInside) {
        throw new Error(`Symlink target points outside safe directory: "${real}"`);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

/**
 * Escape a string for safe inclusion as a YAML double-quoted scalar.
 * Disallows embedded newlines to prevent YAML block injection.
 */
export function safeYamlScalar(val) {
  if (typeof val !== "string") return '""';
  if (/[\r\n]/.test(val)) {
    throw new Error("YAML scalar cannot contain newline characters");
  }
  return JSON.stringify(val);
}
