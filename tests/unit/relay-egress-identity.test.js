import { describe, expect, it, beforeEach } from "vitest";

// The relay exists to change the egress address. Two behaviours keep that true:
//   1. client-identity headers must not be replayed upstream, or the target
//      meters the caller's address and every pool shares one bucket;
//   2. a failing relay must not silently fall back to direct, or the caller
//      keeps hitting the exhausted bucket while believing it moved.
//
// proxyFetch captures globalThis.fetch at module load, so the stub has to be in
// place before the import.
const sent = [];
let behavior = () => new Response("ok", { status: 200 });

globalThis.fetch = async (url, opts) => {
  sent.push({ url: String(url), headers: { ...(opts?.headers || {}) } });
  return behavior(String(url), opts);
};

const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

const RELAY = "https://relay.example";

function relayOptions() {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": "Bearer public",
      "x-real-ip": "117.5.142.29",
      "X-Forwarded-For": "117.5.142.29",
      "cf-connecting-ip": "117.5.142.29",
      "Forwarded": "for=117.5.142.29",
      "x-opencode-session": "ses_keepme",
    },
    body: "{}",
  };
}

describe("relay egress identity", () => {
  beforeEach(() => {
    sent.length = 0;
    behavior = () => new Response("ok", { status: 200 });
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NO_PROXY;
  });

  it("strips client identity headers before handing off to the relay", async () => {
    await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", relayOptions(), {
      vercelRelayUrl: RELAY,
    });

    expect(sent).toHaveLength(1);
    const h = sent[0].headers;
    expect(sent[0].url).toBe(RELAY);
    // Egress-identity headers must be gone.
    for (const k of ["x-real-ip", "X-Forwarded-For", "cf-connecting-ip", "Forwarded"]) {
      expect(h[k]).toBeUndefined();
    }
    // Everything the request actually needs survives.
    expect(h["Authorization"]).toBe("Bearer public");
    expect(h["x-opencode-session"]).toBe("ses_keepme");
    expect(h["x-relay-target"]).toBe("https://opencode.ai");
    expect(h["x-relay-path"]).toBe("/inference/v1/chat/completions");
  });

  it("fails loudly instead of falling back to direct when strictProxy is set", async () => {
    behavior = () => { throw new Error("relay down"); };

    await expect(proxyAwareFetch("https://opencode.ai/x", relayOptions(), {
      vercelRelayUrl: RELAY,
      strictProxy: true,
    })).rejects.toThrow(/Relay required but failed/);

    // The direct request must never have been attempted.
    expect(sent.filter((c) => c.url === "https://opencode.ai/x")).toHaveLength(0);
  });

  it("still falls back to direct when strictProxy is off", async () => {
    behavior = (url) => {
      if (url === RELAY) throw new Error("relay down");
      return new Response("direct", { status: 200 });
    };

    const res = await proxyAwareFetch("https://opencode.ai/x", relayOptions(), {
      vercelRelayUrl: RELAY,
      strictProxy: false,
    });
    expect(await res.text()).toBe("direct");
    expect(sent).toHaveLength(2);
    expect(sent[1].url).toBe("https://opencode.ai/x");
  });
});
