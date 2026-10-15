import { NextResponse } from "next/server";
import REGISTRY from "open-sse/providers/registry/index.js";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { getProviderNodeById, getSettings, updateProviderOverride } from "@/lib/db/index.js";
import { applyHeaderOverrides } from "open-sse/utils/headerOverrides.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

/**
 * Resolve provider ID to canonical provider and builtin transport headers.
 * Safe own-property lookups on configured compatible nodes, REGISTRY, and AI_PROVIDERS.
 *
 * @param {string} id - Provider identifier from route param
 * @returns {Promise<{ canonicalProvider: string, builtinHeaders: Record<string, string> } | null>}
 */
async function resolveProvider(id) {
  if (!id || typeof id !== "string") return null;

  // 1. Configured compatible provider node lookup
  const node = await getProviderNodeById(id);
  if (node) {
    return {
      canonicalProvider: node.id,
      builtinHeaders: {},
    };
  }

  // 2. Canonical registry lookup (exact id, alias, uiAlias, aliases list)
  const canonicalId = resolveProviderId(id);
  const regEntry = REGISTRY.find((r) =>
    r.id === canonicalId ||
    r.id === id ||
    r.alias === id ||
    r.uiAlias === id ||
    (Array.isArray(r.aliases) && r.aliases.includes(id))
  );

  if (regEntry) {
    const rawBuiltin = regEntry.transport?.headers;
    const builtinHeaders = rawBuiltin && typeof rawBuiltin === "object" ? { ...rawBuiltin } : {};
    return {
      canonicalProvider: regEntry.id,
      builtinHeaders,
    };
  }

  // 3. Fallback dictionary check on AI_PROVIDERS with own-property safety
  if (Object.prototype.hasOwnProperty.call(AI_PROVIDERS, canonicalId)) {
    const aiProvider = AI_PROVIDERS[canonicalId];
    return {
      canonicalProvider: aiProvider.id || canonicalId,
      builtinHeaders: {},
    };
  }

  return null;
}

// GET /api/providers/[id]/overrides
export async function GET(request, { params }) {
  try {
    const resolvedParams = params && typeof params.then === "function" ? await params : (params || {});
    const { id } = resolvedParams;

    const resolved = await resolveProvider(id);
    if (!resolved) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }

    const { canonicalProvider, builtinHeaders } = resolved;
    const settings = await getSettings();
    const storedHeaders = (
      settings.providerOverrides &&
      typeof settings.providerOverrides === "object" &&
      settings.providerOverrides[canonicalProvider] &&
      typeof settings.providerOverrides[canonicalProvider].headers === "object" &&
      settings.providerOverrides[canonicalProvider].headers !== null &&
      !Array.isArray(settings.providerOverrides[canonicalProvider].headers)
    )
      ? { ...settings.providerOverrides[canonicalProvider].headers }
      : {};

    return NextResponse.json({
      headers: storedHeaders,
      builtinHeaders,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch provider overrides" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

// PUT /api/providers/[id]/overrides
export async function PUT(request, { params }) {
  try {
    const resolvedParams = params && typeof params.then === "function" ? await params : (params || {});
    const { id } = resolvedParams;

    const resolved = await resolveProvider(id);
    if (!resolved) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }

    const { canonicalProvider, builtinHeaders } = resolved;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // Strict input shape validation: root must be non-null object, not array, with object headers property
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.headers === undefined ||
      body.headers === null ||
      typeof body.headers !== "object" ||
      Array.isArray(body.headers)
    ) {
      return NextResponse.json(
        { error: "Invalid request body: expected { headers: object }" },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // Reset case: empty dictionary { headers: {} } removes the canonical provider override slice
    const incomingEntries = Object.entries(body.headers);
    if (incomingEntries.length === 0) {
      await updateProviderOverride(canonicalProvider, {});
      return NextResponse.json({
        headers: {},
        builtinHeaders,
      }, { headers: NO_STORE_HEADERS });
    }

    // Validate using shared helper applyHeaderOverrides({}, body.headers)
    // Throws TypeError on non-string, CRLF, or invalid HTTP token names/values
    let validatedHeaders;
    try {
      validatedHeaders = applyHeaderOverrides({}, body.headers);
    } catch {
      // Do not echo secret value or internal error stack
      return NextResponse.json(
        { error: "Invalid HTTP header name or value" },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // Persist only effective diff from registry transport defaults so redundant defaults do not pin
    const effectiveDiff = {};
    for (const [k, v] of Object.entries(validatedHeaders)) {
      const lower = k.toLowerCase();
      let matchedBuiltinVal = undefined;
      for (const [bk, bv] of Object.entries(builtinHeaders)) {
        if (bk.toLowerCase() === lower) {
          matchedBuiltinVal = bv;
          break;
        }
      }
      if (matchedBuiltinVal === undefined || matchedBuiltinVal !== v) {
        Object.defineProperty(effectiveDiff, k, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }

    await updateProviderOverride(canonicalProvider, effectiveDiff);

    return NextResponse.json({
      headers: effectiveDiff,
      builtinHeaders,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update provider overrides" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
