import { describe, it } from "vitest";
import assert from "node:assert";
import { resolveFamily, FAMILY_PROFILES } from "../../open-sse/providers/familyProfiles.js";

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
