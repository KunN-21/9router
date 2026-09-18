export function normalizeEdit(s) {
  if (typeof s !== "string") return s;
  return s.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trimEnd();
}

export function hashAnchor(c) {
  return String(c).slice(0, 64);
}
