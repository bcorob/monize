import { NotFoundException } from "@nestjs/common";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import type { EmailReceiptMailboxService } from "../mailbox/email-receipt-mailbox.service";
import type { EmailReceiptMailboxView } from "../mailbox/email-receipt-mailbox.view";
import type { EmailReceiptPollService } from "../poll/email-receipt-poll.service";
import {
  deriveImportedUid,
  EmailReceiptImportService,
  IMPORTED_UID_VALIDITY,
  MAX_IMPORT_MESSAGES,
} from "./email-receipt-import.service";

import { strToU8, zipSync } from "fflate";
import { readMsgAsRfc822 } from "./msg-message";

jest.mock("./msg-message", () => ({ readMsgAsRfc822: jest.fn() }));
jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";
const MAILBOX = "mb-1";

/** A synthetic order email; every name and address is made up. */
const eml = (messageId: string | null, subject = "Order confirmation") =>
  Buffer.from(
    [
      "From: Shop <orders@shop.example.com>",
      "To: buyer@example.net",
      `Subject: ${subject}`,
      "Date: Mon, 22 May 2023 06:49:17 +0000",
      ...(messageId ? [`Message-ID: ${messageId}`] : []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Order total: 15.00 PLN",
      "",
    ].join("\r\n"),
  );

function setup() {
  const { manager, dataSource } = createScopedDbMocks();
  manager.query.mockImplementation(async () => [{ id: "new" }]);
  const mailbox = {
    getView: jest.fn(
      async () => ({ id: MAILBOX }) as EmailReceiptMailboxView | null,
    ),
  } as unknown as jest.Mocked<EmailReceiptMailboxService>;
  const poll = {
    processStoredNow: jest.fn(async () => ({ processed: 2, busy: false })),
  } as unknown as jest.Mocked<EmailReceiptPollService>;
  const service = new EmailReceiptImportService(
    dataSource as never,
    mailbox,
    poll,
  );
  return { service, manager, dataSource, mailbox, poll };
}

const inserts = (manager: Record<string, jest.Mock>) =>
  manager.query.mock.calls.map((call) => call[1] as unknown[]);

describe("deriveImportedUid", () => {
  it("is stable, positive and below 2^63", () => {
    const uid = deriveImportedUid("<a@b.test>", Buffer.from("x"));
    expect(uid).toBe(deriveImportedUid("<a@b.test>", Buffer.from("other")));
    const value = BigInt(uid);
    expect(value >= 0n).toBe(true);
    expect(value < 1n << 63n).toBe(true);
  });

  it("ignores the case and the padding of a Message-ID", () => {
    expect(deriveImportedUid("  <A@B.test> ", Buffer.from("1"))).toBe(
      deriveImportedUid("<a@b.test>", Buffer.from("2")),
    );
  });

  it("hashes the bytes when there is no Message-ID", () => {
    const a = deriveImportedUid(null, Buffer.from("one"));
    expect(a).toBe(deriveImportedUid(null, Buffer.from("one")));
    expect(a).not.toBe(deriveImportedUid(null, Buffer.from("two")));
    expect(a).not.toBe(deriveImportedUid("", Buffer.from("two")));
  });
});

describe("importFiles", () => {
  it("stores an .eml under uid_validity 0 and then processes the stored rows", async () => {
    const h = setup();
    const result = await h.service.importFiles(USER, [
      { originalname: "order.eml", buffer: eml("<m1@shop.example.com>") },
    ]);

    expect(result).toEqual({
      files: [
        {
          name: "order.eml",
          format: "eml",
          messages: 1,
          stored: 1,
          duplicates: 0,
          skipped: 0,
          ignoredEntries: 0,
          error: null,
        },
      ],
      truncated: 0,
      processed: 2,
      busy: false,
    });
    const [params] = inserts(h.manager);
    expect(params.slice(0, 4)).toEqual([
      USER,
      MAILBOX,
      IMPORTED_UID_VALIDITY,
      deriveImportedUid("<m1@shop.example.com>", Buffer.alloc(0)),
    ]);
    expect(params[5]).toBe("orders@shop.example.com");
    expect(h.poll.processStoredNow).toHaveBeenCalledWith(USER);
    expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it("counts a row the insert refused as a duplicate", async () => {
    const h = setup();
    h.manager.query.mockResolvedValue([]);
    const result = await h.service.importFiles(USER, [
      { originalname: "order.eml", buffer: eml("<m1@x.test>") },
    ]);
    expect(result.files[0]).toMatchObject({
      stored: 0,
      duplicates: 1,
      messages: 1,
    });
  });

  it("splits an mbox, one transaction per file, using the separator date as fallback", async () => {
    const h = setup();
    const noDate = Buffer.from(
      "From: a@shop.example.com\nSubject: S\n\nbody\n",
    );
    const mbox = Buffer.concat([
      Buffer.from("From x@y Mon May 22 06:49:17 +0000 2023\n"),
      noDate,
      Buffer.from("\nFrom x@y Tue May 23 06:49:17 +0000 2023\n"),
      noDate.subarray(0, noDate.length - 6),
      Buffer.from("other\n"),
    ]);
    const result = await h.service.importFiles(USER, [
      { originalname: "all.mbox", buffer: mbox },
      { originalname: "two.eml", buffer: eml("<m2@x.test>") },
    ]);

    expect(result.files.map((f) => [f.format, f.messages, f.stored])).toEqual([
      ["mbox", 2, 2],
      ["eml", 1, 1],
    ]);
    expect(h.dataSource.transaction).toHaveBeenCalledTimes(2);
    const [first, second] = inserts(h.manager);
    expect((first[8] as Date).toISOString()).toBe("2023-05-22T06:49:17.000Z");
    expect((second[8] as Date).toISOString()).toBe("2023-05-23T06:49:17.000Z");
    expect(first[3]).not.toBe(second[3]);
  });

  it("stores a message above the size cap as skipped too_large without parsing it", async () => {
    const h = setup();
    const big = Buffer.concat([
      eml("<big@x.test>"),
      Buffer.alloc(2_000_001, 65),
    ]);
    const result = await h.service.importFiles(USER, [
      { originalname: "big.eml", buffer: big },
    ]);
    expect(result.files[0]).toMatchObject({ stored: 0, skipped: 1 });
    const [params] = inserts(h.manager);
    expect(params.slice(13)).toEqual(["skipped", "too_large"]);
    expect(params[4]).toBeNull();
  });

  it("reports a refused file by name and stores nothing for it", async () => {
    const h = setup();
    const result = await h.service.importFiles(USER, [
      {
        originalname: "Takeout\n\u0007.pst",
        buffer: Buffer.from("zz"),
      },
      { originalname: "empty.eml", buffer: Buffer.alloc(0) },
      { originalname: "n".repeat(400) + ".pst", buffer: Buffer.from("x") },
    ]);
    expect(result.files.map((f) => [f.format, f.error])).toEqual([
      [null, "unsupported_format"],
      [null, "empty"],
      [null, "unsupported_format"],
    ]);
    expect(result.files[0].name).toBe("Takeout .pst");
    expect(result.files[2].name).toHaveLength(255);
    expect(h.manager.query).not.toHaveBeenCalled();
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it("does not read more than the cap and says how many were left out", async () => {
    const h = setup();
    const one = "From a@x\nSubject: S\n\nbody\n";
    const mbox = Buffer.from(
      Array.from({ length: MAX_IMPORT_MESSAGES + 3 }, () => one).join("\n"),
    );
    const result = await h.service.importFiles(USER, [
      { originalname: "huge.mbox", buffer: mbox },
      { originalname: "late.eml", buffer: eml("<late@x.test>") },
    ]);
    expect(result.files[0].messages).toBe(MAX_IMPORT_MESSAGES);
    expect(result.files[1].messages).toBe(0);
    expect(result.truncated).toBe(3 + 1);
  });

  it("reports busy when the poll lease is held", async () => {
    const h = setup();
    h.poll.processStoredNow.mockResolvedValue({ processed: 0, busy: true });
    const result = await h.service.importFiles(USER, [
      { originalname: "order.eml", buffer: eml("<m1@x.test>") },
    ]);
    expect(result).toMatchObject({ processed: 0, busy: true });
    expect(result.files[0].stored).toBe(1);
  });

  it("stores the rows and does not process them with process: false", async () => {
    const h = setup();
    const result = await h.service.importFiles(
      USER,
      [{ originalname: "order.eml", buffer: eml("<m1@x.test>") }],
      { process: false },
    );
    expect(result).toMatchObject({ processed: 0, busy: false });
    expect(result.files[0].stored).toBe(1);
    expect(h.poll.processStoredNow).not.toHaveBeenCalled();
  });

  it("processes with process: true as by default", async () => {
    const h = setup();
    const result = await h.service.importFiles(
      USER,
      [{ originalname: "order.eml", buffer: eml("<m1@x.test>") }],
      { process: true },
    );
    expect(result).toMatchObject({ processed: 2, busy: false });
    expect(h.poll.processStoredNow).toHaveBeenCalledWith(USER);
  });

  it("is a 404 with no mailbox, before any file is read", async () => {
    const h = setup();
    h.mailbox.getView.mockResolvedValue(null);
    await expect(
      h.service.importFiles(USER, [
        { originalname: "order.eml", buffer: eml(null) },
      ]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.manager.query).not.toHaveBeenCalled();
    expect(h.poll.processStoredNow).not.toHaveBeenCalled();
  });

  describe("a .zip", () => {
    const zip = (files: Parameters<typeof zipSync>[0]) =>
      Buffer.from(zipSync(files));

    it("reads its mail entries as if uploaded one by one and counts the rest", async () => {
      const h = setup();
      const archive = zip({
        "Takeout/Mail/All.mbox": strToU8(
          `From x@y Mon May 22 06:49:17 +0000 2023\n${eml("<z1@x.test>").toString()}`,
        ),
        "orders/one.eml": eml("<z2@x.test>"),
        "archive_browser.html": strToU8("<p>"),
        "dir/": new Uint8Array(0),
      });
      const result = await h.service.importFiles(USER, [
        { originalname: "takeout.zip", buffer: archive },
      ]);
      expect(result.files).toEqual([
        {
          name: "takeout.zip",
          format: "zip",
          messages: 2,
          stored: 2,
          duplicates: 0,
          skipped: 0,
          ignoredEntries: 2,
          error: null,
        },
      ]);
      expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("reports a corrupt archive as invalid_archive and an expansion past the ceiling as archive_too_large", async () => {
      const h = setup();
      const bomb = zip({
        "a.mbox": strToU8(`From a@x\n\n${"A".repeat(110 * 1024 * 1024)}`),
      });
      const result = await h.service.importFiles(USER, [
        {
          originalname: "bad.zip",
          buffer: Buffer.concat([
            Buffer.from("PK\x03\x04"),
            Buffer.alloc(40, 255),
          ]),
        },
        { originalname: "bomb.zip", buffer: bomb },
      ]);
      expect(result.files.map((f) => [f.format, f.error, f.stored])).toEqual([
        ["zip", "invalid_archive", 0],
        ["zip", "archive_too_large", 0],
      ]);
    });

    it("stores a too-large eml entry as a skipped row keyed on its bytes", async () => {
      const h = setup();
      const big = Buffer.concat([
        eml("<big@x.test>"),
        Buffer.alloc(2_000_001, 65),
      ]);
      const result = await h.service.importFiles(USER, [
        { originalname: "a.zip", buffer: zip({ "big.eml": big }) },
      ]);
      expect(result.files[0]).toMatchObject({ skipped: 1, stored: 0 });
      const [params] = inserts(h.manager);
      expect(params[3]).toBe(deriveImportedUid(null, big));
      expect(params.slice(13)).toEqual(["skipped", "too_large"]);
    });

    it("says empty for an archive with nothing in it", async () => {
      const h = setup();
      const result = await h.service.importFiles(USER, [
        { originalname: "none.zip", buffer: zip({}) },
      ]);
      expect(result.files[0]).toMatchObject({ error: "empty", messages: 0 });
    });

    it("says empty for an mbox file with no message in it", async () => {
      const h = setup();
      const result = await h.service.importFiles(USER, [
        { originalname: "none.mbox", buffer: Buffer.from("\r\n\r\n") },
      ]);
      expect(result.files[0]).toMatchObject({
        format: "mbox",
        error: "empty",
        messages: 0,
      });
    });
  });

  describe("an Outlook .msg", () => {
    const msgBytes = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 9,
    ]);

    it("is rebuilt as RFC 5322 and stored through the same row builder", async () => {
      const h = setup();
      (readMsgAsRfc822 as jest.Mock).mockReturnValue(eml("<msg1@x.test>"));
      const result = await h.service.importFiles(USER, [
        { originalname: "order.msg", buffer: msgBytes },
      ]);
      expect(result.files[0]).toMatchObject({
        format: "msg",
        messages: 1,
        stored: 1,
      });
      const [params] = inserts(h.manager);
      expect(params[3]).toBe(deriveImportedUid("<msg1@x.test>", msgBytes));
      expect(params[5]).toBe("orders@shop.example.com");
    });

    it("stores a file msgreader cannot read as skipped undecodable, keyed on its bytes", async () => {
      const h = setup();
      (readMsgAsRfc822 as jest.Mock).mockReturnValue(null);
      const result = await h.service.importFiles(USER, [
        { originalname: "broken.msg", buffer: msgBytes },
      ]);
      expect(result.files[0]).toMatchObject({ skipped: 1, stored: 0 });
      const [params] = inserts(h.manager);
      expect(params[3]).toBe(deriveImportedUid(null, msgBytes));
      expect(params.slice(13)).toEqual(["skipped", "undecodable"]);
    });
  });
});
