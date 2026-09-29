// Sinh index-only cho open-sse/providers/registry/index.js (Must-Fix 2).
//
// migrate-registry.mjs là migration schema Model-A destructive cho mọi file provider
// nên không dùng để regen index. Script này chỉ tất định hoá static import list:
//   - Giữ nguyên tên biến (p68z, p123, p125..p130), thứ tự, comment ẩn provider
//     (trae, windsurf, devin-cli) — không reorder alphabetical gây alias collision.
//   - File registry mới trên đĩa được append cuối với số p tiếp theo (max+1).
//   - Entry của file đã xoá khỏi đĩa bị loại bỏ.
// Chạy: node scripts/generate-registry-index.mjs [--check]
//   --check: exit 1 khi output khác file hiện tại (cổng CI), không ghi file.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = join(__dirname, "..", "open-sse", "providers", "registry");
const INDEX_PATH = join(REGISTRY_DIR, "index.js");
const CHECK = process.argv.includes("--check");

const ACTIVE_RE = /^import\s+(\w+)\s+from\s+"\.\/([^"]+)";\s*?\r?$/;
const COMMENTED_RE = /^\/\/\s*import\s+(\w+)\s+from\s+"\.\/([^"]+)";\s*?\r?$/;
const ENTRY_RE = /^\s*(\w+),\s*(?:\/\/.*)?\r?$/;
const NUM_RE = /^p(\d+)/;

const src = readFileSync(INDEX_PATH, "utf8");
const EOL = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(EOL);

const exportIdx = lines.findIndex((l) => l === "export default [");
if (exportIdx < 0) {
  console.error("Không tìm thấy khối export default [ trong index.js");
  process.exit(2);
}
const closeIdx = lines.findIndex((l, i) => i > exportIdx && l === "];");
if (closeIdx < 0) {
  console.error("Không tìm thấy dòng đóng ]; trong index.js");
  process.exit(2);
}

// Map file đĩa → var hiện tại (active + commented để tôn trọng provider ẩn).
const activeByFile = new Map();
const commentedFiles = new Set();
const importIdxByVar = new Map();
for (let i = 0; i < exportIdx; i++) {
  const a = ACTIVE_RE.exec(lines[i]);
  if (a) {
    activeByFile.set(a[2], a[1]);
    importIdxByVar.set(a[1], i);
    continue;
  }
  const c = COMMENTED_RE.exec(lines[i]);
  if (c) commentedFiles.add(c[2]);
}

// Entry var trong mảng export (giữ nguyên verbatim, kể cả dòng comment ẩn).
const entryVarByLine = new Map();
for (let i = exportIdx + 1; i < closeIdx; i++) {
  const m = ENTRY_RE.exec(lines[i]);
  if (m && !lines[i].trimStart().startsWith("//")) entryVarByLine.set(i, m[1]);
}

const diskFiles = readdirSync(REGISTRY_DIR)
  .filter((f) => f.endsWith(".js") && f !== "index.js")
  .sort();
const diskSet = new Set(diskFiles);

const added = [];
const removed = [];
for (const [file, v] of activeByFile) {
  if (!diskSet.has(file)) removed.push({ file, v });
}
const usedNums = [...activeByFile.values()]
  .map((v) => NUM_RE.exec(v))
  .filter(Boolean)
  .map((m) => Number(m[1]));
let nextNum = Math.max(...usedNums, 0) + 1;
const usedVars = new Set(activeByFile.values());
for (const file of diskFiles) {
  if (activeByFile.has(file) || commentedFiles.has(file)) continue;
  let v = `p${nextNum++}`;
  while (usedVars.has(v)) v = `p${nextNum++}`;
  usedVars.add(v);
  added.push({ file, v });
}

// Xoá từ dưới lên để giữ index ổn định.
const removedVars = new Set(removed.map((r) => r.v));
const dropLines = [];
for (const [v, idx] of importIdxByVar) {
  if (removedVars.has(v)) dropLines.push(idx);
}
for (const [idx, v] of entryVarByLine) {
  if (removedVars.has(v)) dropLines.push(idx);
}
dropLines.sort((a, b) => b - a);
for (const idx of dropLines) lines.splice(idx, 1);

// Chèn import mới sau dòng import cuối (kể cả import comment), entry mới trước ];.
if (added.length > 0) {
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ACTIVE_RE.test(lines[i]) || COMMENTED_RE.test(lines[i])) lastImport = i;
  }
  const importLines = added.map((a) => `import ${a.v} from "./${a.file}";`);
  lines.splice(lastImport + 1, 0, ...importLines);
  const close = lines.lastIndexOf("];");
  const entryLines = added.map((a) => `  ${a.v},`);
  lines.splice(close, 0, ...entryLines);
}

const output = lines.join(EOL);
if (output === src) {
  console.log("registry index in sync (không thay đổi).");
  process.exit(0);
}
if (CHECK) {
  for (const a of added) console.log(`+ ${a.v} <- ${a.file}`);
  for (const r of removed) console.log(`- ${r.v} <- ${r.file}`);
  console.error("registry index lệch khỏi đĩa (chạy không --check để ghi).");
  process.exit(1);
}
writeFileSync(INDEX_PATH, output, "utf8");
for (const a of added) console.log(`+ ${a.v} <- ${a.file}`);
for (const r of removed) console.log(`- ${r.v} <- ${r.file}`);
console.log("Đã ghi registry index (giữ nguyên thứ tự + comment ẩn).");
