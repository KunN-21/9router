import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const osMock = vi.hoisted(() => ({ home: "", platform: "linux" }));
vi.mock("os", () => ({
  default: { homedir: () => osMock.home, platform: () => osMock.platform },
  homedir: () => osMock.home,
  platform: () => osMock.platform,
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status ?? 200, body }),
  },
}));

const req = (body) => ({ json: async () => body });
const tmpBase = () => process.env.TEMP || process.env.TMPDIR || "/tmp";

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(tmpBase(), "9router-b8c-sec-"));
  osMock.home = home;
  osMock.platform = "linux";
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("B8c CLI tools security and no-clobber contracts", () => {
  it("Pi POST refuses to overwrite a malformed models.json", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/pi-settings/route.js");
    const filePath = path.join(home, ".pi", "agent", "models.json");
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, "{bad-json");

    const res = await POST(req({ baseUrl: "http://localhost:20128", model: "test/model" }));
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/refusing to overwrite it/);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("{bad-json");
  });

  it("Crush POST refuses to overwrite a malformed crush.json", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/crush-settings/route.js");
    const filePath = path.join(home, ".config", "crush", "crush.json");
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, '{"providers": [malformed');

    const res = await POST(req({ baseUrl: "http://localhost:20128", model: "test/model" }));
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/refusing to overwrite it/);
    expect(fs.readFileSync(filePath, "utf-8")).toBe('{"providers": [malformed');
  });

  it("Forge POST refuses to overwrite a malformed config.toml", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/forge-settings/route.js");
    const filePath = path.join(home, ".forge", "config.toml");
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, "invalid = = toml");

    const res = await POST(req({ baseUrl: "http://localhost:20128", model: "test/model" }));
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/refusing to overwrite it/);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("invalid = = toml");
  });

  it("Smelt POST refuses to overwrite a malformed config.json", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/smelt-settings/route.js");
    const filePath = path.join(home, ".smelt", "config.json");
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, "not a valid json");

    const res = await POST(req({ baseUrl: "http://localhost:20128", model: "test/model" }));
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/refusing to overwrite it/);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("not a valid json");
  });

  it("CodeWhale POST refuses to overwrite a malformed config.toml", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/codewhale-settings/route.js");
    const filePath = path.join(home, ".codewhale", "config.toml");
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, "[broken-toml");

    const res = await POST(req({ baseUrl: "http://localhost:20128", model: "test/model" }));
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/refusing to overwrite it/);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("[broken-toml");
  });
});

describe("Codex profiles security contracts", () => {
  it("rejects invalid profile names, traversal, and reserved names", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/codex-profiles/route.js");

    const cases = [
      "config",
      "auth",
      "../escape",
      "a/b",
      "profile with spaces",
      "tool!",
      "a".repeat(65),
    ];

    for (const name of cases) {
      const res = await POST(req({ name, model: "test/model" }));
      expect(res.status).toBe(400);
    }
  });

  it("rejects deleting config.toml or auth.json via DELETE", async () => {
    const { DELETE } = await import("../../src/app/api/cli-tools/codex-profiles/route.js");

    const res1 = await DELETE(req({ name: "config" }));
    expect(res1.status).toBe(400);

    const res2 = await DELETE(req({ name: "auth" }));
    expect(res2.status).toBe(400);
  });

  it("creates valid profile file and deletes it cleanly", async () => {
    const { POST, DELETE, GET } = await import("../../src/app/api/cli-tools/codex-profiles/route.js");

    const postRes = await POST(req({ name: "claude-fast", model: "anthropic/claude-3-5-haiku" }));
    expect(postRes.status).toBe(200);
    expect(postRes.body.success).toBe(true);

    const filePath = path.join(home, ".codex", "claude-fast.config.toml");
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain('model = "anthropic/claude-3-5-haiku"');
    expect(content).toContain('model_provider = "9router"');

    const getRes = await GET();
    expect(getRes.status).toBe(200);
    expect(getRes.body.profiles.some((p) => p.name === "claude-fast")).toBe(true);

    const delRes = await DELETE(req({ name: "claude-fast" }));
    expect(delRes.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
