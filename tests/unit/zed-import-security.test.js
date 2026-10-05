import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status ?? 200, body }),
  },
}));

describe("Zed IDE auto-import security and guard contracts", () => {
  it("protects /api/oauth/zed/auto-import in ALWAYS_PROTECTED and LOCAL_ONLY_PATHS", async () => {
    const fs = await import("node:fs/promises");
    const guardContent = await fs.readFile(
      new URL("../../src/dashboardGuard.js", import.meta.url),
      "utf-8"
    );

    expect(guardContent).toMatch(
      /const ALWAYS_PROTECTED = \[[^\]]*"\/api\/oauth\/zed\/auto-import"[^\]]*\]/s
    );
    expect(guardContent).toMatch(
      /const LOCAL_ONLY_PATHS = \[[^\]]*"\/api\/oauth\/zed\/auto-import"[^\]]*\]/s
    );
  });

  it("POST /api/oauth/zed/import requires accessToken and userId", async () => {
    const { POST } = await import("../../src/app/api/oauth/zed/import/route.js");
    const req = (body) => ({ json: async () => body });

    const res1 = await POST(req({}));
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/Access token is required/);

    const res2 = await POST(req({ accessToken: "test-token" }));
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/User id is required/);
  });

  it("resolves default Zed credential URL as https://zed.dev", async () => {
    const { resolveZedCredentialsUrl, ZED_DEFAULT_CREDENTIALS_URL } = await import(
      "../../src/lib/oauth/utils/zedCredentials.js"
    );

    expect(ZED_DEFAULT_CREDENTIALS_URL).toBe("https://zed.dev");
    const url = await resolveZedCredentialsUrl();
    expect(url).toBe("https://zed.dev");
  });
});
