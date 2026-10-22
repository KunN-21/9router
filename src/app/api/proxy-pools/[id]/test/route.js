import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { fetch as undiciFetch } from "undici";

// What this machine's public address is, measured without any proxy. Compared
// against what the relay reports so a leak is detectable rather than guessed.
async function fetchOwnEgressIp(timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch("https://api.ipify.org", { signal: controller.signal });
    if (!res.ok) return null;
    const ip = (await res.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.includes(":") ? ip : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A relay that replays the caller's forwarding headers upstream does not change
// the egress identity: the target meters the original client address, so every
// pool in the rotation shares one quota bucket. Treat that as a failed test —
// an "active" pool that cannot move the egress is worse than no pool at all.
function relayLeaksClientIdentity(payload, ownIp) {
  if (!payload || typeof payload !== "object") return false;
  let headers = {};
  try {
    headers = JSON.parse(payload.data || "{}")?.headers || {};
  } catch {
    return false;
  }
  const declared = String(headers["Forwarded"] || headers["forwarded"] || "");
  const values = [
    declared,
    headers["X-Forwarded-For"],
    headers["Cf-Connecting-Ip"],
    headers["X-Real-Ip"],
  ].filter(Boolean).map(String);
  if (!values.length) return false;
  // httpbin echoes what arrived. If the caller's own address shows up there,
  // the relay passed it through instead of presenting itself.
  return ownIp ? values.some((v) => v.includes(ownIp)) : false;
}

async function testVercelRelay(relayUrl, timeoutMs = 10000) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "POST",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/anything",
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* non-JSON relay response */ }

    const ownIp = await fetchOwnEgressIp();
    const leaks = relayLeaksClientIdentity(payload, ownIp);

    return {
      ok: res.ok && !leaks,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
      leaksClientIp: leaks,
      egressIp: ownIp,
      error: leaks
        ? "Relay forwards your client IP (Forwarded/Cf-Connecting-Ip), so it cannot change the egress bucket. Redeploy from 9Router after updating, or use a real HTTP/SOCKS proxy."
        : null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const result = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno"
      ? await testVercelRelay(proxyPool.proxyUrl)
      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });
    const now = new Date().toISOString();

    await updateProxyPool(id, {
      testStatus: result.ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
      isActive: result.ok,
    });

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: result.elapsedMs || 0,
      leaksClientIp: result.leaksClientIp === true,
      egressIp: result.egressIp || null,
      testedAt: now,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
