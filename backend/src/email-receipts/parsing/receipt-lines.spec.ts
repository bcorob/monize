import {
  itemSectionRange,
  normalizeLine,
  normalizeReceiptLines,
  traceLine,
  traceSubject,
} from "./receipt-lines";
import { MAX_TRACE_LINE_LENGTH } from "./receipt-parser.types";

describe("normalizeLine: characters that show nothing", () => {
  it("drops zero-width characters, bidi embeddings, soft hyphens and the byte order mark", () => {
    expect(normalizeLine("Nr zamówienia ‫171-7401618-6873900")).toBe(
      "Nr zamówienia 171-7401618-6873900",
    );
    expect(normalizeLine("a​b‌c‍d⁠e﻿­f͏g")).toBe("abcdefg");
    expect(normalizeLine("‎12,00‏ zł")).toBe("12,00 zł");
  });

  it("makes a line of nothing but invisible characters and spaces empty, so it is dropped", () => {
    expect(normalizeReceiptLines("a\n‌ ‌ ‌\n͏ ­\nb")).toEqual(["a", "b"]);
  });

  it("keeps visible text, including non-Latin scripts", () => {
    expect(normalizeLine("Zażółć gęślą jaźń 日本語")).toBe(
      "Zażółć gęślą jaźń 日本語",
    );
  });
});

describe("itemSectionRange", () => {
  const lines = ["a", "Start", "b", "c", "Stop", "d"];

  it("is the whole text without markers", () => {
    expect(itemSectionRange(lines, undefined, undefined)).toEqual({
      start: 0,
      end: 6,
    });
  });

  it("starts after the first start line and ends before the first stop line after it", () => {
    expect(itemSectionRange(lines, "start", "STOP")).toEqual({
      start: 2,
      end: 4,
    });
  });

  it("is empty when the start marker never appears, and never inverted", () => {
    expect(itemSectionRange(lines, "nope", undefined)).toEqual({
      start: 0,
      end: 0,
    });
    expect(itemSectionRange(lines, "Start", "b")).toEqual({ start: 2, end: 2 });
  });
});

describe("traceLine and traceSubject", () => {
  it("number lines from 1, and the subject as line 0", () => {
    expect(traceLine(["x", "y"], 1)).toEqual({ line: 2, text: "y" });
    expect(traceSubject("Order")).toEqual({ line: 0, text: "Order" });
  });

  it("cut the text to 200 characters", () => {
    const long = "z".repeat(500);
    expect(traceLine([long], 0).text).toHaveLength(MAX_TRACE_LINE_LENGTH);
    expect(traceSubject(long).text).toHaveLength(MAX_TRACE_LINE_LENGTH);
  });

  it("is empty for a line that does not exist", () => {
    expect(traceLine([], 3)).toEqual({ line: 4, text: "" });
  });
});
