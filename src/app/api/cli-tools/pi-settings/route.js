export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { readExistingConfig } from "@/lib/cliTools/readExistingConfig";
import { writeAtomic, assertSafePath } from "@/lib/cliTools/configFile";

const execAsync = promisify(exec);

const getPiModelsJsonPath = () => {
  return path.join(os.homedir(), ".pi", "agent", "models.json");
};

const getPiDir = () => path.dirname(getPiModelsJsonPath());

const checkPiInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where pi" : "which pi";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getPiModelsJsonPath());
      return true;
    } catch {
      try {
        await fs.access(path.join(os.homedir(), ".pi", "models.json"));
        return true;
      } catch {
        return false;
      }
    }
  }
};

const has9RouterConfig = (settings) => {
  if (!settings || !settings.providers) return false;
  const p = settings.providers["9router"];
  if (p && p.baseUrl) return true;
  for (const prov of Object.values(settings.providers)) {
    if (prov.baseUrl && prov.baseUrl.includes("20128")) return true;
  }
  return false;
};

const isPositiveSafeInteger = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

// Id đã trim của một entry models, cho cả chuỗi lẫn object. Chuỗi nơi nào cũng là id.
const piModelId = (item) => (typeof item === "string" ? item.trim()
  : item && typeof item.id === "string" ? item.id.trim() : "");

// Ghép một model Pi vào entry đã lưu cùng id. Chuỗi incoming chuẩn hoá thành `{ id: incoming }`
// rồi chạy chung một đường validate/default với object: kế thừa toàn bộ metadata prev,
// field thiếu lấy default. Chuỗi mới (chưa có prev) ra `{ id, name: id,
// contextWindow: 128000, maxTokens: 16384 }`; chuỗi đã có prev giữ nguyên toàn bộ prev.
// Object: field explicit thắng kể cả `128000`, field thiếu kế thừa.
// Id rỗng/limit invalid trả `null` để route trả `400`, không ghi file.
// ponytail: body đến qua request.json() nên `undefined` không đi qua wire; spread chỉ
// tạo own property và không viết prototype. Xem lại nếu thêm caller không phải JSON.
function mergePiModelEntry(incoming, prev) {
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
  const item = typeof incoming === "string" ? { id: incoming } : incoming;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const id = piModelId(item);
  if (!id) return null;
  if (item.contextWindow !== undefined && !isPositiveSafeInteger(item.contextWindow)) return null;
  if (item.maxTokens !== undefined && !isPositiveSafeInteger(item.maxTokens)) return null;
  const merged = { ...base, ...item, id };
  if (typeof merged.name !== "string" || !merged.name.trim()) merged.name = id;
  if (!isPositiveSafeInteger(merged.contextWindow)) merged.contextWindow = DEFAULT_CONTEXT_WINDOW;
  if (!isPositiveSafeInteger(merged.maxTokens)) merged.maxTokens = DEFAULT_MAX_TOKENS;
  return merged;
}

const resolveModelsJsonPath = async () => {
  const agentPath = getPiModelsJsonPath();
  const rootPath = path.join(os.homedir(), ".pi", "models.json");
  try {
    await fs.access(agentPath);
    return agentPath;
  } catch {
    try {
      await fs.access(rootPath);
      return rootPath;
    } catch {
      return agentPath;
    }
  }
};

const readConfig = async () => {
  try {
    const targetPath = await resolveModelsJsonPath();
    const content = await fs.readFile(targetPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};

export async function GET() {
  try {
    const installed = await checkPiInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Pi CLI is not installed",
      });
    }

    const config = await readConfig();
    const configPath = await resolveModelsJsonPath();

    return NextResponse.json({
      installed: true,
      config,
      has9Router: has9RouterConfig(config),
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  try {
    const { baseUrl, apiKey, model } = rawBody || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    const configPath = await resolveModelsJsonPath();
    await assertSafePath(configPath, path.join(os.homedir(), ".pi"));

    const existingConfig = await readExistingConfig(configPath, JSON.parse);
    const existing = existingConfig ? { ...existingConfig } : {};

    if (!existing.providers) existing.providers = {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const existingProvider = existing.providers?.["9router"] || {};

    const prevModels = new Map();
    for (const item of Array.isArray(existingProvider.models) ? existingProvider.models : []) {
      const prevId = piModelId(item);
      if (prevId && !prevModels.has(prevId)) prevModels.set(prevId, item);
    }

    const rawItems = Array.isArray(rawBody.models) && rawBody.models.length > 0
      ? rawBody.models
      : (typeof model === "string" && model.trim() ? [model.trim()] : []);

    const modelList = [];
    for (const item of rawItems) {
      const merged = mergePiModelEntry(item, prevModels.get(piModelId(item)));
      if (!merged) {
        return NextResponse.json(
          { error: { message: "Each model needs a non-empty id and a positive integer contextWindow/maxTokens" } },
          { status: 400 },
        );
      }
      modelList.push(merged);
    }

    if (modelList.length === 0) {
      modelList.push({
        id: "provider/model-id",
        name: "provider/model-id",
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
      });
    }

    existing.providers["9router"] = {
      ...existingProvider,
      baseUrl: normalizedBaseUrl,
      apiKey: await resolveCliApiKey(apiKey, existingProvider.apiKey),
      api: existingProvider.api || "openai-completions",
      models: modelList,
    };

    await writeAtomic(configPath, JSON.stringify(existing, null, 2));

    return NextResponse.json({
      success: true,
      message: "Pi settings applied! Use /model in Pi to select the 9Router model.",
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = await resolveModelsJsonPath();
    await assertSafePath(configPath, path.join(os.homedir(), ".pi"));

    const existingConfig = await readExistingConfig(configPath, JSON.parse);
    if (!existingConfig) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    const existing = { ...existingConfig };

    if (existing.providers && existing.providers["9router"]) {
      delete existing.providers["9router"];
      if (Object.keys(existing.providers).length === 0) delete existing.providers;
      await writeAtomic(configPath, JSON.stringify(existing, null, 2));
    }

    return NextResponse.json({ success: true, message: "9Router removed from Pi" });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
