/**
 * No-clobber contract for CLI-tool settings writers.
 *
 * Old shape merged a few fields into whatever could be read and wrote the
 * result back, treating an unreadable file as empty. For `config.toml` that
 * discards every provider, MCP server and approval policy the user had; for
 * the Copilot provider array it drops every other model provider. Only ENOENT
 * means "start fresh".
 *
 * Semantic coverage of upstream d755e9006 + e307efdf8 (squashed, adapted):
 * shared safe reader, both POST paths, Copilot array guard, refusal surfaced.
 * Local Codex shape kept: static `http_headers` key, scalar
 * `agents.default_subagent_model`, no `auth.json` write path.
 *
 * All handler tests run against a mocked `os.homedir()` temp dir — never real
 * configs. No source-text assertions; every case drives the handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseTOML } from "confbox";
import { readExistingConfig } from "@/lib/cliTools/readExistingConfig.js";

const osMock = vi.hoisted(() => ({ home: "", platform: "linux" }));
vi.mock("os", () => ({
  default: { homedir: () => osMock.home, platform: () => osMock.platform },
  homedir: () => osMock.home,
  platform: () => osMock.platform,
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status ?? 200, body }) },
}));

const { POST: copilotPOST, DELETE: copilotDELETE } = await import(
  "../../src/app/api/cli-tools/copilot-settings/route.js"
);
const { POST: codexPOST } = await import(
  "../../src/app/api/cli-tools/codex-settings/route.js"
);

const req = (body) => ({ json: async () => body });
const tmpBase = () => process.env.TEMP || process.env.TMPDIR || "/tmp";
const copilotPath = (home) => path.join(home, ".config", "Code", "User", "chatLanguageModels.json");
const codexPath = (home) => path.join(home, ".codex", "config.toml");

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(tmpBase(), "9router-clitools-"));
  osMock.home = home;
  osMock.platform = "linux";
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("readExistingConfig", () => {
  it("returns null when the file does not exist", async () => {
    await expect(readExistingConfig(path.join(home, "absent.json"), JSON.parse)).resolves.toBeNull();
  });

  it("returns the parsed contents when the file is valid", async () => {
    const file = path.join(home, "auth.json");
    await fsp.writeFile(file, JSON.stringify({ tokens: { access: "keep-me" } }));

    await expect(readExistingConfig(file, JSON.parse)).resolves.toEqual({
      tokens: { access: "keep-me" },
    });
  });

  it("throws instead of reporting an empty config when the file is malformed", async () => {
    const file = path.join(home, "auth.json");
    await fsp.writeFile(file, '{"tokens": {"access": "keep-me"');

    await expect(readExistingConfig(file, JSON.parse)).rejects.toThrow(/refusing to overwrite it/);
    expect(fs.readFileSync(file, "utf-8")).toBe('{"tokens": {"access": "keep-me"');
  });

  it("names the file in the error so the user can fix it", async () => {
    const file = path.join(home, "config.toml");
    await fsp.writeFile(file, "not = = toml");

    await expect(
      readExistingConfig(file, (raw) => { throw new SyntaxError(`bad TOML near ${raw.length}`); })
    ).rejects.toThrow(new RegExp(`${path.basename(file)}.*bad TOML`));
  });

  it("propagates a read failure that is not ENOENT", async () => {
    const asDirectory = path.join(home, "auth.json");
    fs.mkdirSync(asDirectory);

    await expect(readExistingConfig(asDirectory, JSON.parse)).rejects.toThrow();
  });

  it("does not swallow a parser that returns undefined", async () => {
    const file = path.join(home, "empty.json");
    await fsp.writeFile(file, "");

    await expect(readExistingConfig(file, () => undefined)).resolves.toBeUndefined();
  });
});

describe("copilot POST", () => {
  const body = { baseUrl: "http://localhost:20128", apiKey: "sk-test", models: ["model-a"] };

  it("refuses to overwrite a malformed file and leaves it untouched", async () => {
    const file = copilotPath(home);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '[{"name": "Other"');

    const res = await copilotPOST(req(body));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/refusing to overwrite it/);
    expect(fs.readFileSync(file, "utf-8")).toBe('[{"name": "Other"');
  });

  it("creates the file when missing", async () => {
    const file = copilotPath(home);

    const res = await copilotPOST(req(body));

    expect(res.body.success).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(written).toHaveLength(1);
    expect(written[0].name).toBe("9Router");
    expect(written[0].models[0].id).toBe("model-a");
  });

  it("retains the user's other providers", async () => {
    const file = copilotPath(home);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const other = { name: "Other", vendor: "x", apiKey: "k", models: [{ id: "m" }] };
    await fsp.writeFile(file, JSON.stringify([other]));

    const res = await copilotPOST(req(body));

    expect(res.body.success).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(written).toHaveLength(2);
    expect(written).toContainEqual(other);
    expect(written.find((e) => e.name === "9Router").models[0].id).toBe("model-a");
  });
});

describe("copilot DELETE", () => {
  it("refuses to overwrite a non-array file and leaves it untouched", async () => {
    const file = copilotPath(home);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ providers: [] }));

    const res = await copilotDELETE();

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/refusing to overwrite it/);
    expect(fs.readFileSync(file, "utf-8")).toBe(JSON.stringify({ providers: [] }));
  });

  it("refuses to overwrite a malformed file and leaves it untouched", async () => {
    const file = copilotPath(home);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '[{"name": "Other"');

    const res = await copilotDELETE();

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/refusing to overwrite it/);
    expect(fs.readFileSync(file, "utf-8")).toBe('[{"name": "Other"');
  });

  it("removes only the 9Router entry and keeps other providers", async () => {
    const file = copilotPath(home);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const other = { name: "Other", vendor: "x", apiKey: "k", models: [{ id: "m" }] };
    const nine = { name: "9Router", vendor: "azure", apiKey: "k", models: [] };
    await fsp.writeFile(file, JSON.stringify([other, nine]));

    const res = await copilotDELETE();

    expect(res.body.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual([other]);
  });

  it("reports success without writing when the file is missing", async () => {
    const res = await copilotDELETE();

    expect(res.body.success).toBe(true);
    expect(fs.existsSync(copilotPath(home))).toBe(false);
  });
});

describe("codex POST", () => {
  const body = { baseUrl: "http://localhost:20128", apiKey: "sk-test", model: "m", subagentModel: "s" };

  it("refuses to overwrite a malformed config and leaves it untouched", async () => {
    const file = codexPath(home);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "[[[bad");

    const res = await codexPOST(req(body));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/refusing to overwrite it/);
    expect(fs.readFileSync(file, "utf-8")).toBe("[[[bad");
  });

  it("creates the config when missing, with the local static-key shape", async () => {
    const res = await codexPOST(req(body));

    expect(res.body.success).toBe(true);
    const parsed = parseTOML(fs.readFileSync(codexPath(home), "utf-8"));
    expect(parsed.model_providers["9router"].http_headers).toEqual({ Authorization: "Bearer sk-test" });
    expect(parsed.agents.default_subagent_model).toBe("s");
  });

  it("retains the user's other provider sections", async () => {
    const file = codexPath(home);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      'model = "other"\nmodel_provider = "other"\n\n[model_providers.other]\nname = "Other"\nbase_url = "https://other.example/v1"\nwire_api = "responses"\n'
    );

    const res = await codexPOST(req(body));

    expect(res.body.success).toBe(true);
    const parsed = parseTOML(fs.readFileSync(file, "utf-8"));
    expect(parsed.model_providers.other).toMatchObject({
      name: "Other",
      base_url: "https://other.example/v1",
    });
    expect(parsed.model_providers["9router"].name).toBe("9Router");
  });
});
