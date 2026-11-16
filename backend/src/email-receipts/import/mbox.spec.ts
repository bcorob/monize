import { detectArchiveFormat, splitMbox } from "./mbox";

const buf = (text: string) => Buffer.from(text, "latin1");
const text = (b: Buffer) => b.toString("latin1");

const MSG_A = "Subject: A\nMessage-ID: <a@shop.test>\n\nbody a\n";
const MSG_B = "Subject: B\n\nbody b\n";

describe("detectArchiveFormat", () => {
  const eml = buf("From: shop@shop.test\nSubject: Order\n\nhi\n");
  const mbox = buf(
    "From sender@x Mon May 22 06:49:17 +0000 2023\nSubject: A\n\nhi\n",
  );

  it("refuses an empty file first", () => {
    expect(detectArchiveFormat("a.eml", Buffer.alloc(0))).toEqual({
      error: "empty",
    });
  });

  it("reads zip by name or magic", () => {
    expect(detectArchiveFormat("takeout.ZIP", eml)).toBe("zip");
    expect(
      detectArchiveFormat("x", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1])),
    ).toBe("zip");
  });

  it("reads msg by name or the full OLE signature", () => {
    expect(detectArchiveFormat("a.msg", eml)).toBe("msg");
    expect(
      detectArchiveFormat(
        "x",
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
      ),
    ).toBe("msg");
  });

  it("refuses pst", () => {
    expect(detectArchiveFormat("a.pst", eml)).toEqual({
      error: "unsupported_format",
    });
  });

  it("reads mbox by extension or by a leading From line", () => {
    expect(detectArchiveFormat("a.mbox", eml)).toBe("mbox");
    expect(detectArchiveFormat("a.mbx", eml)).toBe("mbox");
    expect(detectArchiveFormat("mbox", mbox)).toBe("mbox");
    expect(detectArchiveFormat("x.bin", buf("\n\n" + text(mbox)))).toBe("mbox");
  });

  it("reads eml by extension or by a header block", () => {
    expect(detectArchiveFormat("a.eml", buf("anything"))).toBe("eml");
    expect(detectArchiveFormat("message", eml)).toBe("eml");
  });

  it("refuses text that is neither", () => {
    expect(detectArchiveFormat("notes.txt", buf("hello world\n"))).toEqual({
      error: "unsupported_format",
    });
  });
});

describe("splitMbox", () => {
  it("splits on From lines after a blank line and strips the separator", () => {
    const file = `From a@x Mon May 22 06:49:17 +0000 2023\n${MSG_A}\nFrom b@x Tue May 23 07:00:00 +0000 2023\n${MSG_B}`;
    const { messages, truncated } = splitMbox(buf(file), 10);
    expect(truncated).toBe(0);
    expect(messages.map((m) => text(m.source))).toEqual([MSG_A, MSG_B]);
  });

  it("does not split on a From line that follows text", () => {
    const body = "Subject: A\n\nline\nFrom here on it is a story\nend\n";
    const { messages } = splitMbox(buf(`From a@x\n${body}`), 10);
    expect(messages).toHaveLength(1);
    expect(text(messages[0].source)).toBe(body);
  });

  it("unescapes mboxrd lines, one > each", () => {
    const file =
      "From a@x\nSubject: A\n\n>From me\n>>From you\n> From no\nend\n";
    const { messages } = splitMbox(buf(file), 10);
    expect(text(messages[0].source)).toBe(
      "Subject: A\n\nFrom me\n>From you\n> From no\nend\n",
    );
  });

  it("reads CRLF files and keeps the line endings of the message", () => {
    const file =
      "From a@x\r\nSubject: A\r\n\r\nbody\r\n\r\nFrom b@x\r\nSubject: B\r\n\r\nb\r\n";
    const { messages } = splitMbox(buf(file), 10);
    expect(messages.map((m) => text(m.source))).toEqual([
      "Subject: A\r\n\r\nbody\r\n",
      "Subject: B\r\n\r\nb\r\n",
    ]);
  });

  it("reads a last message with no trailing newline", () => {
    const { messages } = splitMbox(buf("From a@x\nSubject: A\n\nbody"), 10);
    expect(text(messages[0].source)).toBe("Subject: A\n\nbody");
  });

  it("ignores text before the first separator and skips empty messages", () => {
    const file = `junk\n\nFrom a@x\n\n\nFrom b@x\n${MSG_B}`;
    const { messages } = splitMbox(buf(file), 10);
    expect(messages.map((m) => text(m.source))).toEqual([MSG_B]);
  });

  it("builds at most maxMessages and counts the rest", () => {
    const file = [1, 2, 3, 4]
      .map((n) => `From s${n}@x\nSubject: ${n}\n\nb\n`)
      .join("\n");
    const { messages, truncated } = splitMbox(buf(file), 2);
    expect(messages).toHaveLength(2);
    expect(truncated).toBe(2);
    expect(splitMbox(buf(file), 0)).toEqual({ messages: [], truncated: 4 });
  });

  it("reads the separator date with a zone, without one, or not at all", () => {
    const file = [
      "From a@x Mon May 22 06:49:17 +0200 2023\nSubject: 1\n\nb\n",
      "From b@x Mon May 22 06:49:17 2023\nSubject: 2\n\nb\n",
      "From c@x\nSubject: 3\n\nb\n",
      "From d@x Mon Foo 99 99:99:99 2023\nSubject: 4\n\nb\n",
    ].join("\n");
    const { messages } = splitMbox(buf(file), 10);
    expect(messages.map((m) => m.separatorDate?.toISOString() ?? null)).toEqual(
      ["2023-05-22T04:49:17.000Z", "2023-05-22T06:49:17.000Z", null, null],
    );
  });

  it("returns nothing for a file with no separator", () => {
    expect(splitMbox(buf("Subject: A\n\nb\n"), 10)).toEqual({
      messages: [],
      truncated: 0,
    });
  });
});
