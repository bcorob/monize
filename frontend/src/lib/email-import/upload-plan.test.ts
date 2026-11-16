import { describe, it, expect } from "vitest";
import {
  PART_MAX_BYTES,
  REQUEST_MAX_BYTES,
  REQUEST_MAX_MESSAGES,
  REQUEST_MAX_PARTS,
  SELECTION_MAX_BYTES,
  mboxPartName,
  nameStem,
  packRequests,
  planMbox,
  planParts,
  selectionExceedsLimit,
  type UploadPart,
} from "./upload-plan";

/** A Blob of `size` bytes (zeros are fine: the planner reads offsets, not content). */
const bytes = (size: number) => new Blob([new Uint8Array(size)]);

function fakePart(
  size: number,
  messages: number | null,
  origin = "o",
): UploadPart {
  const file = new File(["x"], `${origin}.eml`);
  Object.defineProperty(file, "size", { value: size });
  return { file, origin, messages };
}

describe("constants", () => {
  it("stay under the server's limits", () => {
    expect(PART_MAX_BYTES).toBe(24 * 1024 * 1024);
    expect(PART_MAX_BYTES).toBeLessThan(25 * 1024 * 1024);
    expect(REQUEST_MAX_BYTES).toBe(24 * 1024 * 1024);
    expect(REQUEST_MAX_PARTS).toBe(20);
    expect(REQUEST_MAX_MESSAGES).toBe(5000);
    expect(SELECTION_MAX_BYTES).toBe(1024 * 1024 * 1024);
  });
});

describe("selectionExceedsLimit", () => {
  it("accepts exactly 1 GiB and refuses one byte more", () => {
    expect(selectionExceedsLimit([{ size: SELECTION_MAX_BYTES }])).toBe(false);
    expect(
      selectionExceedsLimit([{ size: SELECTION_MAX_BYTES - 1 }, { size: 2 }]),
    ).toBe(true);
  });
});

describe("names", () => {
  it("derives the stem and the part name", () => {
    expect(nameStem("monize.mbox")).toBe("monize");
    expect(nameStem("dir/All mail.mbox")).toBe("All mail");
    expect(nameStem("mbox")).toBe("mbox");
    expect(mboxPartName("monize", 3)).toBe("monize-3.mbox");
  });
});

describe("planMbox", () => {
  const MB = 1024 * 1024;

  it("groups consecutive whole messages below the part limit", async () => {
    // 6 messages of 10 MiB: two per part (3 would be 30 MiB).
    const starts = Array.from({ length: 6 }, (_, i) => i * 10 * MB);
    const { parts, oversized } = planMbox(
      "monize.mbox",
      bytes(60 * MB),
      starts,
    );
    expect(oversized).toBe(0);
    expect(
      parts.map((p) => [p.file.name, p.file.size, p.messages, p.origin]),
    ).toEqual([
      ["monize-1.mbox", 20 * MB, 2, "monize.mbox"],
      ["monize-2.mbox", 20 * MB, 2, "monize.mbox"],
      ["monize-3.mbox", 20 * MB, 2, "monize.mbox"],
    ]);
  });

  it("puts a part at exactly the limit together and starts a new one one byte over", () => {
    const half = PART_MAX_BYTES / 2;
    const exact = planMbox("a.mbox", bytes(PART_MAX_BYTES), [0, half]);
    expect(exact.parts).toHaveLength(1);
    expect(exact.parts[0].file.size).toBe(PART_MAX_BYTES);
    const over = planMbox("a.mbox", bytes(PART_MAX_BYTES + 1), [0, half]);
    expect(over.parts.map((p) => p.file.size)).toEqual([half, half + 1]);
  });

  it("leaves out a message above the limit, counts it, and does not join across it", () => {
    const MBs = 1024 * 1024;
    const big = PART_MAX_BYTES + 1;
    const starts = [0, MBs, MBs + big, 2 * MBs + big];
    const { parts, oversized } = planMbox(
      "a.mbox",
      bytes(3 * MBs + big),
      starts,
    );
    expect(oversized).toBe(1);
    expect(parts.map((p) => [p.file.size, p.messages])).toEqual([
      [MBs, 1],
      [2 * MBs, 2],
    ]);
  });

  it("accepts a message of exactly the limit", () => {
    const { parts, oversized } = planMbox("a.mbox", bytes(PART_MAX_BYTES), [0]);
    expect(oversized).toBe(0);
    expect(parts).toHaveLength(1);
  });

  it("counts a message of one byte over the limit as not sent", () => {
    const { parts, oversized } = planMbox(
      "a.mbox",
      bytes(PART_MAX_BYTES + 1),
      [0],
    );
    expect(oversized).toBe(1);
    expect(parts).toHaveLength(0);
  });

  it("closes a part at the message cap of a request", () => {
    const starts = Array.from(
      { length: REQUEST_MAX_MESSAGES + 1 },
      (_, i) => i * 2,
    );
    const { parts } = planMbox("a.mbox", bytes(starts.length * 2), starts);
    expect(parts.map((p) => p.messages)).toEqual([REQUEST_MAX_MESSAGES, 1]);
  });

  it("leaves out the text before the first separator", () => {
    const { parts } = planMbox("a.mbox", bytes(30), [10, 20]);
    expect(parts).toHaveLength(1);
    expect(parts[0].file.size).toBe(20);
    expect(parts[0].messages).toBe(2);
  });

  it("slices the blob content without change", async () => {
    const text = "From a\n\nbody\n\nFrom b\n\nbody2\n";
    const second = text.indexOf("From b");
    const { parts } = planMbox("a.mbox", new Blob([text]), [0, second]);
    expect(await parts[0].file.text()).toBe(text);
  });

  it("counts a file with no separator as one message that cannot be sent", () => {
    expect(planMbox("a.mbox", bytes(10), [])).toEqual({
      parts: [],
      oversized: 1,
    });
    expect(planMbox("a.mbox", bytes(0), [])).toEqual({
      parts: [],
      oversized: 0,
    });
  });
});

describe("planParts", () => {
  it("keeps files as they are and sums oversized messages per origin", () => {
    const eml = new File(["x"], "m.eml");
    const planned = planParts([
      { kind: "file", file: eml },
      {
        kind: "mbox",
        name: "big.mbox",
        blob: bytes(PART_MAX_BYTES + 5),
        starts: [0],
      },
      { kind: "mbox", name: "ok.mbox", blob: bytes(10), starts: [0] },
    ]);
    expect(
      planned.parts.map((p) => [p.file.name, p.origin, p.messages]),
    ).toEqual([
      ["m.eml", "m.eml", null],
      ["ok-1.mbox", "ok.mbox", 1],
    ]);
    expect(planned.parts[0].file).toBe(eml);
    expect(planned.oversizedMessages).toEqual([
      { origin: "big.mbox", count: 1 },
    ]);
  });
});

describe("packRequests", () => {
  it("returns no request for no parts", () => {
    expect(packRequests([])).toEqual([]);
  });

  it("holds at most 20 parts per request", () => {
    const parts = Array.from({ length: 41 }, () => fakePart(10, null));
    expect(packRequests(parts).map((r) => r.length)).toEqual([20, 20, 1]);
  });

  it("holds at most 24 MiB per request, at exactly the limit", () => {
    const MB = 1024 * 1024;
    const full = [fakePart(24 * MB, 1), fakePart(24 * MB, 1)];
    expect(packRequests(full).map((r) => r.length)).toEqual([1, 1]);
    const halves = [fakePart(12 * MB, 1), fakePart(12 * MB, 1)];
    expect(packRequests(halves).map((r) => r.length)).toEqual([2]);
    const over = [...halves, fakePart(1, 1)];
    expect(packRequests(over).map((r) => r.length)).toEqual([2, 1]);
  });

  it("holds at most 5,000 known messages per request and counts an unknown count as one", () => {
    const parts = [
      fakePart(10, REQUEST_MAX_MESSAGES - 1),
      fakePart(10, null),
      fakePart(10, null),
      fakePart(10, 2),
    ];
    expect(packRequests(parts).map((r) => r.length)).toEqual([2, 2]);
  });

  it("keeps the order of the parts", () => {
    const parts = Array.from({ length: 25 }, (_, i) =>
      fakePart(10, null, `p${i}`),
    );
    expect(
      packRequests(parts)
        .flat()
        .map((p) => p.origin),
    ).toEqual(parts.map((p) => p.origin));
  });
});
