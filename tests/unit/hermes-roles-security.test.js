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
  home = fs.mkdtempSync(path.join(tmpBase(), "9router-hermes-sec-"));
  osMock.home = home;
  osMock.platform = "linux";
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Hermes roles and security contracts", () => {
  it("rejects invalid role names not in CLI_TOOLS whitelist", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");

    const res = await POST(
      req({
        baseUrl: "http://localhost:20128",
        selections: [
          { role: "default", model: "model-a" },
          { role: "malicious_role_injection", model: "model-b" },
        ],
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid Hermes role/);
  });

  it("rejects models with newline characters to prevent YAML block injection", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");

    const res = await POST(
      req({
        baseUrl: "http://localhost:20128",
        selections: [
          { role: "default", model: "model-a\n  injected_key: value" },
        ],
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid model/);
  });

  it("safely quotes YAML scalars and maintains valid configuration structure", async () => {
    const { POST, GET } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");

    const res = await POST(
      req({
        baseUrl: "http://localhost:20128/v1",
        selections: [
          { role: "default", model: 'test/model:"special"' },
          { role: "delegation", model: "subagent/model" },
          { role: "vision", model: "vision/model" },
        ],
      })
    );
    expect(res.status).toBe(200);

    const configPath = path.join(home, ".hermes", "config.yaml");
    const content = fs.readFileSync(configPath, "utf-8");

    // Double quoted scalar with escaped quotes
    expect(content).toContain('default: "test/model:\\"special\\""');
    expect(content).toContain('delegation:');
    expect(content).toContain('auxiliary:');
    expect(content).toContain('vision:');

    const getRes = await GET();
    expect(getRes.status).toBe(200);
    expect(getRes.body.settings.model.default).toBe('test/model:"special"');
    expect(getRes.body.settings.delegation.model).toBe("subagent/model");
    expect(getRes.body.settings.auxiliary.vision.model).toBe("vision/model");
  });

  it("refuses to overwrite an unreadable config file", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");
    const configPath = path.join(home, ".hermes", "config.yaml");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    // Directory instead of file causes read error
    await fsp.mkdir(configPath);

    const res = await POST(
      req({
        baseUrl: "http://localhost:20128",
        model: "test/model",
      })
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/refusing to overwrite it/);
  });

  it("DELETE removes only 9Router managed model blocks", async () => {
    const { POST, DELETE } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");

    await POST(
      req({
        baseUrl: "http://localhost:20128",
        selections: [
          { role: "default", model: "test/model" },
          { role: "vision", model: "vision/model" },
        ],
      })
    );

    const delRes = await DELETE();
    expect(delRes.status).toBe(200);

    const configPath = path.join(home, ".hermes", "config.yaml");
    const content = fs.readFileSync(configPath, "utf-8");
    expect(content.trim()).toBe("");
  });
});
