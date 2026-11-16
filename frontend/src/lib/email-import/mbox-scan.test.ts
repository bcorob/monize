import { describe, it, expect } from "vitest";
import { scanMbox, createMboxScanner } from "./mbox-scan";

const blob = (text: string) => new Blob([text]);

describe("scanMbox", () => {
  it("finds the separators after empty lines (LF)", async () => {
    const text =
      "From a@b Mon\nSubject: 1\n\nbody\n\nFrom c@d Tue\nSubject: 2\n\nx\n";
    const { starts } = await scanMbox(blob(text));
    expect(starts).toEqual([0, text.indexOf("From c@d")]);
  });

  it("finds the separators after empty lines (CRLF)", async () => {
    const text =
      "From a@b\r\nSubject: 1\r\n\r\nbody\r\n\r\nFrom c@d\r\nSubject: 2\r\n";
    const { starts } = await scanMbox(blob(text));
    expect(starts).toEqual([0, text.indexOf("From c@d")]);
  });

  it("does not treat a From line inside a body as a separator", async () => {
    const text =
      "From a@b\n\nI wrote\nFrom here on it is\n From x\nfrom y\n\nFrom c@d\n\nb\n";
    const { starts } = await scanMbox(blob(text));
    expect(starts).toEqual([0, text.indexOf("From c@d")]);
  });

  it("requires the space after From", async () => {
    const { starts } = await scanMbox(blob("From\n\nFrom:x\n\nFrom \n"));
    expect(starts).toEqual([blob("From\n\nFrom:x\n\n").size]);
  });

  it("starts at the first separator when text comes before it", async () => {
    const text = "leading text\nmore\n\nFrom a@b\n\nbody\n";
    const { starts } = await scanMbox(blob(text));
    expect(starts).toEqual([text.indexOf("From a@b")]);
  });

  it("does not start a message after a non-empty line", async () => {
    const { starts } = await scanMbox(blob("text\nFrom a@b\n\nbody"));
    expect(starts).toEqual([]);
  });

  it("returns nothing for an empty file", async () => {
    expect((await scanMbox(blob(""))).starts).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 13, 1000])(
    "gives the same offsets with %i byte slices (separators and CRLF cut by a boundary)",
    async (sliceBytes) => {
      const lf =
        "From a@b Mon\nSubject: 1\n\nbody\n\nFrom c@d Tue\n\nx\nFrom no\n\nFrom e@f\n\ny";
      const crlf =
        "From a@b\r\nS: 1\r\n\r\nbody\r\n\r\nFrom c@d\r\n\r\nx\r\nFrom no\r\n\r\nFrom e\r\n";
      for (const text of [lf, crlf]) {
        const whole = await scanMbox(blob(text));
        const sliced = await scanMbox(blob(text), { sliceBytes });
        expect(sliced.starts).toEqual(whole.starts);
        expect(whole.starts).toHaveLength(3);
      }
    },
  );

  it("accepts a CRLF empty line after an LF line, and not a bare CR", async () => {
    const { starts } = await scanMbox(blob("a\n\r\nFrom x\n"));
    expect(starts).toEqual([4]);
    expect((await scanMbox(blob("a\r\rFrom x\n"))).starts).toEqual([]);
  });

  it("scans a file larger than one default slice", async () => {
    const message = "From a@b\n\n" + "x".repeat(1024) + "\n\n";
    const count = 5000;
    const { starts } = await scanMbox(blob(message.repeat(count)), {
      sliceBytes: 1 << 20,
    });
    expect(starts).toHaveLength(count);
    expect(starts[1]).toBe(message.length);
  });
});

describe("createMboxScanner", () => {
  it("reports offsets across pushes", () => {
    const scanner = createMboxScanner();
    const enc = new TextEncoder();
    expect(scanner.push(enc.encode("From a\n\nb\n\nFr"))).toEqual([0]);
    expect(scanner.push(enc.encode("om c\n"))).toEqual([11]);
  });
});
