import MsgReader, { type FieldsData } from "@kenjiuno/msgreader";
import { burn } from "@kenjiuno/msgreader/lib/Burner";
import {
  buildRfc822FromMsg,
  cfbHeaderFits,
  readMsgAsRfc822,
  streamsFitFile,
} from "./msg-message";
import { extractMailText } from "../imap/mail-text.util";

/** The fields msgreader returns for a message; only what the builder reads. */
const fields = (over: Partial<FieldsData> = {}): FieldsData =>
  ({ dataType: "msg", ...over }) as FieldsData;

const build = (over: Partial<FieldsData>) =>
  buildRfc822FromMsg(fields(over)).toString("utf8");

describe("buildRfc822FromMsg", () => {
  it("ends the header block with an empty line before the first boundary", () => {
    const source = build({ body: "text", bodyHtml: "<p>html</p>" });
    expect(source).toMatch(
      /boundary="(monize-[0-9a-f]+)"\r\n\r\n--monize-[0-9a-f]+\r\n/,
    );
  });

  it("builds the headers from the properties when there are no transport headers", async () => {
    const source = buildRfc822FromMsg(
      fields({
        senderName: "Example Shop",
        senderEmail: "Orders@Shop.Example.com",
        subject: "Your order 123",
        clientSubmitTime: "Mon, 22 May 2023 06:49:17 GMT",
        messageId: "m1@shop.example.com",
        body: "Order total: 15.00 PLN",
      }),
    );
    const mail = await extractMailText(source);
    expect(mail).toMatchObject({
      fromAddress: "orders@shop.example.com",
      fromDomain: "shop.example.com",
      subject: "Your order 123",
      messageId: "<m1@shop.example.com>",
      html: null,
    });
    expect(mail.date?.toISOString()).toBe("2023-05-22T06:49:17.000Z");
    expect(mail.text).toContain("Order total: 15.00 PLN");
  });

  it("prefers the original transport headers, field by field", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          headers: [
            "Received: from mx.example.net",
            "From: Shop <orders@shop.example.com>",
            "Subject: Order with a very long",
            " folded subject",
            "Date: Tue, 23 May 2023 07:00:00 +0000",
            "Message-ID: <real@shop.example.com>",
            "Message-ID: <second@shop.example.com>",
            "",
            "Subject: not a header",
          ].join("\r\n"),
          senderEmail: "other@example.org",
          subject: "property subject",
          messageId: "prop-id",
          body: "hello",
        }),
      ),
    );
    expect(mail.fromAddress).toBe("orders@shop.example.com");
    expect(mail.subject).toBe("Order with a very long folded subject");
    expect(mail.messageId).toBe("<real@shop.example.com>");
    expect(mail.date?.toISOString()).toBe("2023-05-23T07:00:00.000Z");
  });

  it("falls back to a property for a header the transport block lacks", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          headers: "From: orders@shop.example.com\r\n",
          subject: "From the property",
          body: "x",
        }),
      ),
    );
    expect(mail.fromAddress).toBe("orders@shop.example.com");
    expect(mail.subject).toBe("From the property");
  });

  it("encodes non-ASCII text and keeps UTF-8 bodies intact", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          senderName: "Sklep Zażółć",
          senderEmail: "sklep@shop.example.com",
          subject: "Zamówienie nr 1: żółw",
          body: "Razem do zapłaty: 15,00 zł",
        }),
      ),
    );
    expect(mail.subject).toBe("Zamówienie nr 1: żółw");
    expect(mail.text).toContain("Razem do zapłaty: 15,00 zł");
    expect(mail.fromAddress).toBe("sklep@shop.example.com");
  });

  it("cannot be made to inject a header through a value", () => {
    const text = build({
      senderEmail: "a@shop.example.com>\r\nBcc: victim@example.net",
      senderName: 'Eve"\r\nX-Evil: 1',
      subject: "Hi\r\nBcc: victim@example.net",
      messageId: "id>\r\nX-Evil: 1",
      headers: "Subject: ok\r\n",
      body: "x",
    });
    const head = text.slice(0, text.indexOf("\r\n\r\n"));
    expect(head).not.toMatch(/^(Bcc|X-Evil):/im);
    for (const line of head.split("\r\n")) {
      expect(line).toMatch(/^[A-Za-z-]+: /);
    }
  });

  it("sends a plain and an HTML body as multipart/alternative", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          senderEmail: "a@shop.example.com",
          body: "plain text",
          bodyHtml: "<p>html <b>part</b></p>",
        }),
      ),
    );
    expect(mail.text).not.toBe("");
    expect(mail.html).toContain("<b>part</b>");
  });

  it("takes an HTML body given as bytes and builds a message from HTML alone", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          senderEmail: "a@shop.example.com",
          html: new TextEncoder().encode("<p>only html</p>"),
        }),
      ),
    );
    expect(mail.html).toContain("only html");
    expect(mail.text).toContain("only html");
  });

  it("builds a message with no body at all", async () => {
    const mail = await extractMailText(buildRfc822FromMsg(fields({})));
    expect(mail.text.trim()).toBe("");
  });

  it("is the same bytes for the same message", () => {
    const over = {
      senderEmail: "a@b.example.com",
      body: "t",
      bodyHtml: "<p>h",
    };
    expect(build(over)).toBe(build(over));
  });
});

describe("readMsgAsRfc822", () => {
  it("is null for bytes that are not an OLE file", () => {
    expect(
      readMsgAsRfc822(Buffer.from("From: a@b.example.com\n\nhi\n")),
    ).toBeNull();
    expect(readMsgAsRfc822(Buffer.alloc(0))).toBeNull();
  });

  it("is null for an OLE signature followed by garbage", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(600, 0x7f),
    ]);
    expect(readMsgAsRfc822(bytes)).toBeNull();
  });

  /** A real compound file: a synthetic message written by msgreader's own burner. */
  const BODY_STREAM = "__substg1.0_1000001F";
  // Each stream is padded to one big block: the burner's mini stream is not
  // what this test is about.
  const utf16Block = (text: string): Buffer => {
    const block = Buffer.alloc(4096);
    Buffer.from(text, "utf16le").copy(block);
    return block;
  };
  const doc = (name: string, data: Buffer) => ({
    name,
    type: 2,
    length: data.length,
    binaryProvider: () => data,
  });
  const realMsg = (): Buffer =>
    Buffer.from(
      burn([
        { name: "Root Entry", type: 5, length: 0, children: [1, 2, 3, 4] },
        doc("__substg1.0_0037001F", utf16Block("Order 42")),
        doc(BODY_STREAM, utf16Block("Total 10.00 PLN")),
        doc("__substg1.0_0C1F001F", utf16Block("orders@shop.example.com")),
        doc("__properties_version1.0", Buffer.alloc(32)),
      ]),
    );

  it("reads a real compound file through the same row builder", async () => {
    const source = readMsgAsRfc822(realMsg());
    expect(source).not.toBeNull();
    const mail = await extractMailText(source as Buffer);
    expect(mail).toMatchObject({
      fromDomain: "shop.example.com",
      subject: "Order 42",
    });
    expect(mail.text).toContain("Total 10.00 PLN");
  });

  it("refuses a directory entry declaring a stream larger than the file, before reading it", () => {
    const bytes = realMsg();
    const entry = bytes.indexOf(Buffer.from(BODY_STREAM, "utf16le"));
    expect(entry).toBeGreaterThan(0);
    // [MS-CFB] 2.6.1: the stream size is at offset 0x78 of a directory entry.
    bytes.writeUInt32LE(0x7fffffff, entry + 0x78);
    // msgreader would allocate the declared 2 GB before it noticed the chain
    // ends, so the refusal must come before it reads any stream.
    const read = jest.spyOn(MsgReader.prototype, "getFileData");
    try {
      expect(readMsgAsRfc822(bytes)).toBeNull();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it("refuses a header whose DIFAT count passes the sectors in the file", () => {
    const bytes = realMsg();
    bytes.writeUInt32LE(0xffffffff, 0x48);
    expect(cfbHeaderFits(bytes)).toBe(false);
    expect(readMsgAsRfc822(bytes)).toBeNull();
  });

  it("keeps msgreader's internal reader where the structure check reads it", () => {
    const bytes = realMsg();
    expect(cfbHeaderFits(bytes)).toBe(true);
    const reader = (
      new MsgReader(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      ) as unknown as {
        reader: { parse(): void; propertyData: unknown };
      }
    ).reader;
    reader.parse();
    expect(Array.isArray(reader.propertyData)).toBe(true);
  });
});

describe("cfbHeaderFits", () => {
  const header = (shift: number, counts: number[] = [1, 0, 0]) => {
    const bytes = Buffer.alloc(4096);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(bytes);
    bytes.writeUInt16LE(shift, 0x1e);
    [0x2c, 0x40, 0x48].forEach((offset, index) =>
      bytes.writeUInt32LE(counts[index], offset),
    );
    return bytes;
  };

  it("accepts 512- and 4096-byte sectors with counts the file can hold", () => {
    expect(cfbHeaderFits(header(9, [8, 8, 8]))).toBe(true);
    expect(cfbHeaderFits(header(12, [1, 1, 1]))).toBe(true);
  });

  it("refuses an unknown sector size, a count past the file, a short or foreign file", () => {
    expect(cfbHeaderFits(header(10))).toBe(false);
    expect(cfbHeaderFits(header(9, [9, 0, 0]))).toBe(false);
    expect(cfbHeaderFits(header(12, [0, 2, 0]))).toBe(false);
    expect(cfbHeaderFits(header(9).subarray(0, 511))).toBe(false);
    expect(cfbHeaderFits(Buffer.alloc(4096))).toBe(false);
  });
});

describe("streamsFitFile", () => {
  it("accepts sizes from zero to the file length", () => {
    expect(streamsFitFile([{ sizeBlock: 0 }, { sizeBlock: 100 }], 100)).toBe(
      true,
    );
  });

  it("refuses sizes that each fit but together pass twice the file", () => {
    expect(streamsFitFile([{ sizeBlock: 100 }, { sizeBlock: 100 }], 100)).toBe(
      true,
    );
    expect(
      streamsFitFile(
        [{ sizeBlock: 100 }, { sizeBlock: 100 }, { sizeBlock: 1 }],
        100,
      ),
    ).toBe(false);
  });

  it.each([101, -1, 1.5, "5", undefined])(
    "refuses a declared size of %p in a 100-byte file",
    (sizeBlock) => {
      expect(streamsFitFile([{ sizeBlock }], 100)).toBe(false);
    },
  );
});
