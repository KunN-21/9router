import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { writeAtomic, assertSafePath } from "@/lib/cliTools/configFile";

export const dynamic = "force-dynamic";

const getCodexDir = () => path.join(os.homedir(), ".codex");

const isValidProfileName = (name) => {
  if (typeof name !== "string") return false;
  const clean = name.trim().toLowerCase();
  return (
    /^[a-zA-Z0-9_-]+$/.test(clean) &&
    clean.length <= 64 &&
    clean !== "config" &&
    clean !== "auth"
  );
};

const isValidModel = (model) => {
  return (
    typeof model === "string" &&
    model.trim().length > 0 &&
    model.length <= 256 &&
    !/[\r\n"]/.test(model)
  );
};

// GET - List all custom profiles from ~/.codex/*.config.toml
export async function GET() {
  try {
    const codexDir = getCodexDir();
    let files = [];
    try {
      files = await fs.readdir(codexDir);
    } catch (err) {
      if (err.code === "ENOENT") return NextResponse.json({ profiles: [] });
      throw err;
    }

    const profileFiles = files.filter(
      (file) =>
        file.endsWith(".config.toml") &&
        file !== "config.toml" &&
        !file.startsWith(".")
    );

    const profiles = await Promise.all(
      profileFiles.map(async (file) => {
        const name = file.replace(/\.config\.toml$/, "");
        const filePath = path.join(codexDir, file);
        try {
          await assertSafePath(filePath, codexDir);
          const content = await fs.readFile(filePath, "utf-8");
          const match = content.match(/^\s*model\s*=\s*(["'])([^"\n]+)\1/m);
          return {
            name,
            model: match ? match[2] : "",
            command: `codex -p ${name}`,
          };
        } catch {
          return { name, model: "", command: `codex -p ${name}` };
        }
      })
    );

    profiles.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ profiles });
  } catch (error) {
    console.error("Error reading codex profiles:", error);
    return NextResponse.json({ error: "Failed to read profiles" }, { status: 500 });
  }
}

// POST - Create or update a profile ~/.codex/<name>.config.toml
export async function POST(request) {
  try {
    const { name, model } = await request.json();

    const cleanName = typeof name === "string" ? name.trim().toLowerCase() : "";
    if (!isValidProfileName(cleanName)) {
      return NextResponse.json(
        { error: "Profile name can only contain alphanumeric characters, dashes, underscores and cannot be 'config' or 'auth'" },
        { status: 400 }
      );
    }

    const cleanModel = typeof model === "string" ? model.trim() : "";
    if (!isValidModel(cleanModel)) {
      return NextResponse.json({ error: "Invalid model name" }, { status: 400 });
    }

    const codexDir = getCodexDir();
    const filePath = path.join(codexDir, `${cleanName}.config.toml`);

    await assertSafePath(filePath, codexDir);
    await fs.mkdir(codexDir, { recursive: true });

    const content = `# codex -p ${cleanName}\nmodel = "${cleanModel}"\nmodel_provider = "9router"\n`;
    await writeAtomic(filePath, content);

    return NextResponse.json({
      success: true,
      profile: {
        name: cleanName,
        model: cleanModel,
        command: `codex -p ${cleanName}`,
      },
    });
  } catch (error) {
    console.error("Error saving codex profile:", error);
    return NextResponse.json({ error: error.message || "Failed to save profile" }, { status: 500 });
  }
}

// DELETE - Remove a profile ~/.codex/<name>.config.toml
export async function DELETE(request) {
  try {
    const { name } = await request.json();
    const cleanName = typeof name === "string" ? name.trim().toLowerCase() : "";

    if (!isValidProfileName(cleanName)) {
      return NextResponse.json({ error: "Invalid profile name" }, { status: 400 });
    }

    const codexDir = getCodexDir();
    const filePath = path.join(codexDir, `${cleanName}.config.toml`);

    await assertSafePath(filePath, codexDir);

    try {
      const stat = await fs.lstat(filePath);
      if (stat.isDirectory()) {
        return NextResponse.json({ error: "Cannot delete directory" }, { status: 400 });
      }
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code === "ENOENT") {
        return NextResponse.json({ error: "Profile not found" }, { status: 404 });
      }
      throw err;
    }

    return NextResponse.json({ success: true, message: `Profile ${cleanName} deleted` });
  } catch (error) {
    console.error("Error deleting codex profile:", error);
    return NextResponse.json({ error: error.message || "Failed to delete profile" }, { status: 500 });
  }
}
