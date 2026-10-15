/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Card, Badge } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const SENSITIVE_HEADER_RE = /^(?:authorization|cookie|host|content-type|content-length|connection|transfer-encoding|proxy-authorization)$/i;
const MASK_VALUE_RE = /authorization|cookie|key|token|secret/i;

function isPlainStringMap(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  if (proto !== null && proto !== Object.prototype) return false;
  for (const key of Reflect.ownKeys(val)) {
    const desc = Object.getOwnPropertyDescriptor(val, key);
    if (!desc || typeof desc.value !== "string") return false;
  }
  return true;
}

function parseHeadersResponse(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const proto = Object.getPrototypeOf(data);
  if (proto !== null && proto !== Object.prototype) return null;
  if (!isPlainStringMap(data.headers) || !isPlainStringMap(data.builtinHeaders)) {
    return null;
  }
  return {
    headers: data.headers,
    builtinHeaders: data.builtinHeaders,
  };
}

function formatRowsFromResponse(builtinHeaders, userOverrides) {
  const rows = [];
  const overrideEntries = userOverrides && typeof userOverrides === "object" && !Array.isArray(userOverrides)
    ? Object.entries(userOverrides)
    : [];
  const builtinEntries = builtinHeaders && typeof builtinHeaders === "object" && !Array.isArray(builtinHeaders)
    ? Object.entries(builtinHeaders)
    : [];

  for (const [bName, bVal] of builtinEntries) {
    const hasOverride = overrideEntries.some(([oName]) => oName.toLowerCase() === bName.toLowerCase());
    if (!hasOverride) {
      rows.push({ name: bName, value: String(bVal ?? "") });
    }
  }

  for (const [oName, oVal] of overrideEntries) {
    rows.push({ name: oName, value: String(oVal ?? "") });
  }

  return rows.length ? rows : [{ name: "", value: "" }];
}

function computeHeaders(rows, builtin) {
  const headers = Object.create(null);
  const activeRows = rows.filter((r) => r.name.trim() !== "");

  for (const r of activeRows) {
    const name = r.name.trim();
    const val = r.value ?? "";

    const builtinMatch = Object.entries(builtin).find(
      ([bName]) => bName.toLowerCase() === name.toLowerCase()
    );

    if (builtinMatch) {
      for (const k of Reflect.ownKeys(headers)) {
        if (k.toLowerCase() === builtinMatch[0].toLowerCase()) {
          delete headers[k];
        }
      }
      if (val !== builtinMatch[1]) {
        Object.defineProperty(headers, name, {
          value: val,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    } else {
      Object.defineProperty(headers, name, {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return headers;
}

export default function CustomConfigCard({ providerId }) {
  const notify = useNotificationStore();
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState([{ name: "", value: "" }]);
  const [builtin, setBuiltin] = useState({});
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [getFailed, setGetFailed] = useState(false);
  const [error, setError] = useState(null);
  const [visibleSecrets, setVisibleSecrets] = useState({});

  const mountedRef = useRef(true);
  const activeProviderRef = useRef(providerId);
  const requestGenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activeProviderRef.current = providerId;
    const currentGen = ++requestGenRef.current;
    let cancelled = false;

    setLoading(true);
    setGetFailed(false);
    setError(null);
    setVisibleSecrets({});

    const isCurrent = () =>
      !cancelled &&
      mountedRef.current &&
      activeProviderRef.current === providerId &&
      requestGenRef.current === currentGen;

    fetch(`/api/providers/${encodeURIComponent(providerId)}/overrides`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) {
          throw new Error(`Failed to load custom headers (HTTP ${r.status})`);
        }
        return r.json();
      })
      .then((raw) => {
        if (!isCurrent()) return;
        const data = parseHeadersResponse(raw);
        if (!data) {
          setGetFailed(true);
          setError("Failed to load custom headers");
          return;
        }

        const { builtinHeaders, headers: userOverrides } = data;
        setBuiltin(builtinHeaders);
        setRows(formatRowsFromResponse(builtinHeaders, userOverrides));
        setHasOverride(Object.keys(userOverrides).length > 0);
      })
      .catch((err) => {
        if (!isCurrent()) return;
        setGetFailed(true);
        setError(err.message || "Failed to load custom headers");
      })
      .finally(() => {
        if (isCurrent()) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const setRow = (i, field, value) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  };

  const addRow = () => {
    setRows((prev) => [...prev, { name: "", value: "" }]);
  };

  const removeRow = (i) => {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [{ name: "", value: "" }]));
  };

  const toggleSecretVisibility = (i) => {
    setVisibleSecrets((prev) => ({ ...prev, [i]: !prev[i] }));
  };

  const save = useCallback(async () => {
    setError(null);
    const targetProviderId = providerId;
    const currentGen = ++requestGenRef.current;

    const isCurrent = () =>
      mountedRef.current &&
      activeProviderRef.current === targetProviderId &&
      requestGenRef.current === currentGen;

    for (const r of rows) {
      const name = r.name.trim();
      const val = r.value ?? "";
      if (!name && val.trim() !== "") {
        const msg = "Header name cannot be empty for configured value";
        setError(msg);
        notify.error(msg);
        return;
      }
    }

    const headers = computeHeaders(rows, builtin);

    setSaving(true);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(targetProviderId)}/overrides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers }),
      });

      let raw;
      try {
        raw = await res.json();
      } catch {
        if (!isCurrent()) return;
        const errMsg = "Invalid JSON response from server";
        setError(errMsg);
        notify.error(errMsg);
        return;
      }

      if (!isCurrent()) return;

      if (!res.ok) {
        const errMsg = raw?.error || `Failed to save (HTTP ${res.status})`;
        setError(errMsg);
        notify.error(errMsg);
        return;
      }

      const data = parseHeadersResponse(raw);
      if (!data) {
        const errMsg = "Invalid response format from server";
        setError(errMsg);
        notify.error(errMsg);
        return;
      }

      const { builtinHeaders: newBuiltin, headers: newOverrides } = data;
      setBuiltin(newBuiltin);
      setHasOverride(Object.keys(newOverrides).length > 0);
      setRows(formatRowsFromResponse(newBuiltin, newOverrides));
      notify.success("Custom headers saved");
    } catch (err) {
      if (!isCurrent()) return;
      const errMsg = err.message || "Network error saving custom headers";
      setError(errMsg);
      notify.error(errMsg);
    } finally {
      if (isCurrent()) {
        setSaving(false);
      }
    }
  }, [rows, builtin, providerId, notify]);

  const resetToBuiltin = useCallback(async () => {
    setError(null);
    setSaving(true);
    const targetProviderId = providerId;
    const currentGen = ++requestGenRef.current;

    const isCurrent = () =>
      mountedRef.current &&
      activeProviderRef.current === targetProviderId &&
      requestGenRef.current === currentGen;

    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(targetProviderId)}/overrides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers: {} }),
      });

      let raw;
      try {
        raw = await res.json();
      } catch {
        if (!isCurrent()) return;
        const errMsg = "Invalid JSON response from server";
        setError(errMsg);
        notify.error(errMsg);
        return;
      }

      if (!isCurrent()) return;

      if (!res.ok) {
        const errMsg = raw?.error || `Failed to reset (HTTP ${res.status})`;
        setError(errMsg);
        notify.error(errMsg);
        return;
      }

      const data = parseHeadersResponse(raw);
      if (!data) {
        const errMsg = "Invalid response format from server";
        setError(errMsg);
        notify.error(errMsg);
        return;
      }

      const { builtinHeaders: newBuiltin, headers: newOverrides } = data;
      const hasRemainingOverrides = Object.keys(newOverrides).length > 0;

      setBuiltin(newBuiltin);
      setRows(formatRowsFromResponse(newBuiltin, newOverrides));
      setHasOverride(hasRemainingOverrides);
      setVisibleSecrets({});

      if (hasRemainingOverrides) {
        const errMsg = "Server retained custom overrides";
        setError(errMsg);
        notify.error(errMsg);
      } else {
        notify.success("Headers reset to defaults");
      }
    } catch (err) {
      if (!isCurrent()) return;
      const errMsg = err.message || "Network error resetting headers";
      setError(errMsg);
      notify.error(errMsg);
    } finally {
      if (isCurrent()) {
        setSaving(false);
      }
    }
  }, [providerId, notify]);

  const hasSensitiveHeader = rows.some((r) => SENSITIVE_HEADER_RE.test(r.name.trim()));
  const isActionDisabled = loading || saving || getFailed;

  return (
    <Card padding="xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse Custom Headers" : "Expand Custom Headers"}
      >
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
          <span className="text-sm font-semibold">Custom Headers</span>
          {hasOverride && (
            <Badge variant="success" size="sm">Active</Badge>
          )}
        </div>
        <span className="material-symbols-outlined text-text-muted">
          {expanded ? "expand_less" : "expand_more"}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 border-t border-border pt-3">
          {error && (
            <div role="alert" className="mb-3 rounded-md bg-red-50 p-2 text-xs text-red-600 dark:bg-red-950/50 dark:text-red-400">
              {error}
            </div>
          )}

          {hasSensitiveHeader && (
            <div role="status" className="mb-3 rounded-md bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
              {"Advisory: Customizing sensitive headers (e.g. Authorization, Host, Cookie) may affect upstream authentication or transport routing."}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {rows.map((row, i) => {
              const trimmedName = row.name.trim();
              const builtinMatch = Object.entries(builtin).find(
                ([bName]) => bName.toLowerCase() === trimmedName.toLowerCase()
              );
              const isBuiltin = Boolean(builtinMatch);
              const isOverridden = isBuiltin && row.value !== builtinMatch[1];
              const isMaskedValue = MASK_VALUE_RE.test(trimmedName);
              const isVisible = Boolean(visibleSecrets[i]);

              return (
                <div key={i} className="flex items-center gap-2">
                  <input
                    aria-label="Header Name"
                    value={row.name}
                    onChange={(e) => setRow(i, "name", e.target.value)}
                    placeholder="Header-Name"
                    spellCheck={false}
                    disabled={isActionDisabled}
                    className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
                  />
                  <input
                    aria-label="Header Value"
                    value={row.value}
                    onChange={(e) => setRow(i, "value", e.target.value)}
                    placeholder="Value"
                    spellCheck={false}
                    type={isMaskedValue && !isVisible ? "password" : "text"}
                    disabled={isActionDisabled}
                    title={isOverridden ? "Overridden" : isBuiltin ? "Registry default" : ""}
                    className={`min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none disabled:opacity-50 ${
                      isOverridden ? "border-amber-400/60" : "border-border"
                    }`}
                  />
                  {isMaskedValue && (
                    <button
                      type="button"
                      title={isVisible ? "Hide value" : "Show value"}
                      aria-label={isVisible ? "Hide value" : "Show value"}
                      onClick={() => toggleSecretVisibility(i)}
                      disabled={isActionDisabled}
                      className="shrink-0 text-text-muted hover:text-text-primary disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        {isVisible ? "visibility_off" : "visibility"}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    title="Remove header"
                    aria-label="Remove header"
                    onClick={() => removeRow(i)}
                    disabled={isActionDisabled}
                    className="shrink-0 text-text-muted hover:text-red-500 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={addRow}
              disabled={isActionDisabled}
              className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
              aria-label="Add header"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add header
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={isActionDisabled}
                onClick={resetToBuiltin}
                aria-label="Reset headers to defaults"
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-black/[0.03] dark:hover:bg-white/[0.03] disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                disabled={isActionDisabled}
                onClick={save}
                aria-label="Save custom headers"
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

CustomConfigCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
