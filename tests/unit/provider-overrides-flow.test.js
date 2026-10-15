import { describe, it, expect, vi, beforeEach } from "vitest";

import { BaseExecutor } from "../../open-sse/executors/base.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";
import * as zedAuthModule from "../../open-sse/shared/zedAuth.js";
import * as qoderModelsModule from "../../open-sse/services/qoderModels.js";

describe("Provider Overrides Flow & Transport Verification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("BaseExecutor header overrides integration", () => {
    it("preserves exact default headers reference when providerOverrides is null or undefined (nooverride)", async () => {
      const executor = new DefaultExecutor("openai");
      let capturedHeaders = null;

      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      const creds = { apiKey: "test-key" };
      await executor.execute({
        model: "openai/gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: creds,
        providerOverrides: null,
      });

      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders["Authorization"]).toBe("Bearer test-key");
      expect(capturedHeaders["Content-Type"]).toBe("application/json");
    });

    it("applies user overrides with last-write-wins and case-insensitive replacement", async () => {
      const executor = new DefaultExecutor("openai");
      let capturedHeaders = null;

      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      const creds = { apiKey: "default-api-key" };
      await executor.execute({
        model: "openai/gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: creds,
        providerOverrides: {
          headers: {
            "authorization": "Bearer user-custom-token-999",
            "X-Custom-Routing": "cluster-east-1",
          },
        },
      });

      expect(capturedHeaders).not.toBeNull();
      // Case-insensitive deduplication: old "Authorization" is removed, "authorization" is present
      expect(capturedHeaders["authorization"]).toBe("Bearer user-custom-token-999");
      expect(capturedHeaders["Authorization"]).toBeUndefined();
      expect(capturedHeaders["X-Custom-Routing"]).toBe("cluster-east-1");
    });

    it("permits sensitive headers unblocked (Authorization, Cookie, Host, Content-Type, hop-by-hop)", async () => {
      const executor = new DefaultExecutor("openai");
      let capturedHeaders = null;

      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      await executor.execute({
        model: "openai/gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "base-key" },
        providerOverrides: {
          headers: {
            "Host": "api.custom-proxy.internal",
            "Cookie": "session=custom-12345",
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": "42",
            "Connection": "keep-alive",
            "Transfer-Encoding": "chunked",
            "Proxy-Authorization": "Basic dXNlcjpwYXNz",
          },
        },
      });

      expect(capturedHeaders["Host"]).toBe("api.custom-proxy.internal");
      expect(capturedHeaders["Cookie"]).toBe("session=custom-12345");
      expect(capturedHeaders["Content-Type"]).toBe("application/json; charset=utf-8");
      expect(capturedHeaders["Content-Length"]).toBe("42");
      expect(capturedHeaders["Connection"]).toBe("keep-alive");
      expect(capturedHeaders["Transfer-Encoding"]).toBe("chunked");
      expect(capturedHeaders["Proxy-Authorization"]).toBe("Basic dXNlcjpwYXNz");
    });

    it("preserves empty string values on wire", async () => {
      const executor = new DefaultExecutor("openai");
      let capturedHeaders = null;

      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      await executor.execute({
        model: "openai/gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "base-key" },
        providerOverrides: {
          headers: {
            "X-Blank-Header": "",
          },
        },
      });

      expect(capturedHeaders["X-Blank-Header"]).toBe("");
    });

    it("handles prototype-named keys safely without pollution", async () => {
      const executor = new DefaultExecutor("openai");
      let capturedHeaders = null;

      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      await executor.execute({
        model: "openai/gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "base-key" },
        providerOverrides: {
          headers: {
            "constructor": "valid-header-val",
            "toString": "another-val",
          },
        },
      });

      expect(capturedHeaders["constructor"]).toBe("valid-header-val");
      expect(capturedHeaders["toString"]).toBe("another-val");
      expect(Object.prototype.toString).toBeInstanceOf(Function);
    });

    it("strictly validates and throws TypeError before network when override value is not string", async () => {
      const executor = new DefaultExecutor("openai");
      let fetchCalled = false;

      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      await expect(
        executor.execute({
          model: "openai/gpt-4o",
          body: { messages: [{ role: "user", content: "hi" }] },
          stream: false,
          credentials: { apiKey: "base-key" },
          providerOverrides: {
            headers: {
              "X-Bad-Header": 12345,
            },
          },
        })
      ).rejects.toThrow(TypeError);

      expect(fetchCalled).toBe(false);
    });

    it("strictly validates and throws TypeError before network on invalid header name with CRLF", async () => {
      const executor = new DefaultExecutor("openai");
      let fetchCalled = false;

      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      await expect(
        executor.execute({
          model: "openai/gpt-4o",
          body: { messages: [{ role: "user", content: "hi" }] },
          stream: false,
          credentials: { apiKey: "base-key" },
          providerOverrides: {
            headers: {
              "X-Injected\r\nInjected: bad": "value",
            },
          },
        })
      ).rejects.toThrow(TypeError);

      expect(fetchCalled).toBe(false);
    });

    it("preserves custom header overrides across 502/503 transport retries", async () => {
      const executor = new DefaultExecutor("openai");
      const callHeaders = [];

      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        callHeaders.push(opts?.headers);
        if (callHeaders.length === 1) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      executor.config = { ...executor.config, retry: { "503": { attempts: 1, delayMs: 1 } } };

      await executor.execute({
        model: "openai/gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "base-key" },
        providerOverrides: {
          headers: {
            "X-Attempt-Header": "must-survive-retry",
          },
        },
      });

      expect(callHeaders.length).toBeGreaterThanOrEqual(2);
      expect(callHeaders[0]["X-Attempt-Header"]).toBe("must-survive-retry");
      expect(callHeaders[1]["X-Attempt-Header"]).toBe("must-survive-retry");
    });

    it("supports >20 headers and >8192 value length without artificial application caps", async () => {
      const executor = new DefaultExecutor("openai");
      let capturedHeaders = null;

      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      const bigOverrides = {};
      for (let i = 0; i < 25; i++) {
        bigOverrides[`X-Custom-Header-${i}`] = `value-${i}`;
      }
      const longVal = "A".repeat(9000);
      bigOverrides["X-Large-Value"] = longVal;

      await executor.execute({
        model: "openai/gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "base-key" },
        providerOverrides: {
          headers: bigOverrides,
        },
      });

      expect(capturedHeaders).not.toBeNull();
      expect(Object.keys(capturedHeaders).length).toBeGreaterThanOrEqual(26);
      expect(capturedHeaders["X-Large-Value"]).toBe(longVal);
      expect(capturedHeaders["X-Custom-Header-24"]).toBe("value-24");
    });
  });

  describe("Special Executors Dispatch Verification", () => {
    it("CursorExecutor applies providerOverrides to execute and executeAgent", async () => {
      const { CursorExecutor } = await import("../../open-sse/executors/cursor.js");
      const executor = new CursorExecutor();

      let makeFetchHeaders = null;
      executor.makeFetchRequest = vi.fn(async (_url, headers) => {
        makeFetchHeaders = headers;
        return { status: 200, body: Buffer.from("ok") };
      });

      // Non-agent request with image part routes to makeFetchRequest
      await executor.execute({
        model: "cu/composer-2.5",
        body: {
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "data:image/png;base64,123" } }],
            },
          ],
        },
        stream: false,
        proxyOptions: { enabled: true },
        credentials: { accessToken: "cursor-key", providerSpecificData: { machineId: "mock-mid" } },
        providerOverrides: {
          headers: { "X-Cursor-Custom": "override-val" },
        },
      });

      expect(makeFetchHeaders).not.toBeNull();
      expect(makeFetchHeaders["X-Cursor-Custom"]).toBe("override-val");

      // executeAgent path
      let agentStreamHeaders = null;
      executor.openAgentHttp2Stream = vi.fn((_url, headers) => {
        agentStreamHeaders = headers;
        return {
          responseHeaders: Promise.resolve({ ":status": 200 }),
          write: vi.fn(),
          end: vi.fn(),
          close: vi.fn(),
          read: vi.fn().mockResolvedValue({ value: undefined, done: true }),
        };
      });

      await executor.executeAgent({
        model: "cursor/auto-agent",
        body: {
          messages: [{ role: "user", content: "test" }],
          tools: [{ type: "function", function: { name: "test_tool" } }],
        },
        stream: false,
        credentials: { accessToken: "cursor-key", providerSpecificData: { machineId: "mock-mid" } },
        providerOverrides: {
          headers: { "X-Agent-Custom": "agent-override" },
        },
      });

      expect(agentStreamHeaders).not.toBeNull();
      expect(agentStreamHeaders["X-Agent-Custom"]).toBe("agent-override");
    });

    it("GithubExecutor applies providerOverrides to responses and messages endpoints", async () => {
      const { GithubExecutor } = await import("../../open-sse/executors/github.js");
      const executor = new GithubExecutor();

      let fetchOpts = null;
      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        fetchOpts = opts;
        return new Response("ok", { status: 200 });
      });

      await executor.executeWithResponsesEndpoint({
        model: "github/gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { copilotToken: "token-123" },
        providerOverrides: {
          headers: { "X-Github-Custom": "responses-route" },
        },
      });

      expect(fetchOpts).not.toBeNull();
      expect(fetchOpts.headers["X-Github-Custom"]).toBe("responses-route");

      fetchOpts = null;
      await executor.executeWithMessagesEndpoint({
        model: "github/claude-3-5-sonnet",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { copilotToken: "token-123" },
        providerOverrides: {
          headers: { "X-Github-Custom": "messages-route" },
        },
      });

      expect(fetchOpts).not.toBeNull();
      expect(fetchOpts.headers["X-Github-Custom"]).toBe("messages-route");
    });

    it("VertexExecutor applies providerOverrides to REST fetch headers", async () => {
      const { default: VertexExecutor } = await import("../../open-sse/executors/vertex.js");
      const executor = new VertexExecutor();

      let fetchOpts = null;
      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        fetchOpts = opts;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      await executor.execute({
        model: "vertex/gemini-1.5-pro",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: {
          accessToken: "ya29.test-token",
          providerSpecificData: { projectId: "test-proj", region: "us-central1" },
        },
        providerOverrides: {
          headers: { "X-Vertex-Trace": "trace-987" },
        },
      });

      expect(fetchOpts).not.toBeNull();
      expect(fetchOpts.headers["X-Vertex-Trace"]).toBe("trace-987");
    });

    it("WindsurfExecutor applies providerOverrides to gRPC-Web fetch headers", async () => {
      const { WindsurfExecutor } = await import("../../open-sse/executors/windsurf.js");
      const executor = new WindsurfExecutor();

      let fetchOpts = null;
      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        fetchOpts = opts;
        return new Response(new Uint8Array([0, 0, 0, 0, 0]), { status: 200 });
      });

      await executor.execute({
        model: "windsurf/cascade-v1",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "ws-key" },
        providerOverrides: {
          headers: { "X-Windsurf-Custom": "ws-override-val" },
        },
      });

      expect(fetchOpts).not.toBeNull();
      expect(fetchOpts.headers["X-Windsurf-Custom"]).toBe("ws-override-val");
    });

    it("TraeExecutor applies providerOverrides to session headers", async () => {
      const traeModule = await import("../../open-sse/executors/trae.js");
      const TraeClass = traeModule.default || traeModule.TraeExecutor;
      const executor = new TraeClass();

      let sessionHeaders = null;
      executor.createSession = vi.fn(async (headers) => {
        sessionHeaders = headers;
        return { sessionId: "sess-1", messageId: "msg-1" };
      });
      executor.streamEvents = vi.fn(async () => {});

      await executor.execute({
        model: "trae/claude-3-5-sonnet",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "trae-token" },
        providerOverrides: {
          headers: { "X-Trae-Routing": "route-alpha" },
        },
      });

      expect(sessionHeaders).not.toBeNull();
      expect(sessionHeaders["X-Trae-Routing"]).toBe("route-alpha");
    });

    it("MimoFreeExecutor applies providerOverrides to chat request without altering bootstrap", async () => {
      const { MimoFreeExecutor } = await import("../../open-sse/executors/mimo-free.js");
      const executor = new MimoFreeExecutor();

      let fetchCalls = [];
      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (url, opts) => {
        fetchCalls.push({ url, opts });
        if (url.includes("/token") || url.includes("/auth") || url.includes("bootstrap")) {
          return new Response(JSON.stringify({ jwt: "mock-bootstrap-jwt" }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      await executor.execute({
        model: "mimo-free/mimo-v1",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: {},
        providerOverrides: {
          headers: { "X-Mimo-Client": "custom-client-id" },
        },
      });

      expect(fetchCalls.length).toBeGreaterThan(0);
      const chatCall = fetchCalls[fetchCalls.length - 1];
      expect(chatCall.opts.headers["X-Mimo-Client"]).toBe("custom-client-id");
    });

    it("PerplexityWebExecutor applies providerOverrides to SSE chat fetch headers", async () => {
      const { PerplexityWebExecutor } = await import("../../open-sse/executors/perplexity-web.js");
      const executor = new PerplexityWebExecutor();

      let fetchOpts = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, opts) => {
        fetchOpts = opts;
        return new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
      });

      try {
        await executor.execute({
          model: "perplexity-web/sonar",
          body: { messages: [{ role: "user", content: "hi" }] },
          stream: false,
          credentials: { accessToken: "pplx-token" },
          providerOverrides: {
            headers: { "X-Pplx-Custom": "custom-cookie-proxy" },
          },
        });

        expect(fetchOpts).not.toBeNull();
        expect(fetchOpts.headers["X-Pplx-Custom"]).toBe("custom-cookie-proxy");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("GrokWebExecutor applies providerOverrides to chat API fetch headers", async () => {
      const { GrokWebExecutor } = await import("../../open-sse/executors/grok-web.js");
      const executor = new GrokWebExecutor();

      let fetchOpts = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, opts) => {
        fetchOpts = opts;
        return new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
      });

      try {
        await executor.execute({
          model: "grok-web/grok-2",
          body: { messages: [{ role: "user", content: "hi" }] },
          stream: false,
          credentials: { apiKey: "sso=custom-sso-cookie" },
          providerOverrides: {
            headers: { "X-Grok-Header": "grok-test" },
          },
        });

        expect(fetchOpts).not.toBeNull();
        expect(fetchOpts.headers["X-Grok-Header"]).toBe("grok-test");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("ZedExecutor applies providerOverrides in fetchOptions headers and returns effective headers", async () => {
      const zedModule = await import("../../open-sse/executors/zed.js");
      const ZedClass = zedModule.default || zedModule.ZedExecutor;
      const executor = new ZedClass();

      let zedFetchOptions = null;
      vi.spyOn(zedAuthModule, "zedLlmFetch").mockImplementation(async (_creds, _path, options) => {
        zedFetchOptions = options?.fetchOptions;
        return new Response("ok", { status: 200 });
      });

      const result = await executor.execute({
        model: "zed/claude-3-5-sonnet",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { accessToken: "zed-token" },
        providerOverrides: {
          headers: { "X-Zed-Custom-Feature": "enabled" },
        },
      });

      expect(zedFetchOptions).not.toBeNull();
      expect(zedFetchOptions.headers["X-Zed-Custom-Feature"]).toBe("enabled");
      expect(result.headers["X-Zed-Custom-Feature"]).toBe("enabled");
    });

    it("zedLlmFetch preserves custom Authorization override and avoids duplicate headers", async () => {
      const zedAuth = await import("../../open-sse/shared/zedAuth.js");

      let capturedCompletionsHeaders = null;
      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (url, opts) => {
        if (url.includes("/client/llm_tokens")) {
          return new Response(JSON.stringify({ token: "generated-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        capturedCompletionsHeaders = opts?.headers;
        return new Response("ok", { status: 200 });
      });

      const creds = {
        userId: "u1",
        accessToken: "tok1",
        providerSpecificData: { organizationId: "org-1" },
      };

      // 1. Exact case Authorization override -> must NOT clobber override
      await zedAuth.zedLlmFetch(creds, "/completions", {
        fetchOptions: {
          headers: { Authorization: "Bearer custom-pat" },
        },
      });
      expect(capturedCompletionsHeaders.Authorization).toBe("Bearer custom-pat");

      // 2. Lowercase authorization override -> must NOT send duplicate Authorization: Bearer generated-token
      await zedAuth.zedLlmFetch(creds, "/completions", {
        fetchOptions: {
          headers: { authorization: "Bearer custom-pat-lower" },
        },
      });
      expect(capturedCompletionsHeaders.authorization).toBe("Bearer custom-pat-lower");
      expect(capturedCompletionsHeaders.Authorization).toBeUndefined();

      // 3. No auth override -> fetches and uses generated token
      await zedAuth.zedLlmFetch(creds, "/completions", {
        fetchOptions: {
          headers: { "Content-Type": "application/json" },
        },
      });
      expect(capturedCompletionsHeaders.Authorization).toBe("Bearer generated-token");
    });

    it("QoderExecutor applies providerOverrides to signed fetch headers", async () => {
      const { QoderExecutor } = await import("../../open-sse/executors/qoder.js");
      const executor = new QoderExecutor();

      vi.spyOn(qoderModelsModule, "getQoderModelConfig").mockResolvedValue({ source: "system", key: "qoder-code" });
      vi.spyOn(qoderModelsModule, "resolveQoderModels").mockResolvedValue({ rawConfigs: new Map([["qoder-code", { source: "system" }]]) });

      let fetchOpts = null;
      vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, opts) => {
        fetchOpts = opts;
        return new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
      });

      await executor.execute({
        model: "qoder/qoder-code",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: {
          accessToken: "tok",
          providerSpecificData: { userId: "user-123" },
        },
        providerOverrides: {
          headers: { "X-Qoder-Custom": "custom-cosy" },
        },
      });

      expect(fetchOpts).not.toBeNull();
      expect(fetchOpts.headers["X-Qoder-Custom"]).toBe("custom-cosy");
    });

    it("DevinCliExecutor throws TransportError when nonempty headers are passed before spawn", async () => {
      const { DevinCliExecutor } = await import("../../open-sse/executors/devin-cli.js");
      const executor = new DevinCliExecutor();

      let err = null;
      try {
        await executor.execute({
          model: "devin/devin",
          body: { messages: [{ role: "user", content: "hi" }] },
          credentials: {},
          providerOverrides: {
            headers: { "X-Devin-Header": "will-fail" },
          },
        });
      } catch (e) {
        err = e;
      }

      expect(err).not.toBeNull();
      expect(err.name).toBe("TransportError");
      expect(err.message).toContain("Devin CLI uses stdio subprocess transport");
    });
  });

  describe("chatCore and chat.js Dispatch Pipeline", () => {
    it("handleChatCore passes providerOverrides to executor.execute and refreshWithRetry", async () => {
      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

      let executeCalls = [];
      const mockExecutor = {
        noAuth: false,
        execute: vi.fn(async (opts) => {
          executeCalls.push(opts);
          if (executeCalls.length === 1) {
            return {
              response: new Response("Unauthorized", { status: 401 }),
              url: "https://api.openai.com/v1/chat/completions",
              headers: {},
              transformedBody: {},
            };
          }
          return {
            response: new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
            url: "https://api.openai.com/v1/chat/completions",
            headers: {},
            transformedBody: {},
          };
        }),
        refreshCredentials: vi.fn(async (creds) => ({ ...creds, accessToken: "new-access-token" })),
      };

      const getExecutorModule = await import("../../open-sse/executors/index.js");
      vi.spyOn(getExecutorModule, "getExecutor").mockReturnValue(mockExecutor);

      const customOverrides = {
        headers: { "X-Custom-Auth": "persistent-across-refresh" },
      };

      await handleChatCore({
        body: { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] },
        modelInfo: { provider: "openai", model: "gpt-4o" },
        credentials: { accessToken: "old-access-token" },
        providerOverrides: customOverrides,
      });

      expect(executeCalls.length).toBe(2);
      expect(executeCalls[0].providerOverrides).toEqual(customOverrides);
      expect(executeCalls[1].providerOverrides).toEqual(customOverrides);
    });

    it("handleSingleModelChat isolates providerOverrides across combo models and does not mutate body", async () => {
      const chatModule = await import("../../src/sse/handlers/chat.js");
      const authModule = await import("../../src/sse/services/auth.js");
      const localDbModule = await import("../../src/lib/localDb.js");
      const chatCoreModule = await import("../../open-sse/handlers/chatCore.js");

      const handleChatCoreSpy = vi.spyOn(chatCoreModule, "handleChatCore").mockResolvedValue({
        success: true,
        response: new Response("OK", { status: 200 }),
      });

      vi.spyOn(authModule, "getProviderCredentials").mockResolvedValue({
        connectionId: "c1",
        apiKey: "k1",
      });

      vi.spyOn(localDbModule, "getSettings").mockResolvedValue({
        providerOverrides: {
          openai: {
            headers: { "X-OpenAI-Only": "val-a" },
          },
          deepseek: {
            headers: { "X-DeepSeek-Only": "val-b" },
          },
        },
      });

      const req = new Request("http://localhost:20128/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "user-agent": "test-agent" },
        body: JSON.stringify({
          model: "openai/gpt-4o",
          messages: [{ role: "user", content: "test" }],
        }),
      });

      await chatModule.handleChat(req);

      expect(handleChatCoreSpy).toHaveBeenCalled();
      const callArgs = handleChatCoreSpy.mock.calls[0][0];

      expect(callArgs.providerOverrides).toEqual({
        headers: { "X-OpenAI-Only": "val-a" },
      });
    });
  });
});
