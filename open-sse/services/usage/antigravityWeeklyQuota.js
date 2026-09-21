/**
 * Antigravity weekly-quota fetcher + parser
 *
 * Enforces family-level weekly quota visibility (Gemini Models, Claude and GPT models)
 * via Google Cloud Code retrieveUserQuotaSummary RPC.
 * Best-effort, fail-open, and non-blocking.
 */

import nodeCrypto from "node:crypto";
import { ANTIGRAVITY_IDE_BASE_URL, ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_IDE_VERSION } from "../../providers/shared.js";
import { U, parseResetTime, fetchWithTimeout } from "./shared.js";

const WEEKLY_QUOTA_TTL_MS = 60 * 1000;
const weeklyQuotaCache = new Map();
const inflightRequests = new Map();

/**
 * Parse raw retrieveUserQuotaSummary response into family-level weekly quotas.
 * Supports both top-level groups envelope and nested quotaSummary.groups envelope.
 *
 * @param {object} summaryData - Raw API response JSON
 * @returns {Record<string, object>} Quotas map keyed by gemini_weekly / claude_gpt_weekly
 */
/**
 * Find a bucket in a group by explicit window value, bucketId, or displayName.
 * @param {Array} buckets - Group buckets
 * @param {string} window - "5h" or "weekly"
 * @returns {object|null}
 */
function findBucketByWindow(buckets, window) {
  if (!Array.isArray(buckets)) return null;
  const want = String(window || "").toLowerCase();
  const patterns = want === "5h"
    ? [/\b5h\b/i, /five[\s_-]?hour/i, /300m/i]
    : [/\bweekly\b/i, /\bweek\b/i, /\b7d\b/i, /168h/i];

  for (const b of buckets) {
    if (!b || typeof b !== "object") continue;
    if (String(b.window || "").toLowerCase() === want) return b;
  }
  for (const b of buckets) {
    if (!b || typeof b !== "object") continue;
    const id = typeof b.bucketId === "string" ? b.bucketId : "";
    const name = typeof b.displayName === "string" ? b.displayName : "";
    if (patterns.some((re) => re.test(id) || re.test(name))) return b;
  }
  return null;
}

function bucketToQuota(bucket) {
  if (!bucket || typeof bucket !== "object") return null;
  if (bucket.disabled === true) return null;
  if (bucket.remainingFraction == null) return null;
  const rawFraction = Number(bucket.remainingFraction);
  if (!Number.isFinite(rawFraction)) return null;
  const remainingFraction = Math.max(0, Math.min(1, rawFraction));
  const total = 1000; // Normalized base matching 9Router convention
  const remaining = Math.round(total * remainingFraction);
  const used = Math.max(0, total - remaining);
  return {
    used,
    total,
    resetAt: parseResetTime(bucket.resetTime),
    remainingPercentage: remainingFraction * 100,
    unlimited: false,
  };
}

export function parseAntigravityWeeklyQuotas(summaryData) {
  if (!summaryData || typeof summaryData !== "object") return {};

  const groups = Array.isArray(summaryData.groups)
    ? summaryData.groups
    : Array.isArray(summaryData?.quotaSummary?.groups)
    ? summaryData.quotaSummary.groups
    : Array.isArray(summaryData?.response?.groups)
    ? summaryData.response.groups
    : null;

  if (!groups || groups.length === 0) return {};

  const quotas = {};

  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.buckets)) continue;

    const displayName = String(group.displayName || "").trim();
    let familyPrefix = null;

    if (displayName === "Gemini Models") {
      familyPrefix = "gemini";
    } else if (displayName === "Claude and GPT models") {
      familyPrefix = "claude_gpt";
    } else {
      // Ignore unknown Google family groups safely
      continue;
    }

    const isGemini = familyPrefix === "gemini";
    const fiveHour = bucketToQuota(findBucketByWindow(group.buckets, "5h"));
    if (fiveHour) {
      quotas[isGemini ? "gemini_5h" : "claude_gpt_5h"] = {
        ...fiveHour,
        displayName: isGemini ? "Gemini (5h)" : "Claude & GPT (5h)",
      };
    }

    const weekly = bucketToQuota(findBucketByWindow(group.buckets, "weekly"));
    if (weekly) {
      quotas[isGemini ? "gemini_weekly" : "claude_gpt_weekly"] = {
        ...weekly,
        displayName: isGemini ? "Gemini Weekly" : "Claude & GPT Weekly",
      };
    }
  }

  return quotas;
}

/**
 * Fetch and parse Antigravity weekly quotas from Google Cloud Code API.
 * Fail-open: returns empty object on any failure.
 * Cached process-locally for 60s.
 *
 * @param {string} accessToken - OAuth access token
 * @param {string} projectId - Cloud AI Companion project ID
 * @param {object} proxyOptions - Connection proxy options
 * @param {object} options - Options (e.g. { force: true })
 * @returns {Promise<Record<string, object>>}
 */
export async function fetchAndParseAntigravityWeeklyQuotas(
  accessToken,
  projectId,
  proxyOptions = null,
  options = {}
) {
  if (!accessToken || !projectId) return {};

  // Hash full token: prefix slice collides across accounts sharing a prefix.
  const tokenHash = nodeCrypto.createHash("sha256").update(String(accessToken)).digest("hex").slice(0, 32);
  const cacheKey = `${projectId}:${tokenHash}`;
  const now = Date.now();

  if (!options.force && weeklyQuotaCache.has(cacheKey)) {
    const cached = weeklyQuotaCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.quotas;
    }
  }

  if (inflightRequests.has(cacheKey)) {
    return await inflightRequests.get(cacheKey);
  }

  const fetchPromise = (async () => {
    try {
      const quotaSummaryUrl =
        U("antigravity")?.quotaSummaryApiUrl ||
        `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:retrieveUserQuotaSummary`;

      const response = await fetchWithTimeout(
        quotaSummaryUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
            "Content-Type": "application/json",
            "X-Client-Name": "antigravity",
            "X-Client-Version": ANTIGRAVITY_IDE_VERSION,
          },
          body: JSON.stringify({ project: projectId }),
        },
        10000,
        proxyOptions
      );

      if (!response || !response.ok) {
        // Short failure cache: avoid repeated poll failure storms on 429/5xx.
        weeklyQuotaCache.set(cacheKey, { quotas: {}, expiresAt: Date.now() + 15_000 });
        return {};
      }

      const data = await response.json();
      const quotas = parseAntigravityWeeklyQuotas(data);

      weeklyQuotaCache.set(cacheKey, {
        quotas,
        expiresAt: Date.now() + WEEKLY_QUOTA_TTL_MS,
      });

      // Simple bounded cache cleanup
      if (weeklyQuotaCache.size > 100) {
        const cur = Date.now();
        for (const [k, v] of weeklyQuotaCache) {
          if (v.expiresAt <= cur) weeklyQuotaCache.delete(k);
        }
      }

      return quotas;
    } catch {
      // Fail-open: network failure, timeout, 5xx, or invalid JSON never throw
      return {};
    }
  })().finally(() => {
    inflightRequests.delete(cacheKey);
  });

  inflightRequests.set(cacheKey, fetchPromise);
  return await fetchPromise;
}
