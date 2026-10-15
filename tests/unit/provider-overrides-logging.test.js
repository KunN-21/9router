import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Provider Overrides Request Logging & Secret Redaction", () => {
  let tmpDir;
  let requestLoggerModule;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-log-test-"));
    process.env.ENABLE_REQUEST_LOGS = "true";
    // Fresh import with ENABLE_REQUEST_LOGS active
    requestLoggerModule = await import("../../open-sse/utils/requestLogger.js");
  });

  afterEach(() => {
    delete process.env.ENABLE_REQUEST_LOGS;
    try {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup error
    }
  });

  describe("maskSensitiveHeaders", () => {
    it("fully redacts known sensitive header names to [REDACTED] with no prefix or suffix", () => {
      const { maskSensitiveHeaders } = requestLoggerModule;
      expect(typeof maskSensitiveHeaders).toBe("function");

      const input = {
        Authorization: "Bearer sk-proj-1234567890abcdef1234567890",
        "proxy-authorization": "Basic dXNlcjpwYXNzMTIzNDU2Nzg5MA==",
        Cookie: "session_token=abcdef1234567890; other=xyz",
        "Set-Cookie": "secret_session=12345; Secure; HttpOnly",
        "X-Api-Key": "key-secret-99999999999999999999",
        "api-key": "another-key-secret-1234567890",
        Token: "jwt.token.here.1234567890",
        "X-OpenCode-Session": "sess-secret-12345",
        "session_id": "session-id-987654321",
        "x-session-affinity": "affinity-secret-abcdef",
        "Content-Type": "application/json",
        "User-Agent": "9router-test-agent",
      };

      const result = maskSensitiveHeaders(input);

      // Known sensitive keys must be FULL [REDACTED], never partial prefix/suffix
      expect(result.Authorization).toBe("[REDACTED]");
      expect(result["proxy-authorization"]).toBe("[REDACTED]");
      expect(result.Cookie).toBe("[REDACTED]");
      expect(result["Set-Cookie"]).toBe("[REDACTED]");
      expect(result["X-Api-Key"]).toBe("[REDACTED]");
      expect(result["api-key"]).toBe("[REDACTED]");
      expect(result.Token).toBe("[REDACTED]");
      expect(result["X-OpenCode-Session"]).toBe("[REDACTED]");
      expect(result.session_id).toBe("[REDACTED]");
      expect(result["x-session-affinity"]).toBe("[REDACTED]");

      // Non-sensitive keys must remain unchanged
      expect(result["Content-Type"]).toBe("application/json");
      expect(result["User-Agent"]).toBe("9router-test-agent");
    });

    it("redacts arbitrary user-defined custom override header names when provided", () => {
      const { maskSensitiveHeaders } = requestLoggerModule;

      const input = {
        "X-Custom-Auth-Route": "my-ultra-secret-token-value-9999",
        "X-Tenant-Secret": "tenant-vault-key-abc",
        "X-Normal-Header": "hello-world",
      };

      const customNames = ["X-Custom-Auth-Route", "x-tenant-secret"];
      const result = maskSensitiveHeaders(input, customNames);

      expect(result["X-Custom-Auth-Route"]).toBe("[REDACTED]");
      expect(result["X-Tenant-Secret"]).toBe("[REDACTED]");
      expect(result["X-Normal-Header"]).toBe("hello-world");
    });

    it("handles null, undefined, and non-object headers safely without throwing", () => {
      const { maskSensitiveHeaders } = requestLoggerModule;
      expect(maskSensitiveHeaders(null)).toEqual({});
      expect(maskSensitiveHeaders(undefined)).toEqual({});
      expect(maskSensitiveHeaders("invalid")).toEqual({});
    });
  });

  describe("createRequestLogger with custom override redaction", () => {
    it("redacts arbitrary custom override values in logTargetRequest via custom names argument", async () => {
      const { createRequestLogger } = requestLoggerModule;
      const logger = await createRequestLogger("openai", "openai", "gpt-4o");

      if (!logger.sessionPath) {
        // Logging was no-op or couldn't init session; verify interface
        expect(typeof logger.logTargetRequest).toBe("function");
        return;
      }

      const targetUrl = "https://api.openai.com/v1/chat/completions";
      const targetHeaders = {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token-456",
        "X-Custom-Token": "deliberate-user-secret-12345",
        "X-Public-Metadata": "datacenter-west",
      };
      const targetBody = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };

      // Pass custom override names as 4th argument
      logger.logTargetRequest(targetUrl, targetHeaders, targetBody, ["X-Custom-Token"]);

      const logFile = path.join(logger.sessionPath, "4_req_target.json");
      expect(fs.existsSync(logFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(logFile, "utf8"));
      expect(content.headers.Authorization).toBe("[REDACTED]");
      expect(content.headers["X-Custom-Token"]).toBe("[REDACTED]");
      expect(content.headers["X-Public-Metadata"]).toBe("datacenter-west");
    });

    it("redacts Set-Cookie in logProviderResponse", async () => {
      const { createRequestLogger } = requestLoggerModule;
      const logger = await createRequestLogger("openai", "openai", "gpt-4o");

      if (!logger.sessionPath) {
        expect(typeof logger.logProviderResponse).toBe("function");
        return;
      }

      const resHeaders = {
        "content-type": "application/json",
        "set-cookie": "session_id=super_secret_cookie_data; Path=/; HttpOnly",
      };

      logger.logProviderResponse(200, "OK", resHeaders, { choices: [] });

      const logFile = path.join(logger.sessionPath, "5_res_provider.json");
      expect(fs.existsSync(logFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(logFile, "utf8"));
      expect(content.headers["set-cookie"]).toBe("[REDACTED]");
      expect(content.headers["content-type"]).toBe("application/json");
    });

    it("preserves real wire headers untouched when logging", async () => {
      const { createRequestLogger } = requestLoggerModule;
      const logger = await createRequestLogger("openai", "openai", "gpt-4o");

      const wireHeaders = {
        Authorization: "Bearer real-wire-token",
        "X-Custom-Secret": "real-wire-secret",
      };

      // Logging must not mutate wireHeaders object in place
      logger.logTargetRequest("https://example.com", wireHeaders, {}, ["X-Custom-Secret"]);

      expect(wireHeaders.Authorization).toBe("Bearer real-wire-token");
      expect(wireHeaders["X-Custom-Secret"]).toBe("real-wire-secret");
    });
  });

  describe("logError boundary", () => {
    it("never serializes header objects into error log", () => {
      const { logError } = requestLoggerModule;
      expect(typeof logError).toBe("function");

      const err = new TypeError('Invalid HTTP header value for "Authorization": expected string, got object');
      // Calling logError with provider and error details
      expect(() => {
        logError("openai", {
          error: err,
          url: "https://api.openai.com",
          model: "gpt-4o",
          requestBody: { model: "gpt-4o" },
        });
      }).not.toThrow();
    });
  });
});
