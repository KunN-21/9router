import { describe, it, expect, beforeAll } from "vitest";

describe("applyHeaderOverrides shared helper", () => {
  let applyHeaderOverrides = null;

  beforeAll(async () => {
    try {
      const mod = await import("open-sse/utils/headerOverrides.js");
      applyHeaderOverrides = mod.applyHeaderOverrides;
    } catch {
      applyHeaderOverrides = null;
    }
  });

  function getHelper() {
    expect(applyHeaderOverrides).not.toBeNull();
    expect(typeof applyHeaderOverrides).toBe("function");
    return applyHeaderOverrides;
  }

  it("exports applyHeaderOverrides as a callable function", () => {
    const fn = getHelper();
    expect(typeof fn).toBe("function");
  });

  it("returns exact same headers reference when overrides is undefined or missing", () => {
    const fn = getHelper();
    const headers = { "Content-Type": "application/json" };
    expect(fn(headers, undefined)).toBe(headers);
    expect(fn(headers)).toBe(headers);

    const nullProto = Object.create(null);
    nullProto["X-Foo"] = "bar";
    expect(fn(nullProto, undefined)).toBe(nullProto);

    const headersInstance = new Headers({ "X-Test": "1" });
    expect(fn(headersInstance, undefined)).toBe(headersInstance);
  });

  it("returns exact same headers reference when overrides is empty object", () => {
    const fn = getHelper();
    const headers = { "Content-Type": "application/json" };
    expect(fn(headers, {})).toBe(headers);
  });

  it("rejects non-object or null overrides with TypeError", () => {
    const fn = getHelper();
    const headers = { "Content-Type": "application/json" };

    expect(() => fn(headers, null)).toThrow(TypeError);
    expect(() => fn(headers, [])).toThrow(TypeError);
    expect(() => fn(headers, "string")).toThrow(TypeError);
    expect(() => fn(headers, 123)).toThrow(TypeError);
    expect(() => fn(headers, true)).toThrow(TypeError);
  });

  it("rejects non-string header values with TypeError and does not leak value", () => {
    const fn = getHelper();
    const headers = { "Content-Type": "application/json" };
    const secretValue = 99887766;

    let thrownError = null;
    try {
      fn(headers, { Authorization: secretValue });
    } catch (e) {
      thrownError = e;
    }
    expect(thrownError).toBeInstanceOf(TypeError);
    expect(thrownError.message).not.toContain(String(secretValue));
    expect(thrownError.message).toMatch(/string/i);

    expect(() => fn(headers, { "X-Test": null })).toThrow(TypeError);
    expect(() => fn(headers, { "X-Test": undefined })).toThrow(TypeError);
    expect(() => fn(headers, { "X-Test": {} })).toThrow(TypeError);
    expect(() => fn(headers, { "X-Test": [] })).toThrow(TypeError);
  });

  it("validates RFC token header names and rejects invalid names", () => {
    const fn = getHelper();
    const headers = {};

    expect(() => fn(headers, { "Bad Header": "val" })).toThrow(TypeError);
    expect(() => fn(headers, { "Bad:Header": "val" })).toThrow(TypeError);
    expect(() => fn(headers, { "Bad@Header": "val" })).toThrow(TypeError);
    expect(() => fn(headers, { "Bad/Header": "val" })).toThrow(TypeError);
  });

  it("rejects header names with CRLF without serializing CRLF into message", () => {
    const fn = getHelper();
    const headers = {};

    let thrown = null;
    try {
      fn(headers, { "Bad\r\nHeader": "val" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown.message).not.toContain("\r");
    expect(thrown.message).not.toContain("\n");
  });

  it("validates all entries before applying so invalid later entries prevent partial mutation", () => {
    const fn = getHelper();
    const headers = { "X-Original": "keep" };

    expect(() =>
      fn(headers, {
        "X-First-Valid": "ok",
        "X-Second-Invalid": 12345,
      })
    ).toThrow(TypeError);

    expect(headers).toEqual({ "X-Original": "keep" });
    expect(headers["X-First-Valid"]).toBeUndefined();
  });

  it("allows all valid HTTP tokens including Authorization, Cookie, Host and special tokens", () => {
    const fn = getHelper();
    const headers = {
      Authorization: "Bearer old",
      Cookie: "session=old",
      Host: "api.example.com",
    };
    const overrides = {
      Authorization: "Bearer new-secret",
      Cookie: "session=new-cookie",
      Host: "custom.upstream.internal",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": "1234",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
      "Proxy-Authorization": "Basic dGVzdDp0ZXN0",
      "x-custom'token": "single-quote-valid",
      "x-custom`token": "backtick-valid",
    };

    const result = fn(headers, overrides);
    expect(result.Authorization).toBe("Bearer new-secret");
    expect(result.Cookie).toBe("session=new-cookie");
    expect(result.Host).toBe("custom.upstream.internal");
    expect(result["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(result["Content-Length"]).toBe("1234");
    expect(result.Connection).toBe("keep-alive");
    expect(result["Transfer-Encoding"]).toBe("chunked");
    expect(result["Proxy-Authorization"]).toBe("Basic dGVzdDp0ZXN0");
    expect(result["x-custom'token"]).toBe("single-quote-valid");
    expect(result["x-custom`token"]).toBe("backtick-valid");

    expect(headers.Authorization).toBe("Bearer old");
    expect(headers.Cookie).toBe("session=old");
  });

  it("preserves empty string and HTAB on the wire while rejecting control characters and CRLF in values", () => {
    const fn = getHelper();
    const headers = { "X-Clear-Me": "default-val" };

    const result = fn(headers, {
      "X-Clear-Me": "",
      "X-Tab-Header": "value\twith\ttab",
    });

    expect(result["X-Clear-Me"]).toBe("");
    expect(result["X-Tab-Header"]).toBe("value\twith\ttab");

    expect(() => fn(headers, { "X-Inject": "Bearer foo\r\nInjected: true" })).toThrow(TypeError);
    expect(() => fn(headers, { "X-Inject": "Bearer foo\nInjected: true" })).toThrow(TypeError);
    expect(() => fn(headers, { "X-Inject": "Bearer foo\0NulByte" })).toThrow(TypeError);
  });

  it("performs case-insensitive deduplication where overrides win over existing casing", () => {
    const fn = getHelper();
    const headers = {
      Authorization: "Bearer old",
      "CONTENT-TYPE": "text/plain",
    };
    const overrides = {
      authorization: "Bearer new",
      "content-type": "application/json",
    };

    const result = fn(headers, overrides);
    expect(result.authorization).toBe("Bearer new");
    expect(result.Authorization).toBeUndefined();
    expect(result["content-type"]).toBe("application/json");
    expect(result["CONTENT-TYPE"]).toBeUndefined();
  });

  it("handles duplicate case-insensitive keys in overrides deterministically (last-write-wins)", () => {
    const fn = getHelper();
    const headers = {};
    const overrides = {
      "X-Dedupe-Test": "first-value",
      "x-dedupe-test": "second-value",
    };

    const result = fn(headers, overrides);
    expect(Object.keys(result)).toEqual(["x-dedupe-test"]);
    expect(result["x-dedupe-test"]).toBe("second-value");
  });

  it("creates independent cloned headers without mutating defaults or registry", () => {
    const fn = getHelper();
    const baseHeaders = Object.freeze({
      "X-Default": "immutable",
      "User-Agent": "9Router/1.0",
    });

    const result = fn(baseHeaders, {
      "X-Default": "overridden",
      "X-New": "added",
    });

    expect(result).not.toBe(baseHeaders);
    expect(result["X-Default"]).toBe("overridden");
    expect(result["X-New"]).toBe("added");
    expect(baseHeaders["X-Default"]).toBe("immutable");
  });

  it("handles prototype properties (__proto__, constructor, toString) safely without prototype pollution", () => {
    const fn = getHelper();
    const parsed = JSON.parse(
      '{"__proto__": "proto-val", "constructor": "ctor-val", "toString": "ts-val"}'
    );

    const result = fn({}, parsed);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__").value).toBe("proto-val");
    expect(result.constructor).toBe("ctor-val");
    expect(result.toString).toBe("ts-val");

    expect(({}).polluted).toBeUndefined();
    expect(typeof ({}).toString).toBe("function");
  });

  it("supports native Headers instances returning independent Headers", () => {
    const fn = getHelper();
    const baseHeaders = new Headers({
      "Content-Type": "text/plain",
      Authorization: "Bearer default",
    });

    const result = fn(baseHeaders, {
      "content-type": "application/json",
      "x-extra": "added",
    });

    expect(typeof Headers !== "undefined" && result instanceof Headers).toBe(true);
    expect(result).not.toBe(baseHeaders);
    expect(result.get("content-type")).toBe("application/json");
    expect(result.get("authorization")).toBe("Bearer default");
    expect(result.get("x-extra")).toBe("added");

    expect(baseHeaders.get("content-type")).toBe("text/plain");
    expect(baseHeaders.get("x-extra")).toBeNull();
  });

  it("supports null-prototype header dictionary objects", () => {
    const fn = getHelper();
    const nullProto = Object.create(null);
    nullProto["Authorization"] = "Bearer old";

    const result = fn(nullProto, { authorization: "Bearer new" });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result.authorization).toBe("Bearer new");
    expect(result.Authorization).toBeUndefined();
    expect(nullProto.Authorization).toBe("Bearer old");
  });

  it("supports unconstrained header counts (>20) and values (>8192 chars) synthetically", () => {
    const fn = getHelper();
    const overrides = {};
    for (let i = 0; i < 30; i++) {
      overrides[`X-Synthetic-Header-${i}`] = `value-${i}`;
    }
    const longValue = "A".repeat(10000);
    overrides["X-Long-Value"] = longValue;

    const result = fn({}, overrides);
    expect(Object.keys(result).length).toBe(31);
    expect(result["X-Synthetic-Header-29"]).toBe("value-29");
    expect(result["X-Long-Value"]).toBe(longValue);
  });
});
