import { describe, expect, it } from "vitest";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { CLAUDE_BLOCK } from "../../open-sse/translator/schema/index.js";
const SIG = "Em9wYXF1ZS1wYXlsb2Fk"; // valid E-form: Buffer.from(SIG,"base64")[0] === 0x12
const b = blocks => ({ messages: [{ role: "assistant", content: blocks }] });

describe("Claude thinking blocks filtering & opaque preservation", () => {
  it("drops blank THINKING block and preserves valid REDACTED_THINKING", () => {
    // SIG là E-form hợp lệ (base64 giải mã[0] === 0x12). Drop phải do thinking rỗng,
    // không phải do signature sai — nếu không case này pass ngay và không RED.
    const body1 = b([{ type: CLAUDE_BLOCK.THINKING, thinking: "   ", signature: SIG }, { type: CLAUDE_BLOCK.TEXT, text: "Ans" }]);
    normalizeClaudePassthrough(body1, "claude-sonnet-4-6");
    expect(body1.messages[0].content).toHaveLength(1);
    expect(body1.messages[0].content[0].type).toBe(CLAUDE_BLOCK.TEXT);

    // REDACTED_THINKING là opaque data: không có trường thinking nên không rơi vào carve-out.
    const opaque = { type: CLAUDE_BLOCK.REDACTED_THINKING, data: "YWJj", signature: SIG };
    const body2 = b([opaque, { type: CLAUDE_BLOCK.TEXT, text: "Ans" }]);
    normalizeClaudePassthrough(body2, "claude-sonnet-4-6");
    expect(body2.messages[0].content).toHaveLength(2);
    expect(body2.messages[0].content[0]).toEqual(opaque);

    // Control: THINKING có nội dung thật + signature hợp lệ vẫn giữ nguyên.
    const body3 = b([{ type: CLAUDE_BLOCK.THINKING, thinking: "real reasoning", signature: SIG }, { type: CLAUDE_BLOCK.TEXT, text: "Ans" }]);
    normalizeClaudePassthrough(body3, "claude-sonnet-4-6");
    expect(body3.messages[0].content).toHaveLength(2);
  });
});
