// Upstream #4983: OpenCode's free-tier gate rejects requests whose *egress IP*
// it has flagged with 403 FreeTierError. The transport succeeds, so the
// catch-based proxy-failure fallback never fires and every retry keeps leaving
// through the same flagged proxy. Live measurement: identical body and headers
// in the same minute — flagged pool → 403 FreeTierError, direct egress → 200.
//
// proxyAwareFetch now inspects a proxied/relayed 403 and replays once on the
// direct egress when the body carries the FreeTierError marker. strictProxy
// keeps its contract (never leaves the configured path) and non-gate 403s pass
// through untouched.
//
// proxyFetch captures globalThis.fetch at module load, so the stub must be in
// place before the import.
import { beforeEach, describe, expect, it, vi } from "vitest";

const FREE_TIER_403 = JSON.stringify({
  type: "error",
  error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." },
});
const OTHER_403 = JSON.stringify({ error: { type: "permission_error", message: "quota exhausted" } });

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

// getDispatcher() imports undici lazily on the proxy path.
vi.mock("undici", () => ({
  Agent: class {},
  ProxyAgent: class { constructor() {} },
}));

const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

const PROXY = { enabled: true, url: "http://127.0.0.1:9999" };

// Proxy attempts carry an undici dispatcher; direct attempts do not.
function proxiedThenDirect({ proxiedResponse, directResponse }) {
  fetchMock.mockImplementation(async (_url, opts = {}) =>
    opts.dispatcher ? proxiedResponse() : directResponse());
}

beforeEach(() => {
  fetchMock.mockReset();
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.NO_PROXY;
});

describe("proxied 403 FreeTierError replays direct (#4983)", () => {
  it("replays once on the direct egress and returns its 200", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("data: ok", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeTruthy();
    expect(fetchMock.mock.calls[1][1]?.dispatcher).toBeFalsy();
  });

  it("keeps strictProxy on the configured path — returns the 403, no replay", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, { ...PROXY, strictProxy: true });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FREE_TIER_403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a non-gate 403 untouched, without a direct replay", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response(OTHER_403, { status: 403, headers: { "content-type": "application/json", "x-request-id": "req-1" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://api.example.com/v1/chat", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(await res.text()).toBe(OTHER_403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a proxied 200 stream untouched — one call, body not consumed", async () => {
    proxiedThenDirect({
      proxiedResponse: () => new Response("data: chunk\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
      directResponse: () => new Response("must not run", { status: 200 }),
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: chunk\n");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original 403 when the direct replay itself fails", async () => {
    let call = 0;
    fetchMock.mockImplementation(async (_url, opts = {}) => {
      call += 1;
      if (call === 1) return new Response(FREE_TIER_403, { status: 403, headers: { "content-type": "application/json" } });
      expect(opts.dispatcher).toBeFalsy();
      throw new Error("direct egress down");
    });

    const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" }, PROXY);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FREE_TIER_403);
  });
});
