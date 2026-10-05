export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { writeAtomic, assertSafePath, safeYamlScalar } from "@/lib/cliTools/configFile";

const execAsync = promisify(exec);

const PROVIDER_NAME = "9router";
const API_KEY_ENV = "OPENAI_API_KEY";

const getHermesDir = () => path.join(os.homedir(), ".hermes");
const getHermesConfigPath = () => path.join(getHermesDir(), "config.yaml");
const getHermesEnvPath = () => path.join(getHermesDir(), ".env");

const ALLOWED_ROLES = new Set([
  "default",
  "delegation",
  ...(CLI_TOOLS.hermes?.roles || []).map((r) => r.id),
]);

// Match top-level "model:" block (until next non-indented, non-empty line)
const MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;
const DELEGATION_BLOCK_RE = /^delegation:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;
// "auxiliary:" block; children are 2-space-indented role keys with 4+-space fields
const AUX_BLOCK_RE = /^auxiliary:[ \t]*\r?\n((?:(?:[ \t]+.*\r?\n?)|(?:[ \t]*\r?\n))*)/m;
const auxRoleRe = (role) => new RegExp(`^  ${role}:[ \\t]*\\r?\\n(?:(?:[ \\t]{4,}.*\\r?\\n?)|(?:[ \\t]*\\r?\\n))*`, "m");

const buildModelBlock = (model, baseUrl) =>
  `model:\n  default: ${safeYamlScalar(model)}\n  provider: "custom"\n  base_url: ${safeYamlScalar(baseUrl)}\n  api_key: \${OPENAI_API_KEY}\n`;

const buildDelegationBlock = (model, baseUrl) =>
  `delegation:\n  model: ${safeYamlScalar(model)}\n  provider: "custom"\n  base_url: ${safeYamlScalar(baseUrl)}\n  api_key: \${OPENAI_API_KEY}\n`;

const buildAuxRoleBlock = (role, model, baseUrl) =>
  `  ${role}:\n    provider: "custom"\n    model: ${safeYamlScalar(model)}\n    base_url: ${safeYamlScalar(baseUrl)}\n    api_key: \${OPENAI_API_KEY}\n`;

const parseYamlScalarValue = (raw) => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed || null;
};

// Parse current model block back to fields (best-effort, simple key:value)
const parseModelBlock = (yaml) => {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] || "";
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(.*)$`, "m"));
    return m ? parseYamlScalarValue(m[1]) : null;
  };
  return {
    default: get("default"),
    provider: get("provider"),
    base_url: get("base_url"),
    api_key: get("api_key"),
  };
};

const upsertModelBlock = (yaml, newBlock) => {
  if (MODEL_BLOCK_RE.test(yaml)) return yaml.replace(MODEL_BLOCK_RE, newBlock);
  return yaml.length > 0 ? `${newBlock}\n${yaml}` : newBlock;
};

const upsertDelegationBlock = (yaml, newBlock) => {
  if (DELEGATION_BLOCK_RE.test(yaml)) return yaml.replace(DELEGATION_BLOCK_RE, newBlock);
  return yaml.endsWith("\n") || yaml.length === 0 ? `${yaml}${newBlock}` : `${yaml}\n${newBlock}`;
};

const removeDelegationBlock = (yaml) => yaml.replace(DELEGATION_BLOCK_RE, "");

const upsertAuxRole = (yaml, role, roleBlock) => {
  const re = auxRoleRe(role);
  const m = yaml.match(AUX_BLOCK_RE);
  if (!m) {
    const block = `auxiliary:\n${roleBlock}`;
    return yaml.endsWith("\n") || yaml.length === 0 ? `${yaml}${block}` : `${yaml}\n${block}`;
  }
  const body = re.test(m[1]) ? m[1].replace(re, roleBlock) : `${m[1]}${roleBlock}`;
  return yaml.replace(AUX_BLOCK_RE, `auxiliary:\n${body}`);
};

const removeAuxRole = (yaml, role) => {
  const m = yaml.match(AUX_BLOCK_RE);
  if (!m) return yaml;
  const body = m[1].replace(auxRoleRe(role), "");
  if (body.trim() === "") return yaml.replace(AUX_BLOCK_RE, "");
  return yaml.replace(AUX_BLOCK_RE, `auxiliary:\n${body}`);
};

// role -> { model, provider, base_url } for every entry under "auxiliary:"
const parseAuxRoles = (yaml) => {
  const m = yaml.match(AUX_BLOCK_RE);
  if (!m) return {};
  const roles = {};
  const subRe = /^  ([A-Za-z0-9_]+):[ \t]*\r?\n((?:(?:[ \t]{4,}.*\r?\n?)|(?:[ \t]*\r?\n))*)/gm;
  let sm;
  while ((sm = subRe.exec(m[1]))) {
    const get = (key) => {
      const km = sm[2].match(new RegExp(`^[ \\t]+${key}:[ \\t]*(.*)$`, "m"));
      return km ? parseYamlScalarValue(km[1]) : null;
    };
    roles[sm[1]] = { model: get("model"), provider: get("provider"), base_url: get("base_url") };
  }
  return roles;
};

const parseDelegationBlock = (yaml) => {
  const match = yaml.match(DELEGATION_BLOCK_RE);
  if (!match) return null;
  const body = match[1] || "";
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(.*)$`, "m"));
    return m ? parseYamlScalarValue(m[1]) : null;
  };
  return { model: get("model"), provider: get("provider"), base_url: get("base_url") };
};

const removeModelBlock = (yaml) => yaml.replace(MODEL_BLOCK_RE, "").replace(/^\n+/, "");

// .env helpers — upsert/remove single KEY=VALUE line
const upsertEnvVar = (envText, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(envText)) return envText.replace(re, line);
  return envText.length > 0 && !envText.endsWith("\n") ? `${envText}\n${line}\n` : `${envText}${line}\n`;
};

const checkHermesInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where hermes" : "which hermes";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getHermesConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfigYaml = async () => {
  const filePath = getHermesConfigPath();
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error(`${filePath} exists but could not be read (${error.message}); refusing to overwrite it`);
  }
};

const readEnvFile = async () => {
  const filePath = getHermesEnvPath();
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error(`${filePath} exists but could not be read (${error.message}); refusing to overwrite it`);
  }
};

// Detect 9router by base_url containing localhost/127.0.0.1 or matching tunnel URL
const has9RouterConfig = (modelCfg) => {
  if (!modelCfg?.base_url) return false;
  return modelCfg.provider === "custom" && /localhost|127\.0\.0\.1|0\.0\.0\.0|20128/.test(modelCfg.base_url);
};

export async function GET() {
  try {
    const installed = await checkHermesInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Hermes Agent is not installed" });
    }
    const yaml = await readConfigYaml();
    const model = parseModelBlock(yaml);
    const delegation = parseDelegationBlock(yaml);
    const auxiliary = parseAuxRoles(yaml);
    return NextResponse.json({
      installed: true,
      settings: { model, delegation, auxiliary },
      has9Router: has9RouterConfig(model) || has9RouterConfig(delegation) || Object.values(auxiliary).some(has9RouterConfig),
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    console.error("Error checking hermes settings:", error.message);
    return NextResponse.json({ error: error.message || "Failed to check hermes settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, selections } = await request.json();

    if (!baseUrl || typeof baseUrl !== "string" || /[\r\n]/.test(baseUrl)) {
      return NextResponse.json({ error: "Valid baseUrl is required" }, { status: 400 });
    }

    // selections: [{role, model}] — "default" plus any auxiliary/delegation slots.
    // Legacy callers (CLI quick setup) send a bare `model` → treat as default role.
    const sel = Array.isArray(selections) && selections.some((s) => s?.role && s?.model)
      ? selections.filter((s) => s?.role && s?.model)
      : (typeof model === "string" && model.trim()) ? [{ role: "default", model: model.trim() }] : [];

    const defaultSel = sel.find((s) => s.role === "default");
    if (!defaultSel) {
      return NextResponse.json({ error: "baseUrl and default model are required" }, { status: 400 });
    }

    // Validate roles and models
    for (const item of sel) {
      if (!ALLOWED_ROLES.has(item.role)) {
        return NextResponse.json({ error: `Invalid Hermes role: ${item.role}` }, { status: 400 });
      }
      if (typeof item.model !== "string" || item.model.trim().length === 0 || item.model.length > 256 || /[\r\n]/.test(item.model)) {
        return NextResponse.json({ error: `Invalid model for role: ${item.role}` }, { status: 400 });
      }
    }

    const dir = getHermesDir();
    const configPath = getHermesConfigPath();
    const envPath = getHermesEnvPath();

    await assertSafePath(configPath, dir);
    await assertSafePath(envPath, dir);
    await fs.mkdir(dir, { recursive: true });

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    // Update config.yaml — upsert each role block, keep everything else
    let newYaml = await readConfigYaml();
    for (const { role, model: roleModel } of sel) {
      const cleanModel = roleModel.trim();
      if (role === "default") {
        newYaml = upsertModelBlock(newYaml, buildModelBlock(cleanModel, normalizedBaseUrl));
      } else if (role === "delegation") {
        newYaml = upsertDelegationBlock(newYaml, buildDelegationBlock(cleanModel, normalizedBaseUrl));
      } else {
        newYaml = upsertAuxRole(newYaml, role, buildAuxRoleBlock(role, cleanModel, normalizedBaseUrl));
      }
    }

    await writeAtomic(configPath, newYaml);

    // Update .env — upsert OPENAI_API_KEY only when caller provides one
    if (apiKey && typeof apiKey === "string" && !/[\r\n]/.test(apiKey)) {
      const existingEnv = await readEnvFile();
      const newEnv = upsertEnvVar(existingEnv, API_KEY_ENV, apiKey.trim());
      await writeAtomic(envPath, newEnv);
    }

    return NextResponse.json({
      success: true,
      message: "Hermes settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.error("Error updating hermes settings:", error.message);
    return NextResponse.json({ error: error.message || "Failed to update hermes settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getHermesConfigPath();
    await assertSafePath(configPath, getHermesDir());

    let yaml = "";
    try {
      yaml = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw new Error(`${configPath} exists but could not be read (${error.message}); refusing to overwrite it`);
    }

    let newYaml = removeModelBlock(yaml);
    newYaml = removeDelegationBlock(newYaml);
    // Only drop auxiliary entries we manage (custom provider, any base URL — covers tunnels)
    for (const [role, cfg] of Object.entries(parseAuxRoles(yaml))) {
      if (cfg?.provider === "custom") newYaml = removeAuxRole(newYaml, role);
    }
    newYaml = newYaml.replace(/^\n+/, "");
    await writeAtomic(configPath, newYaml);
    return NextResponse.json({ success: true, message: `${PROVIDER_NAME} model blocks removed` });
  } catch (error) {
    console.error("Error resetting hermes settings:", error.message);
    return NextResponse.json({ error: error.message || "Failed to reset hermes settings" }, { status: 500 });
  }
}
