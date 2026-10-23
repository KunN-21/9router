/**
 * OpenCode Go usage — GET https://opencode.ai/zen/go/v1/usage
 * Auth: Bearer <apiKey>
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseResetTime, U } from "./shared.js";

const USAGE_URL = U("opencode-go").url;
const QUOTA_NAMES = {
  rolling: "Rolling",
  weekly: "Weekly",
  monthly: "Monthly",
};

function parsePercent(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// Errors come back as {type:"error", error:{type, message}} — surface the
// message rather than echoing the raw JSON envelope at the user.
async function readErrorDetail(response) {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // not JSON — fall through to the raw text
  }
  return text.slice(0, 200);
}

export async function getOpenCodeGoUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return {
      message: "OpenCode Go API key not available. Add a key to view usage.",
    };
  }

  try {
    const response = await proxyAwareFetch(
      USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401) {
      return {
        plan: "OpenCode Go",
        message: "OpenCode Go authentication failed. API key invalid or expired.",
      };
    }

    // 403 is an entitlement error, not an auth error: upstream answers it when
    // the key authenticates but the account carries no Go subscription. Calling
    // that an invalid key would send the user off to reissue a working one.
    if (response.status === 403) {
      const error = await response.json().catch(() => null);
      const detail = typeof error?.error?.message === "string" ? error.error.message.trim() : "";
      if (detail) return { plan: "OpenCode Go", message: detail };
      return {
        plan: "OpenCode Go",
        message: error?.error?.type === "EntitlementError"
          ? "OpenCode Go subscription required."
          : "OpenCode Go access forbidden for this API key.",
      };
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      return {
        plan: "OpenCode Go",
        message: `OpenCode Go usage API error (${response.status})${detail ? `: ${detail}` : ""}`,
      };
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return {
        plan: "OpenCode Go",
        message: "OpenCode Go usage response was not JSON.",
      };
    }

    const usage = data.usage;
    if (!usage || typeof usage !== "object") {
      return {
        plan: "OpenCode Go",
        message: "OpenCode Go usage response did not contain quota data.",
      };
    }

    const quotas = {};
    let sawWindow = false;
    for (const [period, name] of Object.entries(QUOTA_NAMES)) {
      const quota = usage[period];
      // Upstream emits all three windows today, but the payload shape has moved
      // once already. Skip anything unrecognised instead of emitting a 0% bar
      // that would read as "quota untouched".
      if (!quota || typeof quota !== "object") continue;
      sawWindow = true;
      const percent = parsePercent(quota.percent);
      if (percent === null) continue;
      const used = Math.max(0, Math.min(100, percent));
      quotas[name] = {
        used,
        total: 100,
        remaining: 100 - used,
        remainingPercentage: 100 - used,
        resetAt: parseResetTime(quota.resetsAt),
        unlimited: false,
      };
    }

    if (Object.keys(quotas).length === 0) {
      // No window at all is a reportable state (plan without quota windows);
      // windows we merely could not read mean the payload moved under us.
      return sawWindow
        ? { plan: "OpenCode Go", message: "OpenCode Go usage response did not contain valid quota data." }
        : { plan: "OpenCode Go", message: "OpenCode Go connected. No quota windows reported.", quotas: {} };
    }

    return { plan: "OpenCode Go", quotas };
  } catch (error) {
    return { message: `OpenCode Go error: ${error.message}` };
  }
}
