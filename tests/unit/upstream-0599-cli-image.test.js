import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";

import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";

describe("Image usage and CLI lifecycle selective upstream fixes", () => {
  describe("Codex image token usage tracking (e10da160)", () => {
    it("parses exact Responses usage from stream and invokes onUsage callback", async () => {
      const sseBody = [
        'event: response.output_item.done\n',
        'data: {"item":{"type":"image_generation_call","result":"fake_b64"}}\n\n',
        'event: response.completed\n',
        'data: {"response":{"usage":{"input_tokens":1200,"output_tokens":2500,"input_tokens_details":{"cached_tokens":300}}}}\n\n',
      ].join("");

      const response = new Response(sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      });

      const onUsage = vi.fn();
      const result = await codexImageAdapter.parseResponse(response, {
        log: null,
        streamToClient: false,
        onUsage,
      });

      expect(result.data[0].b64_json).toBe("fake_b64");
      expect(onUsage).toHaveBeenCalledWith({
        prompt_tokens: 1200,
        completion_tokens: 2500,
        total_tokens: 3700,
        cached_tokens: 300,
      });
    });
  });

  describe("CLI server lifecycle attachment order (PR 4522)", () => {
    it("attaches server lifecycle events before entering trayMode branch", () => {
      const cliPath = path.resolve(__dirname, "../../cli/cli.js");
      const content = fs.readFileSync(cliPath, "utf8");

      const attachPos = content.indexOf("attachServerEvents();");
      const trayPos = content.indexOf("if (trayMode)");

      expect(attachPos).toBeGreaterThan(-1);
      expect(trayPos).toBeGreaterThan(-1);
      expect(attachPos).toBeLessThan(trayPos);
    });
  });
});
