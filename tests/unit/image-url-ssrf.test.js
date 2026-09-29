// Hồi quy SSRF cho ingestion ảnh: urlToBase64 dùng chung phải chặn target nội bộ.
// Bao phủ Must-Fix 1 (foundation-closure): loopback, metadata, hostname resolve về private IP.
// Toàn bộ mock/synthetic, không gọi mạng thật.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

const { urlToBase64 } = await import("../../open-sse/handlers/imageProviders/_base.js");
const { handleImageGenerationCore } = await import("../../open-sse/handlers/imageGenerationCore.js");
import cloudflareAdapter from "../../open-sse/handlers/imageProviders/cloudflareAi.js";

const originalFetch = global.fetch;
const PUBLIC_IP = [{ address: "93.184.216.34", family: 4 }];
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(PUBLIC_IP);
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength),
  }));
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("urlToBase64 chặn SSRF ở shared boundary", () => {
  it("reject loopback 127.0.0.1, không gọi fetch", async () => {
    await expect(urlToBase64("http://127.0.0.1:20128/api/keys")).rejects.toThrow(/Blocked URL/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("reject metadata 169.254.169.254, không gọi fetch", async () => {
    await expect(urlToBase64("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/Blocked URL/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reject hostname resolve về private IP, không gọi fetch", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(urlToBase64("http://internal.example/x.png")).rejects.toThrow(/Blocked URL/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("cho phép URL public hợp lệ", async () => {
    const b64 = await urlToBase64("https://example.com/photo.png");
    expect(b64).toBe(PNG_BYTES.toString("base64"));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("callers map lỗi SSRF thành 400, không chạm upstream", () => {
  it("huggingface image-to-image với image loopback → 400 Blocked URL", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "make it snow", image: "http://127.0.0.1:20128/api/keys" },
      modelInfo: { provider: "huggingface", model: "Qwen/Qwen-Image-Edit" },
      credentials: { apiKey: "hf_test_token" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/Blocked URL/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("cloudflare buildBody với image loopback → throw Blocked URL", async () => {
    await expect(
      cloudflareAdapter.buildBody("test-model", { prompt: "x", image: "http://127.0.0.1:9999/a.png" })
    ).rejects.toThrow(/Blocked URL/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
