import http from "node:http";

/**
 * Apply per-provider custom header overrides to outgoing request headers.
 *
 * Implements case-insensitive replacement with last-write-wins precedence,
 * prototype safety, independent cloning when overrides are present,
 * and pre-validation using native node:http token and value validators.
 *
 * @param {object|Headers|null|undefined} headers - Base request headers
 * @param {Record<string, string>|null|undefined} overrides - Header overrides dictionary
 * @returns {object|Headers} Updated headers (exact reference if no overrides, cloned if overrides applied)
 */
export function applyHeaderOverrides(headers, overrides) {
  // Fast path: missing or undefined overrides preserves exact headers reference
  if (overrides === undefined) {
    return headers;
  }

  // Reject invalid overrides container types
  if (overrides === null || Array.isArray(overrides) || typeof overrides !== "object") {
    throw new TypeError("Expected overrides to be a plain object dictionary");
  }

  const entries = Object.entries(overrides);
  if (entries.length === 0) {
    return headers;
  }

  // Pre-validate ALL entries before applying any mutations or allocations
  for (const [key, val] of entries) {
    if (typeof key !== "string" || /[\r\n]/.test(key)) {
      throw new TypeError("Invalid HTTP header name: contains CRLF characters or is not a string");
    }

    if (typeof http.validateHeaderName === "function") {
      http.validateHeaderName(key);
    }

    if (typeof val !== "string") {
      const safeKey = key.replace(/[\r\n\x00-\x1F\x7F]/g, "");
      throw new TypeError(`Invalid HTTP header value for "${safeKey}": expected string, got ${typeof val}`);
    }

    if (typeof http.validateHeaderValue === "function") {
      http.validateHeaderValue(key, val);
    }
  }

  // Support Web standard / undici Headers instances
  if (
    typeof Headers !== "undefined" &&
    (headers instanceof Headers || (headers && typeof headers.set === "function" && typeof headers.entries === "function"))
  ) {
    const result = typeof Headers === "function" ? new Headers() : new headers.constructor();
    if (typeof headers.entries === "function") {
      for (const [k, v] of headers.entries()) {
        result.set(k, v);
      }
    }
    for (const [ovKey, ovVal] of entries) {
      result.set(ovKey, ovVal);
    }
    return result;
  }

  // Plain JS object / null-prototype object headers
  const isNullProto = Boolean(headers && Object.getPrototypeOf(headers) === null);
  const result = isNullProto ? Object.create(null) : {};

  if (headers && typeof headers === "object") {
    for (const key of Object.keys(headers)) {
      Object.defineProperty(result, key, {
        value: headers[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  for (const [ovKey, ovVal] of entries) {
    const lowerKey = ovKey.toLowerCase();
    for (const existingKey of Object.keys(result)) {
      if (existingKey.toLowerCase() === lowerKey) {
        delete result[existingKey];
      }
    }
    Object.defineProperty(result, ovKey, {
      value: ovVal,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return result;
}

export default applyHeaderOverrides;
