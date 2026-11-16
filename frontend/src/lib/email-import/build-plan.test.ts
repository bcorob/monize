import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { buildUploadPlan } from "./build-plan";
import { PART_MAX_BYTES } from "./upload-plan";

function message(n: number): string {
  return `From s${n}@x Mon\nSubject: ${n}\n\nbody\n\n`;
}

/** An mbox a little over `bytes`, of messages of about `each` bytes. */
function bigMbox(bytes: number, each: number): string {
  const filler = "z".repeat(Math.max(0, each - message(1000).length));
  const parts: string[] = [];
  let size = 0;
  for (let n = 1000; size <= bytes; n++) {
    const m = `From s${n}@x Mon\nSubject: ${n}\n\n${filler}\n\n`;
    parts.push(m);
    size += m.length;
  }
  return parts.join("");
}

describe("buildUploadPlan", () => {
  it("sends small files as they are, whatever their type", async () => {
    const files = [
      new File(["x"], "a.eml"),
      new File(["y"], "b.pdf"),
      new File([message(1)], "c.mbox"),
    ];
    const plan = await buildUploadPlan(files);
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0].map((p) => p.file)).toEqual(files);
    expect(plan.notes).toEqual([]);
  });

  it("splits a large mbox and packs the parts", async () => {
    const text = bigMbox(PART_MAX_BYTES * 2 + 1000, 6 * 1024 * 1024);
    const plan = await buildUploadPlan([new File([text], "monize.mbox")]);
    const parts = plan.requests.flat();
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(
      parts.every(
        (p) => p.file.size <= PART_MAX_BYTES && p.origin === "monize.mbox",
      ),
    ).toBe(true);
    expect(parts.reduce((s, p) => s + p.file.size, 0)).toBe(text.length);
    expect(parts[0].file.name).toBe("monize-1.mbox");
    expect(plan.notes).toEqual([]);
  });

  it("splits a large extension-less file that starts with From", async () => {
    const text = bigMbox(PART_MAX_BYTES + 10, 5 * 1024 * 1024);
    const plan = await buildUploadPlan([new File([text], "mbox")]);
    expect(plan.requests.flat().length).toBeGreaterThan(1);
  });

  it("notes a single message above the part limit", async () => {
    const text =
      message(1) +
      bigMbox(PART_MAX_BYTES + 1, PART_MAX_BYTES + 10) +
      message(2);
    const plan = await buildUploadPlan([new File([text], "a.mbox")]);
    expect(plan.notes).toEqual([
      {
        origin: "a.mbox",
        ignoredEntries: 0,
        oversizedMessages: 1,
        error: null,
      },
    ]);
    expect(
      plan.requests.flat().reduce((s, p) => s + (p.messages ?? 0), 0),
    ).toBe(2);
  });

  it("notes a large eml, msg or unknown file as one message that is not sent", async () => {
    const big = new Uint8Array(PART_MAX_BYTES + 1);
    const plan = await buildUploadPlan([
      new File([big], "a.eml"),
      new File([big], "b.MSG"),
      new File([big], "c.bin"),
    ]);
    expect(plan.requests).toEqual([]);
    expect(plan.notes.map((n) => [n.origin, n.oversizedMessages])).toEqual([
      ["a.eml", 1],
      ["b.MSG", 1],
      ["c.bin", 1],
    ]);
  });

  it("reads a large zip locally and notes what it skipped", async () => {
    const mbox = strToU8(bigMbox(PART_MAX_BYTES + 100, 4 * 1024 * 1024));
    const zip = zipSync(
      { "t/a.mbox": mbox, "t/index.html": strToU8("<html>") },
      { level: 0 },
    );
    const plan = await buildUploadPlan([new File([zip], "takeout.zip")]);
    expect(plan.requests.flat().length).toBeGreaterThan(1);
    expect(plan.requests.flat().every((p) => p.origin === "takeout.zip")).toBe(
      true,
    );
    expect(plan.notes).toEqual([
      {
        origin: "takeout.zip",
        ignoredEntries: 1,
        oversizedMessages: 0,
        error: null,
      },
    ]);
  });

  it("notes a damaged large zip", async () => {
    const junk = new Uint8Array(PART_MAX_BYTES + 1);
    junk.set([0x50, 0x4b, 0x03, 0x04]);
    junk.fill(0xee, 4);
    const plan = await buildUploadPlan([new File([junk], "bad.zip")]);
    expect(plan.requests).toEqual([]);
    expect(plan.notes).toEqual([
      {
        origin: "bad.zip",
        ignoredEntries: 0,
        oversizedMessages: 0,
        error: "invalid_archive",
      },
    ]);
  });
});
