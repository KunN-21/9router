import { describe, expect, it } from "vitest";
import { resolveUpstreamRoute } from "../../open-sse/handlers/chatCore/upstreamRoute.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";

const executor = new OpenCodeExecutor();

function route(model, sourceFormat) {
  const credentials = {};
  const { targetFormat, transport } = resolveUpstreamRoute({
    provider: "opencode",
    alias: "oc",
    model,
    sourceFormat,
    credentials,
  });
  if (transport) credentials.runtimeTransport = transport;
  const url = executor.buildUrl(model, true, 0, credentials);
  return { targetFormat, transport, url, runtimeTransport: credentials.runtimeTransport || null };
}

describe("OpenCode Free routing matrix", () => {
  const RESPONSES_URL = "https://opencode.ai/zen/v1/responses";
  const MESSAGES_URL = "https://opencode.ai/zen/v1/messages";
  const CHAT_URL = "https://opencode.ai/zen/v1/chat/completions";

  describe("Muse Spark 1.2 Free", () => {
    for (const suffix of ["", "(high)"]) {
      const model = `muse-spark-1.2-contributor-free${suffix}`;
      for (const fmt of ["openai", "claude", "openai-responses"]) {
        it(`${model} from ${fmt} routes to /responses with openai-responses format`, () => {
          const res = route(model, fmt);
          expect(res.targetFormat).toBe("openai-responses");
          expect(res.url).toBe(RESPONSES_URL);
          expect(res.runtimeTransport?.baseUrl).toBe(RESPONSES_URL);
        });
      }
    }
  });

  describe("Muse Spark 1.3 Free", () => {
    for (const suffix of ["", "(max)"]) {
      const model = `muse-spark-1.3-contributor-free${suffix}`;
      for (const fmt of ["openai", "claude", "openai-responses"]) {
        it(`${model} from ${fmt} routes to /responses with openai-responses format`, () => {
          const res = route(model, fmt);
          expect(res.targetFormat).toBe("openai-responses");
          expect(res.url).toBe(RESPONSES_URL);
          expect(res.runtimeTransport?.baseUrl).toBe(RESPONSES_URL);
        });
      }
    }
  });

  describe("Union Alpha (Claude target)", () => {
    for (const suffix of ["", "(high)"]) {
      const model = `union-alpha${suffix}`;
      for (const fmt of ["openai", "claude", "openai-responses"]) {
        it(`${model} from ${fmt} routes to /messages with claude format`, () => {
          const res = route(model, fmt);
          expect(res.targetFormat).toBe("claude");
          expect(res.url).toBe(MESSAGES_URL);
          expect(res.runtimeTransport).toBeNull();
        });
      }
    }
  });

  describe("Ordinary Chat / unknown pass-through model", () => {
    for (const suffix of ["", "(low)"]) {
      const model = `custom-chat-model${suffix}`;
      for (const fmt of ["openai", "claude", "openai-responses"]) {
        it(`${model} from ${fmt} routes to /chat/completions with openai format`, () => {
          const res = route(model, fmt);
          expect(res.targetFormat).toBe("openai");
          expect(res.url).toBe(CHAT_URL);
          expect(res.runtimeTransport).toBeNull();
        });
      }
    }
  });
});

describe("OpenCode Go transport routing (unlisted model regression)", () => {
  const RESPONSES_GO_URL = "https://opencode.ai/zen/go/v1/responses";
  const goExecutor = new OpenCodeGoExecutor();

  function routeGo(model, sourceFormat) {
    const credentials = {};
    const { targetFormat, transport } = resolveUpstreamRoute({
      provider: "opencode-go",
      alias: "ocg",
      model,
      sourceFormat,
      credentials,
    });
    if (transport) credentials.runtimeTransport = transport;
    const url = goExecutor.buildUrl(model, true, 0, credentials);
    return { targetFormat, transport, url, runtimeTransport: credentials.runtimeTransport || null };
  }

  for (const suffix of ["", "(high)"]) {
    const model = `unlisted-responses-model${suffix}`;
    it(`${model} from openai-responses client preserves responses passthrough transport`, () => {
      const res = routeGo(model, "openai-responses");
      expect(res.targetFormat).toBe("openai-responses");
      expect(res.url).toBe(RESPONSES_GO_URL);
      expect(res.runtimeTransport?.baseUrl).toBe(RESPONSES_GO_URL);
    });
  }
});
