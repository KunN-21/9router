"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const confirmedConfigRef = useRef({
    proxyPoolId: NONE_PROXY_POOL_VALUE,
    rotateStrategy: "none",
  });
  const savingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) =>
        r.ok ? r.json() : { proxyPools: [] }
      ),
      fetch("/api/settings", { cache: "no-store" }).then((r) =>
        r.ok ? r.json() : null
      ),
    ])
      .then(([poolData, settingsData]) => {
        if (cancelled) return;
        setProxyPools(poolData?.proxyPools || []);
        if (settingsData && typeof settingsData === "object") {
          const override =
            (settingsData.providerStrategies || {})[providerId] || {};
          const confirmedPool = override.proxyPoolId || NONE_PROXY_POOL_VALUE;
          const confirmedStrategy = override.rotateStrategy || "none";
          setProxyPoolId(confirmedPool);
          setRotateStrategy(confirmedStrategy);
          confirmedConfigRef.current = {
            proxyPoolId: confirmedPool,
            rotateStrategy: confirmedStrategy,
          };
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const save = useCallback(
    async (poolId, strategy) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setSavedFlash(false);
      setSaveError(null);

      try {
        // 1. GET settings with strict validation; abort immediately on failure
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`Failed to load existing settings: HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!data || typeof data !== "object") {
          throw new Error("Invalid settings payload received from server");
        }

        // 2. Build updated strategies strictly preserving other providers & custom fields
        const current = data.providerStrategies || {};
        const existingProviderConfig = { ...(current[providerId] || {}) };

        if (poolId === NONE_PROXY_POOL_VALUE) {
          delete existingProviderConfig.proxyPoolId;
        } else {
          existingProviderConfig.proxyPoolId = poolId;
        }

        if (strategy === "none") {
          delete existingProviderConfig.rotateStrategy;
        } else {
          existingProviderConfig.rotateStrategy = strategy;
        }

        const updated = { ...current };
        if (Object.keys(existingProviderConfig).length === 0) {
          delete updated[providerId];
        } else {
          updated[providerId] = existingProviderConfig;
        }

        // 3. PATCH settings with status verification
        const patchRes = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerStrategies: updated }),
        });
        if (!patchRes.ok) {
          throw new Error(`Failed to save provider strategy: HTTP ${patchRes.status}`);
        }

        // 4. Update confirmed state & flash Saved badge on actual valid HTTP result
        confirmedConfigRef.current = {
          proxyPoolId: poolId,
          rotateStrategy: strategy,
        };
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
      } catch (e) {
        const msg = e?.message || "Failed to save proxy configuration";
        setSaveError(msg);
        // Rollback local selection state to last confirmed values
        setProxyPoolId(confirmedConfigRef.current.proxyPoolId);
        setRotateStrategy(confirmedConfigRef.current.rotateStrategy);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [providerId]
  );

  const handlePoolChange = (newPoolId) => {
    if (savingRef.current) return;
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy);
  };

  const handleStrategyChange = (newStrategy) => {
    if (savingRef.current) return;
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy);
  };

  const isOpenCode = providerId === "opencode";
  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">
            {isOpenCode
              ? "Anonymous public tier. Optionally route requests through a proxy pool to manage egress routing."
              : "This provider does not require credentials. Optionally route requests through a configured proxy pool."}
          </p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
        {saving && <Badge variant="default" size="sm">Saving...</Badge>}
      </div>

      {saveError && (
        <div
          role="alert"
          className="p-3 mb-4 rounded-md bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs flex items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px]">error</span>
            <span>{saveError}</span>
          </div>
          <button
            type="button"
            onClick={() => setSaveError(null)}
            className="text-text-muted hover:text-text-main text-xs underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {isOpenCode && (
        <div className="mb-4 p-4 rounded-md bg-bg border border-border-subtle flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-text-main">
                OpenCode Go Server-Owned Workspace Preferences
              </p>
              <p className="text-xs text-text-muted mt-0.5">
                OpenCode Free operates anonymously without a workspace account and cannot grant server-side consent for China-hosted models or training data. The following settings are unsupported on the anonymous free tier:
              </p>
            </div>
            <a
              href="https://opencode.ai/workspace"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors whitespace-nowrap"
              aria-label="Manage in OpenCode Go Console"
            >
              <span>Manage in OpenCode Go Console</span>
              <span className="material-symbols-outlined text-[14px]">open_in_new</span>
            </a>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
            <div className="p-2.5 rounded bg-surface border border-border-subtle flex flex-col gap-1">
              <span className="font-mono font-medium text-text-main">useChina</span>
              <span className="text-[11px] text-text-muted">
                workspace.region: Allows routing to models hosted in China (DeepSeek V4). Server-managed in Go console only.
              </span>
            </div>
            <div className="p-2.5 rounded bg-surface border border-border-subtle flex flex-col gap-1">
              <span className="font-mono font-medium text-text-main">allowTraining</span>
              <span className="text-[11px] text-text-muted">
                workspace.allow_training: Opt-in to model training data collection. Requires authenticated Go workspace consent.
              </span>
            </div>
            <div className="p-2.5 rounded bg-surface border border-border-subtle flex flex-col gap-1">
              <span className="font-mono font-medium text-text-main">useBalance</span>
              <span className="text-[11px] text-text-muted">
                billing.lite.useBalance: Zen balance overflow billing when included quota is exhausted. Paid Go accounts only.
              </span>
            </div>
          </div>

          <p className="text-[11px] text-text-muted border-t border-border-subtle pt-2">
            <strong className="text-text-main">Upstream policy notes:</strong> RegionError / countryNotAllowed occurs due to geographic egress IP restrictions. Go China and training opt-in are server-managed workspace preferences. FreeTierError occurs when requesting models or rates restricted from the free tier.
          </p>
        </div>
      )}

      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChange(e.target.value)}
        disabled={saving || isRotation}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={
          isRotation
            ? "Pool selector is ignored when rotation is active — all active pools are used."
            : undefined
        }
      />

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option
              key={s.value}
              value={s.value}
              disabled={s.value !== "none" && !canRotate}
            >
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {!canRotate
            ? `Need at least 2 active proxy pools for rotation.`
            : isRotation
              ? rotateStrategy === "round-robin"
                ? `Rotating through all ${proxyPools.length} active pools in order. State is in-memory (resets on restart).`
                : `Picking a random pool from ${proxyPools.length} active pools each request.`
              : `Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools.`}
        </p>
      </div>

    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
