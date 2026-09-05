import { describe, expect, it } from "vitest";
import { resolveUpstreamRoute } from "../../open-sse/handlers/chatCore/upstreamRoute.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

const PINNED = [];
for (const [alias, models] of Object.entries(PROVIDER_MODELS)) {
  if (!Array.isArray(PROVIDERS[alias]?.transports)) continue;
  for (const model of models || []) {
    if (model.targetFormat) PINNED.push({ alias, model });
  }
}

describe("upstream route: body format and transport agree", () => {
  it("covers model-pinned multi-endpoint providers", () => {
    expect(PINNED.length).toBeGreaterThan(0);
    expect(PINNED.map(({ alias, model }) => `${alias}/${model.id}`)).toEqual(
      expect.arrayContaining(["minimax/MiniMax-M3", "minimax-cn/MiniMax-M3"]),
    );
  });

  for (const { alias, model } of PINNED) {
    for (const sourceFormat of ["openai", "claude", "openai-responses"]) {
      it(`${alias}/${model.id}: ${sourceFormat} preserves supported source transport before model fallback`, () => {
        const sourceTransport = (!model.supportedFormats || model.supportedFormats.includes(sourceFormat))
          ? resolveTransport(alias, sourceFormat) : null;
        const expectedFormat = sourceTransport?.format || model.targetFormat;
        const route = resolveUpstreamRoute({ provider: alias, alias, model: model.id, sourceFormat, credentials: {} });
        expect(route.targetFormat).toBe(expectedFormat);
        expect(route.transport?.format).toBe(expectedFormat);
      });
    }
  }
});

describe("upstream route: unpinned source transport and guarded fallback", () => {
  const cases = [
    ["minimax", "MiniMax-M2.7", "openai", "openai", "openai"],
    ["minimax", "MiniMax-M2.7", "claude", "claude", "claude"],
    ["deepseek", "deepseek-chat", "claude", "claude", "claude"],
    ["opencode-go", "glm-5.2(max)", "claude", "openai", undefined],
    ["opencode-go", "minimax-m3(max)", "claude", "claude", "claude"],
    ["opencode-go", "muse-spark-1.3-contributor", "claude", "openai-responses", "openai-responses"],
    ["opencode-go", "muse-spark-1.3-contributor", "openai", "openai-responses", "openai-responses"],
  ];
  for (const [alias, model, sourceFormat, expectedFormat, expectedTransport] of cases) {
    it(`${alias}/${model} from ${sourceFormat} uses ${expectedFormat}`, () => {
      const route = resolveUpstreamRoute({ provider: alias, alias, model, sourceFormat, credentials: {} });
      expect(route.targetFormat).toBe(expectedFormat);
      expect(route.transport?.format).toBe(expectedTransport);
    });
  }
});
