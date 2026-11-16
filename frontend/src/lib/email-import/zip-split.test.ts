import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { looksLikeZip, newZipBudget, splitZip } from "./zip-split";

function message(n: number, body = 10): string {
  return `From s${n}@x Mon\nSubject: ${n}\n\n${"b".repeat(body)}\n\n`;
}

function zipFile(
  entries: Record<string, string | Uint8Array>,
  level: 0 | 6 = 6,
  name = "takeout.zip",
) {
  const data: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(entries)) {
    data[key] = typeof value === "string" ? strToU8(value) : value;
  }
  return new File([zipSync(data, { level })], name);
}

describe("looksLikeZip", () => {
  it("accepts the name or the magic number", () => {
    expect(looksLikeZip("A.ZIP", new Uint8Array([0, 0, 0, 0]))).toBe(true);
    expect(looksLikeZip("data", new Uint8Array([0x50, 0x4b, 3, 4, 9]))).toBe(
      true,
    );
    expect(looksLikeZip("data.mbox", strToU8("From x"))).toBe(false);
  });
});

describe("splitZip", () => {
  it("splits an mbox entry into parts as it inflates", async () => {
    const msgs = [1, 2, 3, 4, 5].map((n) => message(n, 40));
    const zip = zipFile({ "Takeout/Mail/All.mbox": msgs.join("") });
    const result = await splitZip(zip, {
      maxPartBytes: msgs[0].length * 2 + 5,
      sliceBytes: 37,
    });
    expect(result.error).toBeNull();
    expect(result.ignoredEntries).toBe(0);
    expect(result.oversizedMessages).toBe(0);
    expect(
      result.parts.map((p) => [p.file.name, p.messages, p.origin]),
    ).toEqual([
      ["takeout-All-1.mbox", 2, "takeout.zip"],
      ["takeout-All-2.mbox", 2, "takeout.zip"],
      ["takeout-All-3.mbox", 1, "takeout.zip"],
    ]);
    const texts = await Promise.all(result.parts.map((p) => p.file.text()));
    expect(texts.join("")).toBe(msgs.join(""));
  });

  it("reads stored (uncompressed) entries too", async () => {
    const text = message(1) + message(2);
    const result = await splitZip(zipFile({ "a.mbx": text }, 0), {
      sliceBytes: 50,
    });
    expect(result.parts).toHaveLength(1);
    expect(await result.parts[0].file.text()).toBe(text);
    expect(result.parts[0].messages).toBe(2);
  });

  it("makes each eml and msg entry its own part", async () => {
    const result = await splitZip(
      zipFile({
        "x/one.eml": message(1),
        "x/two.MSG": "binary-ish",
        "three.eml": message(3),
      }),
    );
    expect(result.parts.map((p) => [p.file.name, p.messages])).toEqual([
      ["one.eml", 1],
      ["two.MSG", 1],
      ["three.eml", 1],
    ]);
    expect(await result.parts[0].file.text()).toBe(message(1));
  });

  it("reads an entry with no extension as mbox only when it starts with From", async () => {
    const result = await splitZip(
      zipFile({
        "Mail/mbox": message(1) + message(2),
        notes: "hello there",
        tiny: "Fr",
      }),
    );
    expect(result.parts.map((p) => [p.file.name, p.messages])).toEqual([
      ["takeout-mbox-1.mbox", 2],
    ]);
    expect(result.ignoredEntries).toBe(2);
  });

  it("counts folders, __MACOSX, nested zips and other files as ignored", async () => {
    const result = await splitZip(
      zipFile({
        "Takeout/": new Uint8Array(0),
        "Takeout/archive_browser.html": "<html></html>",
        "__MACOSX/._a.mbox": "x",
        "Takeout/._b.eml": "x",
        "inner.zip": "PK",
        "good.eml": message(1),
      }),
    );
    expect(result.parts).toHaveLength(1);
    expect(result.ignoredEntries).toBe(5);
    expect(result.error).toBeNull();
  });

  it("drops a message above the part limit and counts it", async () => {
    const small = message(1, 5);
    const zip = zipFile({
      "a.mbox": small + message(2, 600) + small,
      "big.eml": message(9, 600),
      "ok.eml": small,
    });
    const result = await splitZip(zip, { maxPartBytes: 200, sliceBytes: 64 });
    expect(result.oversizedMessages).toBe(2);
    expect(result.parts.map((p) => [p.file.name, p.messages])).toEqual([
      ["takeout-a-1.mbox", 1],
      ["takeout-a-2.mbox", 1],
      ["ok.eml", 1],
    ]);
  });

  it("refuses archives that together expand past the shared budget", async () => {
    // Highly compressible: 4,000 bytes of mail from a much smaller archive.
    const big = zipFile({ "a.mbox": message(1, 4000) });
    const budget = { remainingBytes: 6000 };
    const first = await splitZip(big, { budget });
    expect(first.error).toBeNull();
    expect(first.parts).toHaveLength(1);
    const second = await splitZip(
      zipFile({ "b.mbox": message(2, 4000) }, 6, "b.zip"),
      {
        budget,
      },
    );
    expect(second).toEqual({
      parts: [],
      ignoredEntries: 0,
      oversizedMessages: 0,
      error: "archive_too_large",
    });
    const message1 = await splitZip(zipFile({ "m.eml": "x".repeat(5000) }), {
      budget: { remainingBytes: 1000 },
    });
    expect(message1.error).toBe("archive_too_large");
    expect(newZipBudget().remainingBytes).toBe(512 * 1024 * 1024);
  });

  it("reports a damaged archive", async () => {
    const good = zipFile({ "a.mbox": message(1, 2000) });
    const bytes = new Uint8Array(await good.arrayBuffer());
    // Corrupt the deflate stream of the entry.
    for (let i = 40; i < 60; i++) bytes[i] = 0xff;
    const result = await splitZip(new File([bytes], "bad.zip"));
    expect(result).toEqual({
      parts: [],
      ignoredEntries: 0,
      oversizedMessages: 0,
      error: "invalid_archive",
    });
  });

  it("reports a file that is not a zip", async () => {
    const result = await splitZip(
      new File([strToU8("this is not an archive at all")], "x.zip"),
    );
    expect(result.error).toBe("invalid_archive");
    expect((await splitZip(new File([], "empty.zip"))).error).toBe(
      "invalid_archive",
    );
  });
});
