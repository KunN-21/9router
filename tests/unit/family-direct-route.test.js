import { describe, it } from "vitest";
import assert from "node:assert";
import { resolveFamily, FAMILY_PROFILES } from "../../open-sse/providers/familyProfiles.js";
import { normalizeEdit, hashAnchor } from "../../open-sse/translator/formats/hashline.js";

describe("family profile registry", () => {
  it("resolveFamily matches version-agnostic", () => {
    assert.match(resolveFamily("gemini-3.8-flash")?.family, /gemini/);
    assert.match(resolveFamily("gemini-3.1-pro")?.family, /gemini/);
    assert.match(resolveFamily("gemini-3.6-flash")?.family, /gemini/);
    assert.equal(resolveFamily("muse-spark-1.3-contributor-free")?.family, "muse-spark");
    assert.match(resolveFamily("gpt-astra-6")?.family, /gpt/);
    assert.equal(resolveFamily("unknown-xyz-1.0"), null);
  });

  it("FAMILY_PROFILES is version-agnostic regex array", () => {
    assert.ok(Array.isArray(FAMILY_PROFILES));
    assert.ok(FAMILY_PROFILES.length >= 3);
    for (const e of FAMILY_PROFILES) {
      assert.ok(e.pattern instanceof RegExp);
      assert.ok(typeof e.family === "string");
      assert.ok(e.profile && typeof e.profile === "object");
    }
  });

  it("baseModelId strips thinking suffix", () => {
    assert.match(resolveFamily("gemini-3.8-flash(max)")?.family, /gemini/);
    assert.equal(resolveFamily("muse-spark-1.3-contributor-free (xhigh)")?.family, "muse-spark");
  });
});

describe("hashline edit normalize", () => {
  it("normalizeEdit trims trailing ws and CRLF fail-open", () => {
    assert.equal(normalizeEdit("hello   \r\n  "), "hello");
    assert.equal(normalizeEdit("line1  \nline2  "), "line1\nline2");
    assert.equal(normalizeEdit(null), null);
    assert.equal(normalizeEdit(123), 123);
  });

  it("hashAnchor slices to 64", () => {
    assert.equal(hashAnchor("a".repeat(100)).length, 64);
    assert.equal(hashAnchor("short"), "short");
  });
});

describe("translator family direct branch", () => {
  // ponytail: target VERTEX (no claude:vertex exact registered) — brief's
  // GEMINI target collides with the claude:gemini family key, so exact direct
  // fires pre-impl and RED is unobservable. Family branch ignores target.
  it("family direct bypasses pivot for claude:gemini with gemini-3.8-flash", async () => {
    const { translateRequest, register } = await import("../../open-sse/translator/index.js");
    const { FORMATS } = await import("../../open-sse/translator/formats.js");
    let directCalled = false;
    register(FORMATS.CLAUDE, "gemini", (model, body) => { directCalled = true; body._directHit = true; return body; });
    const body = { messages: [{ role: "user", content: "hi" }], tools: [] };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.VERTEX, "gemini-3.8-flash", body, true, null, null, null, [], null, null);
    assert.equal(directCalled, true);
    assert.equal(out._directHit, true);
  });

  it("fallback pivot when no family match", async () => {
    const { translateRequest } = await import("../../open-sse/translator/index.js");
    const { FORMATS } = await import("../../open-sse/translator/formats.js");
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.VERTEX, "unknown-xyz-1.0", body, true, null, null, null, [], null, null);
    assert.equal(out._directHit, undefined);
  });
});
