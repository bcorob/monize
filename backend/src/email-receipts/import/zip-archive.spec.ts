import { strToU8, zipSync } from "fflate";
import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_REQUEST_BYTES,
  newZipBudget,
  readZip,
} from "./zip-archive";

const MESSAGE_LIMIT = 1_000;
const zip = (files: Parameters<typeof zipSync>[0]): Buffer =>
  Buffer.from(zipSync(files));
const text = (bytes: Buffer | null) => bytes?.toString("utf8");

/** Overwrite the uncompressed-size field of every entry header in `archive`. */
function lieAboutSize(archive: Buffer, declared: number): Buffer {
  const copy = Buffer.from(archive);
  for (let at = 0; at + 30 < copy.length; at += 1) {
    if (copy.readUInt32LE(at) === 0x04034b50)
      copy.writeUInt32LE(declared, at + 22);
    if (copy.readUInt32LE(at) === 0x02014b50)
      copy.writeUInt32LE(declared, at + 24);
  }
  return copy;
}

describe("readZip", () => {
  it("reads eml, mbox, mbx, msg and extension-less mbox entries and counts the rest", () => {
    const archive = zip({
      "Takeout/Mail/All.mbox": strToU8("From a@x\n\nSubject: A\n"),
      "Takeout/archive_browser.html": strToU8("<p>hi</p>"),
      "Takeout/dir/": new Uint8Array(0),
      "orders/one.EML": strToU8("Subject: one\n\nhi\n"),
      "orders/old.mbx": strToU8("From b@x\n\nSubject: B\n"),
      "orders/outlook.msg": new Uint8Array([1, 2, 3]),
      "apple/mbox": strToU8("From c@x\n\nSubject: C\n"),
      "apple/notes": strToU8("plain notes, not mail"),
      "nested.zip": strToU8("PK"),
      "__MACOSX/orders/._one.eml": strToU8("junk"),
      "x/._two.eml": strToU8("junk"),
    });

    const read = readZip(archive, newZipBudget(), MESSAGE_LIMIT);

    expect(read.error).toBeNull();
    expect(read.entries.map((e) => e.kind)).toEqual([
      "mbox",
      "eml",
      "mbox",
      "msg",
      "mbox",
    ]);
    expect(text(read.entries[1].bytes)).toBe("Subject: one\n\nhi\n");
    // html, folder, notes, nested zip, two AppleDouble files
    expect(read.ignored).toBe(6);
  });

  it("returns an eml entry above the message limit without its bytes, with a hash", () => {
    const body = "x".repeat(MESSAGE_LIMIT + 50);
    const read = readZip(
      zip({ "big.eml": strToU8(body) }),
      newZipBudget(),
      MESSAGE_LIMIT,
    );
    expect(read.error).toBeNull();
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0].bytes).toBeNull();
    expect(read.entries[0].size).toBe(body.length);
    expect(read.entries[0].rawSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops at the bytes the inflater produces, whatever the header declares", () => {
    const bomb = `From a@x\n\n${"A".repeat(50_000_000)}`;
    const honest = zip({ "bomb.mbox": strToU8(bomb) });
    expect(honest.length).toBeLessThan(100_000);
    const lying = lieAboutSize(honest, 10);

    const budget = { remainingBytes: 1_000_000 };
    const read = readZip(lying, budget, MESSAGE_LIMIT);

    expect(read.error).toBe("archive_too_large");
    expect(read.entries).toEqual([]);
    // Aborted within one pushed slice's output (16 KB at deflate's best ratio,
    // about 17 MB) past the ceiling, not after the 50 MB the header hid.
    expect(budget.remainingBytes).toBeGreaterThan(-18_000_000);
  });

  it("shares the ceiling across the archives of one request", () => {
    const part = zip({
      "a.mbox": strToU8(`From a@x\n\n${"B".repeat(600_000)}`),
    });
    const budget = { remainingBytes: 1_000_000 };
    expect(readZip(part, budget, MESSAGE_LIMIT).error).toBeNull();
    expect(readZip(part, budget, MESSAGE_LIMIT).error).toBe(
      "archive_too_large",
    );
  });

  it("keeps the entries read in full before the ceiling was passed", () => {
    const archive = zip({
      "a.eml": strToU8("Subject: a\n\nok\n"),
      "b.mbox": strToU8(`From a@x\n\n${"C".repeat(2_000_000)}`),
    });
    const read = readZip(archive, { remainingBytes: 500_000 }, MESSAGE_LIMIT);
    expect(read.error).toBe("archive_too_large");
    expect(read.entries.map((e) => e.kind)).toEqual(["eml"]);
  });

  it("refuses more entries than the limit", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++)
      files[`f${i}.txt`] = new Uint8Array(0);
    const read = readZip(zip(files), newZipBudget(), MESSAGE_LIMIT);
    expect(read.error).toBe("archive_too_large");
  });

  it("calls a corrupt or truncated archive invalid", () => {
    const garbage = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(60, 0xff),
    ]);
    expect(readZip(garbage, newZipBudget(), MESSAGE_LIMIT).error).toBe(
      "invalid_archive",
    );
    expect(
      readZip(Buffer.from("not a zip at all"), newZipBudget(), MESSAGE_LIMIT)
        .error,
    ).toBe("invalid_archive");

    let noise = "";
    for (let i = 0; i < 40_000; i++)
      noise += String.fromCharCode(33 + ((i * 7919) % 90));
    const whole = zip({ "m.mbox": strToU8(`From a@x\n\n${noise}`) });
    const cut = whole.subarray(0, Math.floor(whole.length / 2));
    expect(readZip(cut, newZipBudget(), MESSAGE_LIMIT).error).toBe(
      "invalid_archive",
    );
  });

  it("reads an empty archive as no entries and no error", () => {
    expect(readZip(zip({}), newZipBudget(), MESSAGE_LIMIT)).toEqual({
      entries: [],
      ignored: 0,
      error: null,
    });
  });

  it("holds the request ceiling at 100 MB", () => {
    expect(MAX_ZIP_REQUEST_BYTES).toBe(100 * 1024 * 1024);
  });
});
