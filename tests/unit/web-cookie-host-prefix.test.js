// `__Host-` cookies must NOT carry a Domain attribute (RFC 6265bis §4.1.3).
// Chromium validates the whole addCookies() batch, so one violating cookie
// rejected every cookie in it — muse.ai's `__Host-hatch_one_tap` did exactly
// that ("Invalid cookie fields") and blocked the whole provider. Playwright
// still requires a scope, so host-only cookies get a `url` instead of a Domain.
import { describe, expect, it } from "vitest";

import { cookieScope } from "../../open-sse/services/browserPool.js";
import { toMuseCookies } from "../../open-sse/executors/muse-web/session.js";

describe("cookieScope", () => {
  it("scopes __Host- cookies by url, with no Domain and no path", () => {
    expect(cookieScope("__Host-hatch_one_tap", ".muse.ai")).toEqual({ url: "https://muse.ai" });
  });

  it("keeps the leading-dot Domain and path for ordinary cookies", () => {
    expect(cookieScope("hatch_sess", ".muse.ai")).toEqual({ domain: ".muse.ai", path: "/" });
  });

  it("normalises a bare hostname into a dot-prefixed Domain", () => {
    expect(cookieScope("datr", "muse.ai")).toEqual({ domain: ".muse.ai", path: "/" });
  });

  it("does not treat a __Secure- cookie as host-only", () => {
    expect(cookieScope("__Secure-next-auth.session-token", ".chatgpt.com")).toEqual({
      domain: ".chatgpt.com",
      path: "/",
    });
  });

  // Playwright accepts a domain+path pair OR a url — never both — and rejects
  // the whole cookie otherwise ("Cookie should have either url or path").
  it("never mixes url with domain or path", () => {
    for (const [name, domain] of [
      ["__Host-hatch_one_tap", ".muse.ai"],
      ["hatch_sess", ".muse.ai"],
      ["__Secure-x", ".chatgpt.com"],
    ]) {
      const scope = cookieScope(name, domain);
      const hasUrl = "url" in scope;
      const hasPair = "domain" in scope || "path" in scope;
      expect(hasUrl && hasPair).toBe(false);
      expect(hasUrl || hasPair).toBe(true);
    }
  });
});

describe("toMuseCookies", () => {
  const header =
    "__Host-hatch_one_tap=abc; datr=24chars; hatch_native_auth_device=dev; hatch_sess=sess";
  const cookies = toMuseCookies(header);
  const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));

  it("keeps every cookie in the header", () => {
    expect(cookies.map((c) => c.name)).toEqual([
      "__Host-hatch_one_tap",
      "datr",
      "hatch_native_auth_device",
      "hatch_sess",
    ]);
  });

  it("gives the __Host- cookie a url scope and no Domain or path", () => {
    const host = byName["__Host-hatch_one_tap"];
    expect(host.url).toBe("https://muse.ai");
    expect(host).not.toHaveProperty("domain");
    expect(host).not.toHaveProperty("path");
    expect(host.secure).toBe(true);
  });

  it("keeps Domain on the other cookies", () => {
    expect(byName.hatch_sess.domain).toBe(".muse.ai");
    expect(byName.datr.domain).toBe(".muse.ai");
  });

  it("gives every cookie exactly one Playwright-acceptable scope", () => {
    for (const c of cookies) {
      const hasUrl = "url" in c;
      const hasPair = "domain" in c && "path" in c;
      expect(hasUrl !== hasPair).toBe(true);
    }
  });
});
