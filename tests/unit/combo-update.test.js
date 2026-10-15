import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getComboById: vi.fn(),
  getComboByName: vi.fn(),
  updateCombo: vi.fn(),
  deleteCombo: vi.fn(),
  resetComboRotation: vi.fn(),
}));

vi.mock("@/lib/localDb", () => mocks);
vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: mocks.resetComboRotation,
}));

import { PUT } from "../../src/app/api/combos/[id]/route.js";

const models = ["mistral/mistral-medium-latest", "cmc/deepseek/deepseek-v4-pro"];

function saveCombo(id, body) {
  return PUT(new Request(`http://localhost/api/combos/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: String(id) }) });
}

describe("PUT /api/combos/[id] update", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([5, "5", "f4e0c1e7-1f41-4ab2-9f25-094c3cc145bb"])(
    "keeps its own name when stored ID is %s", async id => {
      const previous = { id, name: "threads-combo", models: [...models].reverse() };
      const body = { name: previous.name, models };
      mocks.getComboByName.mockResolvedValue(previous);
      mocks.getComboById.mockResolvedValue(previous);
      mocks.updateCombo.mockResolvedValue({ ...previous, ...body });

      const response = await saveCombo(id, body);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...previous, ...body });
      expect(mocks.updateCombo).toHaveBeenCalledWith(String(id), body);
      expect(mocks.resetComboRotation).toHaveBeenCalledWith(previous.name);
    }
  );

  it.each([6, "other-combo-id"])("rejects another combo's name: %s", async id => {
    mocks.getComboByName.mockResolvedValue({ id, name: "taken" });
    const response = await saveCombo(5, { name: "taken", models });
    expect(response.status).toBe(400);
    expect(mocks.updateCombo).not.toHaveBeenCalled();
    expect(mocks.resetComboRotation).not.toHaveBeenCalled();
  });

  it("invalidates old and new rotation state on rename", async () => {
    mocks.getComboByName.mockResolvedValue(null);
    mocks.getComboById.mockResolvedValue({ id: 5, name: "before", models });
    mocks.updateCombo.mockResolvedValue({ id: 5, name: "after", models });
    const response = await saveCombo(5, { name: "after", models });
    expect(response.status).toBe(200);
    expect(mocks.resetComboRotation.mock.calls).toEqual([["before"], ["after"]]);
  });

  it("rejects invalid combo name format", async () => {
    const response = await saveCombo(5, { name: "invalid name with spaces", models });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Name can only contain letters, numbers, -, _ and ." });
    expect(mocks.getComboByName).not.toHaveBeenCalled();
  });

  it("returns 404 when combo to update is not found", async () => {
    mocks.getComboByName.mockResolvedValue(null);
    mocks.getComboById.mockResolvedValue(null);
    mocks.updateCombo.mockResolvedValue(null);
    const response = await saveCombo(5, { name: "threads-combo", models });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Combo not found" });
  });

  it("returns 500 when update fails with exception", async () => {
    mocks.getComboByName.mockResolvedValue(null);
    mocks.getComboById.mockRejectedValue(new Error("Database error"));
    const response = await saveCombo(5, { name: "threads-combo", models });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to update combo" });
  });
});
