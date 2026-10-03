// B8b: settings store coalescing, error cleanup, PATCH preservation, stale-GET guard.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let store;
const okJson = (data) => ({ ok: true, json: async () => data });

async function freshStore() {
  vi.resetModules();
  const mod = await import("@/store/settingsStore.js");
  return mod.default;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0));
  vi.unstubAllGlobals();
  store = await freshStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("settings store", () => {
  it("RED: concurrent cold GET issues one network call and all callers receive result", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return okJson({ requireApiKey: true, hasPassword: true });
    }));
    const [a, b, c] = await Promise.all([
      store.getState().fetchSettings({ force: true }),
      store.getState().fetchSettings({ force: true }),
      store.getState().fetchSettings({ force: true }),
    ]);
    expect(calls).toBe(1);
    expect(a).toMatchObject({ requireApiKey: true });
    expect(b).toMatchObject({ requireApiKey: true });
    expect(c).toMatchObject({ requireApiKey: true });
  });

  it("RED: force bypasses TTL but does not duplicate an in-flight GET", async () => {
    let calls = 0;
    let release;
    vi.stubGlobal("fetch", vi.fn(() => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve(okJson({ a: 1 })); });
    }));
    const p1 = store.getState().fetchSettings({ force: true });
    const p2 = store.getState().fetchSettings({ force: true });
    release();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it("RED: fetch rejection releases in-flight so next attempt succeeds", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(okJson({ requireApiKey: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await store.getState().fetchSettings({ force: true })).toBeNull();
    expect(store.getState().loading).toBe(false);
    expect(store.getState().error).toBeTruthy();
    expect(await store.getState().fetchSettings({ force: true })).toMatchObject({ requireApiKey: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("RED: res.json rejection releases in-flight and reports error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => { throw new Error("bad json"); } })
      .mockResolvedValueOnce(okJson({ requireApiKey: false }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await store.getState().fetchSettings({ force: true })).toBeNull();
    expect(store.getState().loading).toBe(false);
    expect(await store.getState().fetchSettings({ force: true })).toMatchObject({ requireApiKey: false });
  });

  it("RED: PATCH merges onto cache preserving hasPassword; PATCH error keeps cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u, o) => {
      if (o?.method === "PATCH") return okJson({ requireApiKey: true });
      return okJson({ requireApiKey: false, hasPassword: true });
    }));
    await store.getState().fetchSettings({ force: true });
    const updated = await store.getState().patchSettings({ requireApiKey: true });
    expect(updated).toMatchObject({ requireApiKey: true });
    expect(store.getState().settings).toMatchObject({ requireApiKey: true, hasPassword: true });

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "no" }) })));
    expect(await store.getState().patchSettings({ requireApiKey: false })).toBeNull();
    expect(store.getState().settings).toMatchObject({ requireApiKey: true, hasPassword: true });
  });

  it("RED: stale GET resolving after successful PATCH must not clobber newer value", async () => {
    let resolveGet;
    vi.stubGlobal("fetch", vi.fn((u, o) => {
      if (o?.method === "PATCH") return Promise.resolve(okJson({ requireApiKey: true }));
      return new Promise((resolve) => { resolveGet = resolve; });
    }));
    const pending = store.getState().fetchSettings({ force: true });
    await store.getState().patchSettings({ requireApiKey: true });
    resolveGet(okJson({ requireApiKey: false, hasPassword: true }));
    expect(await pending).toMatchObject({ requireApiKey: true, hasPassword: true });
    expect(store.getState().settings).toMatchObject({ requireApiKey: true, hasPassword: true });
  });

  it("cold cache still captures hasPassword from GET", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ requireApiKey: false, hasPassword: true })));
    expect(await store.getState().fetchSettings({ force: true })).toMatchObject({ hasPassword: true });
  });
});
