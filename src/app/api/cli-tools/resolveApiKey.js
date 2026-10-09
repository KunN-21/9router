/**
 * Resolves the API key to write into a CLI tool config.
 *
 * CLI tool cards send an empty string when no key is explicitly selected
 * (e.g. the existing config already has a provider block but the frontend
 * can't read the stored Authorization header back). The routes previously
 * fell back to the literal placeholder "sk_9router", which causes 401
 * "Invalid API key" for any deployment with requireApiKey=true (#4399).
 *
 * Resolution order:
 *   1. The key supplied by the caller (non-empty string).
 *   2. An existing key, when the route supplies one to preserve its configuration.
 *   3. The first active key in the dashboard's apiKeys table.
 *   4. Empty string — the route writes no Authorization header value,
 *      which is fine for requireApiKey=false deployments.
 *
 * DB lookup failure throws a generic error so callers fail closed
 * instead of overwriting a valid existing config with an empty key.
 *
 * The placeholder "sk_9router" is NEVER written; it was never a real key.
 */

import { getApiKeys } from "@/lib/db";

/**
 * @param {*} callerKey  Key sent by the frontend (only non-empty strings count).
 * @param {*} existingKey  Optional key already stored by the CLI tool.
 * @returns {Promise<string>}
 * @throws {Error} Generic "Failed to resolve API key" when the DB lookup fails.
 */
export async function resolveCliApiKey(callerKey, existingKey) {
  for (const key of [callerKey, existingKey]) {
    if (typeof key === "string" && key.trim() && key.trim() !== "sk_9router") {
      return key.trim();
    }
  }
  let keys;
  try {
    keys = await getApiKeys();
  } catch {
    throw new Error("Failed to resolve API key");
  }
  const active = keys?.find?.(
    (k) => k?.isActive && typeof k?.key === "string" && k.key.trim() && k.key.trim() !== "sk_9router",
  );
  return active ? active.key.trim() : "";
}
