import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readSource = (relativePath) =>
  readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("B8c UI Accessibility and Contracts", () => {
  it("GenericCliToolCard has accessible labels and clear buttons with aria-label", async () => {
    const card = await readSource(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/GenericCliToolCard.js"
    );

    expect(card).toContain('aria-label={`Remove model ${modelId}`}');
    expect(card).toContain('aria-label="Clear selected model"');
    expect(card).toContain('aria-label="Select Model"');
  });

  it("HermesToolCard has accessible labels on buttons and role inputs", async () => {
    const card = await readSource(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/HermesToolCard.js"
    );

    expect(card).toContain('aria-label="Clear default model"');
    expect(card).toContain('aria-label="Select default model"');
    expect(card).toContain('aria-label={`Clear model for ${role.label}`}');
    expect(card).toContain('aria-label={`Select model for ${role.label}`}');
  });

  it("CodexToolCard includes accessible labels and ConfirmModal for profile delete", async () => {
    const card = await readSource(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js"
    );

    expect(card).toContain('aria-label="Clear selected model"');
    expect(card).toContain('aria-label="Select main model"');
    expect(card).toContain('aria-label="Clear subagent model"');
    expect(card).toContain('aria-label="Select subagent model"');
    expect(card).toContain('aria-label="Clear model input"');
    expect(card).toContain('aria-label="Select Model"');
    expect(card).toContain('aria-label={`Copy command ${p.command}`}');
    expect(card).toContain('aria-label={`Delete profile ${p.name}`}');
    expect(card).toContain("<ConfirmModal");
    expect(card).toContain('title="Delete Codex Profile"');
  });

  it("OAuthModal guards paste-token UI when PASTE_TOKEN_PROVIDERS has no entry for provider", async () => {
    const modal = await readSource(
      "../../src/shared/components/OAuthModal.js"
    );

    expect(modal).toContain("{PASTE_TOKEN_PROVIDERS[provider] && (");
    expect(modal).toContain('{authMode === "paste-token" && PASTE_TOKEN_PROVIDERS[provider] && (');
  });
});
