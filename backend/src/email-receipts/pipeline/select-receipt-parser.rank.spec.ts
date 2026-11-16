import {
  rankReceiptParsers,
  selectReceiptParser,
} from "./select-receipt-parser";

const parser = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "approved" as const,
  fromDomains: ["shop.example.com"],
  subjectContains: [] as string[],
  createdAt: new Date("2026-09-01T00:00:00Z"),
  ...over,
});

describe("rankReceiptParsers", () => {
  it("lists every approved parser that fits, best first: the more specific domain, then the older, then the lower id", () => {
    const general = parser("general", { fromDomains: ["example.com"] });
    const specific = parser("specific", {
      fromDomains: ["orders.shop.example.com"],
    });
    const older = parser("older", {
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    const newer = parser("newer", {
      createdAt: new Date("2026-09-05T00:00:00Z"),
    });
    const ranked = rankReceiptParsers(
      [newer, general, older, specific],
      "orders.shop.example.com",
      "Your order",
    );
    expect(ranked.map((p) => p.id)).toEqual([
      "specific",
      "older",
      "newer",
      "general",
    ]);
  });

  it("leaves out drafts, parsers for another domain and parsers whose subject words are absent", () => {
    const ranked = rankReceiptParsers(
      [
        parser("draft", { status: "draft" }),
        parser("other", { fromDomains: ["other.example.org"] }),
        parser("subject", { subjectContains: ["invoice"] }),
        parser("fits"),
      ],
      "shop.example.com",
      "Your order",
    );
    expect(ranked.map((p) => p.id)).toEqual(["fits"]);
  });

  it("is empty for an empty sender, and the head is what selectReceiptParser returns", () => {
    expect(rankReceiptParsers([parser("a")], "", "s")).toEqual([]);
    const parsers = [parser("b"), parser("a")];
    expect(selectReceiptParser(parsers, "shop.example.com", "s")?.id).toBe("a");
    expect(selectReceiptParser([], "shop.example.com", "s")).toBeNull();
  });
});
