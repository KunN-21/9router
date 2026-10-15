import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const db = vi.hoisted(() => ({ keys: [{ key: "sk-db-active-1", isActive: true }] }));
vi.mock("@/lib/db", () => ({ getApiKeys: vi.fn(async () => db.keys) }));

const osMock = vi.hoisted(() => ({ home: "", platform: "linux" }));
vi.mock("os", async () => {
  const actual = await vi.importActual("os");
  return { ...actual, default: { ...actual, homedir: () => osMock.home, platform: () => osMock.platform }, homedir: () => osMock.home, platform: () => osMock.platform };
});

vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ status: init?.status ?? 200, body }) } }));

import { POST as piPOST } from "@/app/api/cli-tools/pi-settings/route.js";

const req = (body) => ({ json: async () => body });
const cfgPath = () => path.join(osMock.home, ".pi", "agent", "models.json");
const read = () => fsp.readFile(cfgPath(), "utf-8");
const stored = { id: "gpt-5.4-mini", name: "My Mini", contextWindow: 400000, maxTokens: 65536, thinkingLevelMap: { low: "low" }, compat: { strictTools: true } };

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "9router-pi-meta-"));
  osMock.home = home;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const seed = async (models) => {
  await fsp.mkdir(path.dirname(cfgPath()), { recursive: true });
  await fsp.writeFile(cfgPath(), JSON.stringify({ providers: { "9router": {
    baseUrl: "http://localhost:20128/v1", apiKey: "sk-existing-keep", api: "anthropic-messages", models,
  } } }, null, 2));
  return read();
};
const post = (models) => piPOST(req({ baseUrl: "http://localhost:20128", apiKey: "sk-test", models }));

describe("Pi settings metadata merge", () => {
  it.each([
    ["restore metadata with a bare id", ["gpt-5.4-mini"], [stored]],
    ["explicit partial missing fields with an object", [{ id: "gpt-5.4-mini", contextWindow: 128000 }], [{ ...stored, contextWindow: 128000 }]],
  ])("merges %s", async (_label, models, expected) => {
    await seed([stored]);
    const res = await post(models);
    expect(res.status).toBe(200);
    expect(JSON.parse(await read()).providers["9router"]).toMatchObject({
      api: "anthropic-messages", models: expected,
    });
  });

  it.each([
    ["a non-positive safe integer limit", { id: "gpt-5.4-mini", contextWindow: 0 }, /contextWindow/],
    ["a model entry without an id", {}, /non-empty id/],
  ])("rejects %s with 400 and no write", async (_label, entry, message) => {
    const before = await seed([stored]);
    const res = await post([entry]);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(message);
    expect(await read()).toBe(before);
  });

  it("keeps generic defaults for a brand-new model id", async () => {
    expect((await post(["new/model"])).status).toBe(200);
    expect(JSON.parse(await read()).providers["9router"].models)
      .toEqual([{ id: "new/model", name: "new/model", contextWindow: 128000, maxTokens: 16384 }]);
  });

  it("refuses to overwrite a malformed existing config and leaves it untouched", async () => {
    const before = '{"providers": {"9router": {"apiKey": "keep"';
    await fsp.mkdir(path.dirname(cfgPath()), { recursive: true });
    await fsp.writeFile(cfgPath(), before);
    const res = await post(["a/b"]);
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/refusing to overwrite it/);
    expect(await read()).toBe(before);
  });
});
