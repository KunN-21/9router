export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { safeYamlScalar } from "@/lib/cliTools/configFile";

import {
  parseModelBlock,
  parseDelegationBlock,
  parseAuxRoles,
  upsertModelBlock,
  upsertDelegationBlock,
  upsertAuxRole,
  removeModelBlock,
  removeDelegationBlock,
  removeAuxRole,
  upsertEnvVar,
  has9RouterConfig,
  isCustomBlock,
  parseSttBlock,
  is9RouterStt,
  upsertStt9Router,
  removeStt9Router,
} from "./hermesYaml.js";
import { resolveHermesHome, listProfiles, dirExists } from "./hermesProfiles.js";

const execAsync = promisify(exec);

const PROVIDER_NAME = "9router";
const API_KEY_ENV = "OPENAI_API_KEY";
const MAX_MODEL_LENGTH = 256;

const ALLOWED_ROLES = new Set([
  "default",
  "delegation",
  ...(CLI_TOOLS.hermes?.roles || []).map((r) => r.id),
]);

// Local builders quote every scalar so a crafted model id cannot inject YAML keys.
const buildModelBlock = (model, baseUrl) =>
  `model:\n  default: ${safeYamlScalar(model)}\n  provider: "custom"\n  base_url: ${safeYamlScalar(baseUrl)}\n  api_key: \${OPENAI_API_KEY}\n`;

const buildDelegationBlock = (model, baseUrl) =>
  `delegation:\n  model: ${safeYamlScalar(model)}\n  provider: "custom"\n  base_url: ${safeYamlScalar(baseUrl)}\n  api_key: \${OPENAI_API_KEY}\n`;

const buildAuxRoleBlock = (role, model, baseUrl) =>
  `  ${role}:\n    provider: "custom"\n    model: ${safeYamlScalar(model)}\n    base_url: ${safeYamlScalar(baseUrl)}\n    api_key: \${OPENAI_API_KEY}\n`;

// Profile comes from ?profile= on GET (all-statuses calls GET() with no argument at all,
// so every reader must tolerate a missing request) and from the JSON body on POST/DELETE.
// POST/DELETE fall back to the query string — callers reach for either.
const getQueryParam = (request, key) => {
  if (!request) return null;
  try {
    const url = request.nextUrl || (typeof request.url === "string" ? new URL(request.url) : null);
    return url?.searchParams?.get(key) || null;
  } catch {
    return null;
  }
};

const getProfileParam = (request) => getQueryParam(request, "profile");

const truthy = (value) => value === true || value === "true" || value === "1";

const resolveHome = (profile) => {
  try {
    return { home: resolveHermesHome(profile) };
  } catch (error) {
    return { error: error.message };
  }
};

// A file that exists but cannot be read must never be silently replaced — the caller
// would lose every hand-written block in it.
const readTextFile = async (file) => {
  try {
    return await fs.readFile(file, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error(`${file} exists but could not be read (${error.message}); refusing to overwrite it`);
  }
};

const readConfigYaml = (home) => readTextFile(home.configPath);
const readEnvFile = (home) => readTextFile(home.envPath);

// Named profile homes are created by `hermes profile create` — never by us: a directory
// without identity files is not a profile, and we must not fabricate one.
const writeHomeConfig = async (home, yaml) => {
  if (home.isDefault) await fs.mkdir(home.dir, { recursive: true });
  await fs.writeFile(home.configPath, yaml);
};

// Only ever upserts the OPENAI_API_KEY line — per-profile .env files also carry bot tokens
// and messaging-channel credentials that must stay untouched.
const writeHomeEnv = async (home, apiKey) => {
  if (!apiKey) return;
  if (home.isDefault) await fs.mkdir(home.dir, { recursive: true });
  const env = upsertEnvVar(await readEnvFile(home), API_KEY_ENV, apiKey);
  await fs.writeFile(home.envPath, env);
};

const checkHermesInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where hermes" : "which hermes";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(resolveHermesHome(null).configPath);
      return true;
    } catch {
      return false;
    }
  }
};

export async function GET(request) {
  try {
    const installed = await checkHermesInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Hermes Agent is not installed" });
    }

    const { home, error } = resolveHome(getProfileParam(request));
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (!home.isDefault && !(await dirExists(home.dir))) {
      return NextResponse.json({ error: `Hermes profile "${home.name}" not found` }, { status: 404 });
    }

    const yaml = await readConfigYaml(home);
    const model = parseModelBlock(yaml);
    const delegation = parseDelegationBlock(yaml);
    const auxiliary = parseAuxRoles(yaml);
    const stt = parseSttBlock(yaml);
    return NextResponse.json({
      installed: true,
      profile: { name: home.name, dir: home.dir, isDefault: home.isDefault },
      settings: { model, delegation, auxiliary, stt },
      has9Router: has9RouterConfig(model) || has9RouterConfig(delegation) || Object.values(auxiliary).some(has9RouterConfig),
      has9RouterStt: is9RouterStt(stt),
      configPath: home.configPath,
    });
  } catch (error) {
    console.error("Error checking hermes settings:", error.message);
    return NextResponse.json({ error: error.message || "Failed to check hermes settings" }, { status: 500 });
  }
}

// Endpoint + API key across every profile: refresh the 9router blocks each profile already
// has (models stay per-profile), and wire up profiles that have no main model yet using the
// model chosen in this request. Profiles on another provider are reported, never rewritten.
const applyToAllProfiles = async ({ normalizedBaseUrl, apiKey, model }) => {
  const profiles = await listProfiles();
  const results = [];
  for (const profile of profiles) {
    const home = resolveHermesHome(profile.name);
    try {
      let yaml = await readConfigYaml(home);
      const main = parseModelBlock(yaml);

      if (main?.default && isCustomBlock(main)) {
        yaml = upsertModelBlock(yaml, buildModelBlock(main.default, normalizedBaseUrl));
        const delegation = parseDelegationBlock(yaml);
        if (delegation?.model && isCustomBlock(delegation)) {
          yaml = upsertDelegationBlock(yaml, buildDelegationBlock(delegation.model, normalizedBaseUrl));
        }
        for (const [role, cfg] of Object.entries(parseAuxRoles(yaml))) {
          if (cfg?.model && isCustomBlock(cfg)) {
            yaml = upsertAuxRole(yaml, role, buildAuxRoleBlock(role, cfg.model, normalizedBaseUrl));
          }
        }
        await writeHomeConfig(home, yaml);
        await writeHomeEnv(home, apiKey);
        results.push({ profile: profile.name, status: "updated", model: main.default });
      } else if (main?.default) {
        results.push({
          profile: profile.name,
          status: "skipped",
          reason: `main model uses provider "${main.provider || "unknown"}" — configure this profile individually`,
        });
      } else if (model) {
        yaml = upsertModelBlock(yaml, buildModelBlock(model, normalizedBaseUrl));
        await writeHomeConfig(home, yaml);
        await writeHomeEnv(home, apiKey);
        results.push({ profile: profile.name, status: "updated", model });
      } else {
        results.push({ profile: profile.name, status: "skipped", reason: "no main model configured" });
      }
    } catch (error) {
      results.push({ profile: profile.name, status: "failed", reason: error.message });
    }
  }
  const updated = results.filter((r) => r.status === "updated").length;
  return NextResponse.json({
    success: updated > 0,
    bulk: true,
    results,
    updated,
    skipped: results.length - updated,
    message: `Updated endpoint on ${updated} profile(s)`,
  });
};

export async function POST(request) {
  try {
    const body = await request.json();
    const { baseUrl, apiKey, model, selections, audio } = body;

    if (!baseUrl || typeof baseUrl !== "string" || /[\r\n]/.test(baseUrl)) {
      return NextResponse.json({ error: "Valid baseUrl is required" }, { status: 400 });
    }
    if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== "string" || /[\r\n]/.test(apiKey))) {
      return NextResponse.json({ error: "Invalid apiKey" }, { status: 400 });
    }

    // selections: [{role, model}] — "default" plus any auxiliary/delegation slots.
    // Legacy callers (CLI quick setup) send a bare `model` → treat as default role.
    const sel = Array.isArray(selections) && selections.some((s) => s?.role && s?.model)
      ? selections.filter((s) => s?.role && s?.model)
      : typeof model === "string" && model.trim() ? [{ role: "default", model: model.trim() }] : [];
    const defaultSel = sel.find((s) => s.role === "default");
    if (!baseUrl || (!defaultSel && !audio)) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    // Validate roles and models at the trust boundary — this is the gate the CLI bypasses.
    for (const item of sel) {
      if (!ALLOWED_ROLES.has(item.role)) {
        return NextResponse.json({ error: `Invalid Hermes role: ${item.role}` }, { status: 400 });
      }
      if (
        typeof item.model !== "string" ||
        item.model.trim().length === 0 ||
        item.model.length > MAX_MODEL_LENGTH ||
        /[\r\n]/.test(item.model)
      ) {
        return NextResponse.json({ error: `Invalid model for role: ${item.role}` }, { status: 400 });
      }
    }

    // audio: { enabled, model } — wire Hermes speech-to-text through 9router's
    // /v1/audio/transcriptions. Absent = leave the stt section untouched (legacy CLI
    // callers). enabled:true needs a provider-qualified STT model (9router routes on it);
    // enabled:false removes exactly the wiring this endpoint writes.
    const audioEnabled = audio ? truthy(audio.enabled) : false;
    const audioModel = typeof audio?.model === "string" ? audio.model.trim() : "";
    if (audioEnabled && !audioModel) {
      return NextResponse.json({ error: "audio.model is required when enabling audio transcription" }, { status: 400 });
    }
    if (audioModel.length > MAX_MODEL_LENGTH || /[\r\n]/.test(audioModel)) {
      return NextResponse.json({ error: "Invalid audio model" }, { status: 400 });
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    // applyToAll refreshes endpoint + API key only (and the model blocks those belong to);
    // the stt wiring is per-profile and follows the single-profile path below.
    if (truthy(body.applyToAll ?? getQueryParam(request, "applyToAll"))) {
      return await applyToAllProfiles({ normalizedBaseUrl, apiKey, model: defaultSel?.model });
    }

    // Profile target: JSON body first, then ?profile= — callers reach for either.
    const { home, error } = resolveHome(body.profile ?? getProfileParam(request));
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (!home.isDefault && !(await dirExists(home.dir))) {
      return NextResponse.json({ error: `Hermes profile "${home.name}" not found` }, { status: 404 });
    }

    // Update config.yaml — upsert each role block, keep everything else
    let newYaml = await readConfigYaml(home);
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
    if (audio) {
      if (audioEnabled) {
        newYaml = upsertStt9Router(newYaml, audioModel, normalizedBaseUrl);
      } else if (is9RouterStt(parseSttBlock(newYaml))) {
        // Never remove stt wiring this endpoint did not write — a user's own STT
        // provider choice survives an audio-disabled Apply.
        newYaml = removeStt9Router(newYaml);
      }
    }
    await writeHomeConfig(home, newYaml);

    // Update .env — upsert OPENAI_API_KEY only when caller provides one
    await writeHomeEnv(home, apiKey);

    return NextResponse.json({
      success: true,
      message: home.isDefault ? "Hermes settings applied successfully!" : `Hermes settings applied to profile "${home.name}"!`,
      profile: { name: home.name, dir: home.dir, isDefault: home.isDefault },
      stt9Router: is9RouterStt(parseSttBlock(newYaml)),
      configPath: home.configPath,
    });
  } catch (error) {
    console.error("Error updating hermes settings:", error.message);
    return NextResponse.json({ error: error.message || "Failed to update hermes settings" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    let body = null;
    if (request && typeof request.json === "function") {
      try {
        body = await request.json();
      } catch {
        body = null; // CLI reset sends an empty body → default profile
      }
    }

    const { home, error } = resolveHome(body?.profile ?? getProfileParam(request));
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (!home.isDefault && !(await dirExists(home.dir))) {
      return NextResponse.json({ error: `Hermes profile "${home.name}" not found` }, { status: 404 });
    }

    let yaml = "";
    try {
      yaml = await fs.readFile(home.configPath, "utf-8");
    } catch (readError) {
      if (readError.code === "ENOENT") {
        return NextResponse.json({ success: true, profile: home.name, message: "No config file to reset" });
      }
      throw new Error(`${home.configPath} exists but could not be read (${readError.message}); refusing to overwrite it`);
    }

    // Only drop blocks 9router wrote (custom provider) — a model/delegation/aux block owned
    // by another provider is this profile's own configuration and must survive a reset.
    const removed = { model: false, delegation: false, auxiliary: [], stt: false };
    const kept = [];

    const main = parseModelBlock(yaml);
    if (main && isCustomBlock(main)) {
      yaml = removeModelBlock(yaml);
      removed.model = true;
    } else if (main) {
      kept.push("model");
    }

    const delegation = parseDelegationBlock(yaml);
    if (delegation && isCustomBlock(delegation)) {
      yaml = removeDelegationBlock(yaml);
      removed.delegation = true;
    } else if (delegation) {
      kept.push("delegation");
    }

    for (const [role, cfg] of Object.entries(parseAuxRoles(yaml))) {
      if (isCustomBlock(cfg)) {
        yaml = removeAuxRole(yaml, role);
        removed.auxiliary.push(role);
      }
    }

    const sttCfg = parseSttBlock(yaml);
    if (sttCfg && is9RouterStt(sttCfg)) {
      yaml = removeStt9Router(yaml);
      removed.stt = true;
      // User settings living inside the block (language, local, ...) survive the key
      // removal — report the remainder as kept, like any other preserved section.
      if (parseSttBlock(yaml)) kept.push("stt");
    } else if (sttCfg) {
      kept.push("stt");
    }

    yaml = yaml.replace(/^\n+/, "");
    await writeHomeConfig(home, yaml);

    const scope = home.isDefault ? "" : ` in profile "${home.name}"`;
    return NextResponse.json({
      success: true,
      profile: home.name,
      removed,
      kept,
      message: `${PROVIDER_NAME} model blocks removed${scope}`,
    });
  } catch (error) {
    console.error("Error resetting hermes settings:", error.message);
    return NextResponse.json({ error: error.message || "Failed to reset hermes settings" }, { status: 500 });
  }
}
