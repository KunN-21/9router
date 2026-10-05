export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { readExistingConfig } from "@/lib/cliTools/readExistingConfig";
import { writeAtomic, assertSafePath } from "@/lib/cliTools/configFile";

const execAsync = promisify(exec);

const getSmeltConfigPath = () => path.join(os.homedir(), ".smelt", "config.json");
const getSmeltDir = () => path.dirname(getSmeltConfigPath());

const checkSmeltInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where smelt" : "which smelt";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getSmeltConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const has9RouterConfig = (settings) => {
  if (!settings) return false;
  return (
    settings._managedBy === "9router" ||
    (typeof settings.baseUrl === "string" && settings.baseUrl.length > 0 && settings.baseUrl.includes("20128"))
  );
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getSmeltConfigPath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};

export async function GET() {
  try {
    const installed = await checkSmeltInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Smelt CLI is not installed",
      });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      has9Router: has9RouterConfig(config),
      configPath: getSmeltConfigPath(),
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

    const configPath = getSmeltConfigPath();
    const configDir = getSmeltDir();
    await assertSafePath(configPath, configDir);
    await fs.mkdir(configDir, { recursive: true });

    const existingConfig = await readExistingConfig(configPath, JSON.parse);
    const existing = existingConfig ? { ...existingConfig } : {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const updated = {
      ...existing,
      baseUrl: normalizedBaseUrl,
      apiKey: apiKey || "sk_9router",
      model: model || existing.model || "provider/model-id",
      _managedBy: "9router",
    };

    await writeAtomic(configPath, JSON.stringify(updated, null, 2));

    return NextResponse.json({
      success: true,
      message: "Smelt settings applied successfully!",
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getSmeltConfigPath();
    await assertSafePath(configPath, getSmeltDir());

    const existingConfig = await readExistingConfig(configPath, JSON.parse);
    if (!existingConfig) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    const existing = { ...existingConfig };

    delete existing.baseUrl;
    delete existing.apiKey;
    delete existing.model;
    delete existing._managedBy;

    if (Object.keys(existing).length === 0) {
      await fs.rm(configPath, { force: true });
    } else {
      await writeAtomic(configPath, JSON.stringify(existing, null, 2));
    }

    return NextResponse.json({ success: true, message: "Smelt 9Router settings removed" });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
