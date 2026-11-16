import { readFileSync } from "fs";
import { join } from "path";
import {
  RECEIPT_AUTOMATIC_AI_INSTRUCTION,
  RECEIPT_CATEGORIZE_INSTRUCTION,
  RECEIPT_CHAT_INSTRUCTION,
  RECEIPT_PARSED_INSTRUCTION,
  RECEIPT_TRADE_CHAT_INSTRUCTION,
  RECEIPT_TRADE_CHAT_INSTRUCTIONS,
  receiptInstructionKey,
} from "./receipt-instructions";

describe("receiptInstructionKey", () => {
  it("names each fixed instruction the pipeline writes", () => {
    expect(receiptInstructionKey(RECEIPT_AUTOMATIC_AI_INSTRUCTION)).toBe(
      "automatic",
    );
    expect(receiptInstructionKey(RECEIPT_CHAT_INSTRUCTION)).toBe("chat");
    expect(receiptInstructionKey(RECEIPT_CATEGORIZE_INSTRUCTION)).toBe(
      "categorize",
    );
    expect(receiptInstructionKey(RECEIPT_PARSED_INSTRUCTION)).toBe("parsed");
  });

  it("keeps the earlier buy-or-sell text of a trade request as tradeChat, so a request queued before dividends still reads in the person's language", () => {
    expect(RECEIPT_TRADE_CHAT_INSTRUCTIONS[0]).toBe(
      RECEIPT_TRADE_CHAT_INSTRUCTION,
    );
    expect(RECEIPT_TRADE_CHAT_INSTRUCTION).toContain("dividend");
    for (const text of RECEIPT_TRADE_CHAT_INSTRUCTIONS) {
      expect(receiptInstructionKey(text)).toBe("tradeChat");
    }
    expect(
      RECEIPT_TRADE_CHAT_INSTRUCTIONS.some((text) =>
        text.includes("the buy or sell, the ticker"),
      ),
    ).toBe(true);
  });

  it("is null for any other text, a rule's own words included", () => {
    expect(receiptInstructionKey("Split it by product")).toBeNull();
    expect(receiptInstructionKey(`${RECEIPT_PARSED_INSTRUCTION} `)).toBeNull();
  });
});

describe("where the fixed instructions are imported from", () => {
  it("is the leaf file only: the pipeline service does not re-export them", () => {
    const src = readFileSync(
      join(__dirname, "email-receipt-pipeline.service.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/export\s*\{[^}]*RECEIPT_\w+_INSTRUCTION/);
  });
});
