import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async () => ({ key: "auto", max_output_tokens: 32 })),
  resolveQoderModels: vi.fn(),
  isQoderPat: (token) => typeof token === "string" && token.startsWith("pt-"),
  resolveQoderCredentials: vi.fn(async (creds) => ({
    ...creds,
    accessToken: "jt-cn-token",
    providerSpecificData: { userId: "user-cn", machineId: "mach-cn" },
  })),
}));

import { QoderExecutor } from "../../open-sse/executors/qoder.js";
import { QoderService } from "../../src/lib/oauth/services/qoder.js";
import { QODER_CN_CONFIG } from "../../src/lib/oauth/constants/oauth.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import {
  qoderRegionOf,
  qoderInferenceBase,
  qoderJobTokenExchangeUrl,
  qoderModelListUrl,
  qoderQuotaUsageUrl,
} from "../../open-sse/shared/qoder/constants.js";

describe("Qoder CN (qoder.com.cn) integration & contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("Regional endpoint and config contracts", () => {
    it("identifies qoder-cn region correctly", () => {
      expect(qoderRegionOf("qoder-cn")).toBe("cn");
      expect(qoderRegionOf("qoder")).toBe("intl");
      expect(qoderRegionOf("other")).toBe("intl");
    });

    it("routes job token exchange, model list, and quota usage to CN endpoints", () => {
      expect(qoderJobTokenExchangeUrl("cn")).toBe("https://openapi.qoder.com.cn/api/v1/jobToken/exchange");
      expect(qoderModelListUrl("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v2/model/list");
      expect(qoderQuotaUsageUrl("cn")).toBe("https://openapi.qoder.com.cn/api/v2/quota/usage");
    });

    it("routes all token types (dt-, jt-) to CN gateway", () => {
      expect(qoderInferenceBase({ accessToken: "dt-token" }, "cn")).toBe("https://gateway.qoder.com.cn");
      expect(qoderInferenceBase({ accessToken: "jt-token" }, "cn")).toBe("https://gateway.qoder.com.cn");
    });

    it("infers CN gateway from credentials.provider when region argument is omitted (FINDING-1)", () => {
      expect(qoderInferenceBase({ provider: "qoder-cn", accessToken: "dt-token" })).toBe("https://gateway.qoder.com.cn");
      expect(qoderInferenceBase({ provider: "qoder-cn", accessToken: "jt-token" })).toBe("https://gateway.qoder.com.cn");
      expect(qoderInferenceBase({ provider: "qoder-cn", apiKey: "pt-token" })).toBe("https://gateway.qoder.com.cn");
    });
  });

  describe("QoderService with CN OAuth config (Device Flow PKCE)", () => {
    it("generates device flow verification URI targeting qoder.com.cn", () => {
      const svc = new QoderService(QODER_CN_CONFIG);
      const flow = svc.initiateDeviceFlow();

      expect(flow.verificationUriComplete).toContain("https://qoder.com.cn/device/selectAccounts");
      expect(flow.verificationUriComplete).toContain("challenge=");
      expect(flow.verificationUriComplete).toContain("challenge_method=S256");
      expect(flow.verificationUriComplete).toContain("machine_id=");
      expect(flow.verificationUriComplete).toContain("nonce=");
      expect(flow.codeVerifier).toBeDefined();
    });

    it("polls device token from openapi.qoder.com.cn", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          token: "dt-cn-token",
          expires_in: 2592000,
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      );
      vi.stubGlobal("fetch", fetchMock);

      const svc = new QoderService(QODER_CN_CONFIG);
      const result = await svc.pollDeviceToken({ nonce: "test-nonce", codeVerifier: "test-verifier" });

      expect(result.status).toBe("ok");
      expect(result.accessToken).toBe("dt-cn-token");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toContain("https://openapi.qoder.com.cn/api/v1/deviceToken/poll");
      expect(fetchMock.mock.calls[0][0]).toContain("nonce=test-nonce");
    });

    it("fetches user info from openapi.qoder.com.cn", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          name: "CN Dev",
          email: "dev@qoder.cn",
          organization_id: "org-cn",
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      );
      vi.stubGlobal("fetch", fetchMock);

      const svc = new QoderService(QODER_CN_CONFIG);
      const user = await svc.fetchUserInfo("dt-cn-token");

      expect(user).toEqual({
        name: "CN Dev",
        email: "dev@qoder.cn",
        organizationId: "org-cn",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://openapi.qoder.com.cn/api/v1/userinfo");
    });
  });

  describe("QoderExecutor (qoder-cn)", () => {
    it("instantiates correctly with provider='qoder-cn' and region='cn'", async () => {
      const { QoderExecutor } = await import("open-sse/executors/qoder.js");
      const executor = new QoderExecutor("qoder-cn");
      expect(executor.provider).toBe("qoder-cn");
      expect(executor.region).toBe("cn");
      expect(executor.buildUrl({ accessToken: "dt-token" })).toContain("gateway.qoder.com.cn");
    });

    it("executes with strictProxy=true and rejects replay without direct retry", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("proxy socket hung up"));
      vi.resetModules();
      vi.stubGlobal("fetch", fetchMock);
      const { QoderExecutor } = await import("open-sse/executors/qoder.js");
      const executor = new QoderExecutor("qoder-cn");
      const request = {
        model: "qoder-cn/auto",
        body: { messages: [{ role: "user", content: "hello" }] },
        credentials: {
          accessToken: "dt-token",
          providerSpecificData: { userId: "user-1", machineId: "mach-1" },
        },
        proxyOptions: { url: "http://proxy.internal:3128" },
      };

      await expect(executor.execute(request)).rejects.toThrow("proxy socket hung up");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("surfaces upstream first-frame error as immediate HTTP error (not assistant text)", async () => {
      const errEnv = JSON.stringify({
        statusCodeValue: 403,
        body: '{"code":"110","message":"Billing daily count exceeded"}',
      });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(`data: ${errEnv}\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );
      vi.resetModules();
      vi.stubGlobal("fetch", fetchMock);
      const { QoderExecutor } = await import("open-sse/executors/qoder.js");
      const executor = new QoderExecutor("qoder-cn");
      const request = {
        model: "qoder-cn/auto",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials: {
          accessToken: "dt-token",
          providerSpecificData: { userId: "user-1", machineId: "mach-1" },
        },
      };

      const result = await executor.execute(request);
      expect(result.response.status).toBe(403);
      expect(result.response.ok).toBe(false);
      const json = await result.response.json();
      expect(json.error.message).toContain("Billing daily count exceeded");
    });
  });

  describe("Quota parsing & Antigravity Weekly Isolation", () => {
    it("parses qoder-cn quota identically to qoder (returns normalized array)", () => {
      const qoderCnData = {
        quotas: {
          user: {
            total: 1000,
            used: 250,
            unit: "credits",
            resetAt: "2026-10-01T00:00:00Z",
          },
        },
      };

      const quotas = parseQuotaData("qoder-cn", qoderCnData);
      expect(Array.isArray(quotas)).toBe(true);
      expect(quotas).toHaveLength(1);
      expect(quotas[0]).toEqual({
        name: "Personal",
        total: 1000,
        used: 250,
        unit: "credits",
        resetAt: "2026-10-01T00:00:00Z",
      });
    });

    it("keeps Antigravity weekly quota parsing intact and isolated", () => {
      const agData = {
        quotas: {
          gemini_weekly: { total: 100, used: 20, remainingPercentage: 80, resetAt: "2026-10-05T00:00:00Z" },
          claude_gpt_weekly: { total: 50, used: 10, remainingPercentage: 80, resetAt: "2026-10-05T00:00:00Z" },
          gemini_5h: { total: 10, used: 10, remainingPercentage: 0, resetAt: "2026-09-30T15:00:00Z" },
        },
      };

      const agQuotas = parseQuotaData("antigravity", agData);
      expect(Array.isArray(agQuotas)).toBe(true);
      const geminiWeekly = agQuotas.find((q) => q.modelKey === "gemini_weekly");
      const claudeWeekly = agQuotas.find((q) => q.modelKey === "claude_gpt_weekly");

      expect(geminiWeekly).toBeDefined();
      expect(geminiWeekly.used).toBe(20);
      expect(geminiWeekly.total).toBe(100);
      expect(geminiWeekly.remainingPercentage).toBe(80);

      expect(claudeWeekly).toBeDefined();
      expect(claudeWeekly.used).toBe(10);
      expect(claudeWeekly.total).toBe(50);
      expect(claudeWeekly.remainingPercentage).toBe(80);
    });
  });

  describe("Qoder CN usage fetch routing (GAP-6)", () => {
    it("routes getQoderUsage to openapi.qoder.com.cn when provider is qoder-cn", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ quotas: {} }), { status: 200, headers: { "Content-Type": "application/json" } })
      );
      vi.resetModules();
      vi.stubGlobal("fetch", fetchMock);
      const { getQoderUsage } = await import("open-sse/services/usage/misc.js");
      await getQoderUsage("dt-cn-token", null, "qoder-cn");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://openapi.qoder.com.cn/api/v2/quota/usage");
    });
  });

  describe("Multimodal attachments upload endpoint routing (FINDING-1)", () => {
    it("targets CN gateway when uploading image attachments for qoder-cn credentials", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ imageUrl: "https://oss.qoder.com.cn/img1.png" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      vi.resetModules();
      vi.stubGlobal("fetch", fetchMock);

      const { rewriteQoderMessageAttachments, clearQoderUploadCache } = await import(
        "../../open-sse/shared/qoder/attachments.js"
      );
      clearQoderUploadCache();

      const messages = [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }];

      await rewriteQoderMessageAttachments(messages, {
        credentials: {
          provider: "qoder-cn",
          accessToken: "dt-token",
          providerSpecificData: { userId: "u1", machineId: "m1" },
        },
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const uploadUrl = fetchMock.mock.calls[0][0];
      expect(uploadUrl).toContain("https://gateway.qoder.com.cn/algo/api/v2/image/upload");
      expect(messages[0].content[0].image_url.url).toBe("https://oss.qoder.com.cn/img1.png");
    });

    it("targets intl gateway when uploading image attachments for default qoder credentials", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ imageUrl: "https://oss.qoder.sh/img2.png" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      vi.resetModules();
      vi.stubGlobal("fetch", fetchMock);

      const { rewriteQoderMessageAttachments, clearQoderUploadCache } = await import(
        "../../open-sse/shared/qoder/attachments.js"
      );
      clearQoderUploadCache();

      const messages = [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
        ],
      }];

      await rewriteQoderMessageAttachments(messages, {
        credentials: {
          provider: "qoder",
          accessToken: "dt-token",
          providerSpecificData: { userId: "u1", machineId: "m1" },
        },
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const uploadUrl = fetchMock.mock.calls[0][0];
      expect(uploadUrl).toContain("https://api3.qoder.sh/algo/api/v2/image/upload");
      expect(messages[0].content[0].image_url.url).toBe("https://oss.qoder.sh/img2.png");
    });
  });

});
