import { describe, it, expect } from "vitest";
import { MboxStreamSplitter } from "./mbox-stream-split";

const enc = new TextEncoder();

function message(n: number, bodyBytes = 0): string {
  return `From s${n}@x Mon\nSubject: ${n}\n\n${"b".repeat(bodyBytes)}\n\n`;
}

async function run(
  text: string,
  chunkBytes: number,
  limits: { maxPartBytes?: number; maxMessages?: number } = {},
) {
  const parts: Array<{ name: string; text: string; messages: number }> = [];
  const pending: Array<{ file: File; messages: number }> = [];
  const splitter = new MboxStreamSplitter({
    stem: "e",
    onPart: (file, messages) => pending.push({ file, messages }),
    ...limits,
  });
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += chunkBytes)
    splitter.push(bytes.slice(i, i + chunkBytes));
  splitter.finish();
  for (const p of pending)
    parts.push({
      name: p.file.name,
      text: await p.file.text(),
      messages: p.messages,
    });
  return { parts, oversized: splitter.oversized };
}

describe("MboxStreamSplitter", () => {
  it("emits one part for a small mbox", async () => {
    const text = message(1) + message(2);
    const { parts, oversized } = await run(text, 1000);
    expect(oversized).toBe(0);
    expect(parts).toEqual([{ name: "e-1.mbox", text, messages: 2 }]);
  });

  it("cuts at the last separator inside the limit, with the same bytes in order", async () => {
    const msgs = [1, 2, 3, 4, 5].map((n) => message(n, 20));
    const size = msgs[0].length;
    const { parts, oversized } = await run(msgs.join(""), 7, {
      maxPartBytes: size * 2 + 3,
    });
    expect(oversized).toBe(0);
    expect(parts.map((p) => p.messages)).toEqual([2, 2, 1]);
    expect(parts.map((p) => p.name)).toEqual([
      "e-1.mbox",
      "e-2.mbox",
      "e-3.mbox",
    ]);
    expect(parts.map((p) => p.text).join("")).toBe(msgs.join(""));
    for (const p of parts) expect(p.text.startsWith("From s")).toBe(true);
  });

  it.each([1, 3, 5, 11, 64])(
    "gives the same parts for %i byte chunks",
    async (chunk) => {
      const msgs = [1, 2, 3, 4].map((n) => message(n, 30));
      const text = "junk\n\n" + msgs.join("");
      const reference = await run(text, 100000, {
        maxPartBytes: msgs[0].length * 2,
      });
      const parts = await run(text, chunk, {
        maxPartBytes: msgs[0].length * 2,
      });
      expect(parts).toEqual(reference);
      expect(parts.parts.map((p) => p.messages)).toEqual([2, 2]);
    },
  );

  it("splits CRLF text and keeps a separator cut across chunks", async () => {
    const m = (n: number) =>
      `From s${n}\r\nSubject: ${n}\r\n\r\nbody body\r\n\r\n`;
    const text = m(1) + m(2) + m(3);
    const { parts } = await run(text, 2, { maxPartBytes: m(1).length + 2 });
    expect(parts.map((p) => p.messages)).toEqual([1, 1, 1]);
    expect(parts.map((p) => p.text).join("")).toBe(text);
  });

  it("drops text before the first separator", async () => {
    const { parts } = await run("leading\n\n" + message(1), 4);
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe(message(1));
  });

  it("drops a message above the limit, counts it, and keeps its neighbours", async () => {
    const small = message(1, 5);
    const big = message(2, 500);
    const text = small + big + small + small;
    const { parts, oversized } = await run(text, 9, {
      maxPartBytes: small.length * 2 + 4,
    });
    expect(oversized).toBe(1);
    expect(parts.map((p) => p.text).join("")).toBe(small + small + small);
    expect(parts.map((p) => p.messages)).toEqual([1, 2]);
  });

  it("counts an oversized last message once", async () => {
    const { parts, oversized } = await run(
      message(1, 5) + message(2, 500),
      13,
      { maxPartBytes: 60 },
    );
    expect(oversized).toBe(1);
    expect(parts.map((p) => p.messages)).toEqual([1]);
  });

  it("counts an oversized only message once and emits nothing", async () => {
    const { parts, oversized } = await run(message(1, 500), 50, {
      maxPartBytes: 100,
    });
    expect(oversized).toBe(1);
    expect(parts).toEqual([]);
  });

  it("closes a part at the message cap", async () => {
    const text = [1, 2, 3, 4, 5].map((n) => message(n)).join("");
    const { parts } = await run(text, 6, { maxMessages: 2 });
    expect(parts.map((p) => p.messages)).toEqual([2, 2, 1]);
    expect(parts.map((p) => p.text).join("")).toBe(text);
  });

  it("emits nothing for text without a separator, and holds little of it", async () => {
    const { parts, oversized } = await run(
      "no separator here\n".repeat(100),
      10,
    );
    expect(parts).toEqual([]);
    expect(oversized).toBe(0);
  });

  it("holds about one part of bytes while a large stream passes", async () => {
    const emitted: number[] = [];
    const splitter = new MboxStreamSplitter({
      stem: "e",
      maxPartBytes: 1000,
      onPart: (file) => emitted.push(file.size),
    });
    const m = enc.encode(message(1, 80));
    for (let i = 0; i < 500; i++) splitter.push(m.slice());
    splitter.finish();
    expect(emitted.every((size) => size <= 1000)).toBe(true);
    expect(emitted.reduce((a, b) => a + b, 0)).toBe(m.length * 500);
    // @ts-expect-error reading a private field to pin the memory bound
    const held = (splitter.chunks as Uint8Array[]).reduce(
      (s, c) => s + c.length,
      0,
    );
    expect(held).toBeLessThanOrEqual(8);
  });
});
